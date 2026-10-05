/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ApplicationStreamingStore, ChannelStore, SelectedChannelStore, UserStore } from "@webpack/common";

import {
    brokerEnsure,
    brokerIdleCheck,
    brokerIsConnected,
    brokerOpen,
    brokerSetChannel,
    brokerShutdown,
    setBrokerMessageHandler
} from "./broker";
import type { P2PSourceInfo } from "./capture";
import { type NativeAudioHandle,startNativeAudio } from "./nativeAudio";
import { AUTO_CODEC_ORDER, settings } from "./settings";
import {
    handleOwnEcho,
    isSignalContent,
    parseSignals,
    pruneFragments,
    sendSignals,
    setCleanupEnabledGetter,
    type Signal,
    signalingHealth
} from "./signaling";
import { myId, PLUGIN_VERSION, randomId, toast, versionAtLeast } from "./utils";

const logger = new Logger("P2PStream:Engine");

export interface StreamMeta {
    res?: string;
    fps?: number;
    bitrate?: number;
    codec?: string;
}

export interface LiveHost {
    streamId: string;
    userId: string;
    name: string;
    channelId: string;
    lastSeen: number;
    meta: StreamMeta;
    /** версия плагина хоста (если передана в анонсе) */
    hostVersion?: string;
    /** транспорт, с которого пришёл анонс: "broker" | "chat" — по нему
     *  зритель выбирает маршрут join (совместимость со старыми версиями) */
    via?: "broker" | "chat";
}

export type WatchState = "connecting" | "live" | "reconnecting" | "ended" | "failed";

export const MAX_VIEWERS = 5;
const HEARTBEAT_MS = 8000;
const HOST_TIMEOUT_MS = 22_000;

function currentVoiceChannelId(): string | null {
    try {
        return SelectedChannelStore.getVoiceChannelId?.() ?? null;
    } catch {
        return null;
    }
}

function currentVoiceGuildId(): string | null {
    const channelId = currentVoiceChannelId();
    if (!channelId) return null;
    try {
        const channel: any = ChannelStore.getChannel?.(channelId);
        const gid = channel?.getGuildId?.() ?? channel?.guild_id ?? null;
        return gid != null && gid !== "" ? String(gid) : null;
    } catch {
        return null;
    }
}

export function codecLabel(codec: string): string {
    switch (codec) {
        case "h264": return "H.264";
        case "vp9": return "VP9";
        case "av1": return "AV1";
        default: return "Авто";
    }
}

export function currentMeta(): StreamMeta {
    const res = String(settings.store.resolution);
    return {
        res: res === "native" ? "нативное" : `${res}p`,
        fps: Number(settings.store.fps) || 60,
        bitrate: Number(settings.store.videoBitrate) || 25,
        codec: codecLabel(String(settings.store.codec))
    };
}

// region RTC helpers

function buildRtcConfig(): RTCConfiguration {
    const iceServers: RTCIceServer[] = [];
    const stuns = String(settings.store.stunServers ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    // сохранённые настройки не получают новые дефолты (у пользователя остался
    // только Google-STUN) — Cloudflare добавляем всегда, если его нет:
    // второй независимый STUN заметно повышает шанс получить srflx-кандидатов
    if (!stuns.some(s => /cloudflare/i.test(s))) stuns.push("stun:stun.cloudflare.com:3478");
    for (const urls of stuns) iceServers.push({ urls });

    const turnUrl = String(settings.store.turnUrl ?? "").trim();
    if (turnUrl) {
        iceServers.push({
            urls: turnUrl,
            username: String(settings.store.turnUser ?? ""),
            credential: String(settings.store.turnPassword ?? "")
        });
    } else if (settings.store.emergencyTurn !== false) {
        // Аварийный публичный ретранслятор: спасает при симметричном NAT/CGNAT,
        // когда прямые кандидаты не совпадаются (частая причина «стрим не грузит»).
        // ICE сам предпочитает прямые пути — TURN используется только как последний вариант.
        iceServers.push({
            urls: [
                "turn:openrelay.metered.ca:80",
                "turn:openrelay.metered.ca:443?transport=udp",
                "turn:openrelay.metered.ca:443?transport=tcp"
            ],
            username: "openrelayproject",
            credential: "openrelayproject"
        });
    }

    return {
        iceServers,
        bundlePolicy: "max-bundle",
        iceCandidatePoolSize: 2
    };
}

/** Выставить предпочтительный видеокодек. В режиме «Авто» просто поднимает
 *  лёгкие кодеки в начало списка, сохраняя все остальные (безопасно). */
function applyVideoCodecPreference(pc: RTCPeerConnection, codec: string): void {
    try {
        const caps = RTCRtpSender.getCapabilities?.("video");
        if (!caps?.codecs?.length) return;

        const order = codec === "auto" ? AUTO_CODEC_ORDER : [codec];
        const chosen: any[] = [];
        const rest: any[] = [];

        for (const c of caps.codecs) {
            const mime = c.mimeType.toLowerCase();
            const isPreferred = order.some(want => mime === `video/${want}`);
            const isAux = /rtx|red|ulpfec|flexfec/i.test(mime);
            if (codec === "auto") {
                (isPreferred ? chosen : rest).push(c);
            } else if (isPreferred || isAux) {
                chosen.push(c);
            }
        }

        const list = (codec === "auto" ? [...chosen, ...rest] : chosen) as RTCRtpCodec[];
        if (!list.length) return;

        for (const t of pc.getTransceivers()) {
            const kind = t.sender.track?.kind ?? t.receiver.track?.kind;
            if (kind === "video") {
                try { t.setCodecPreferences(list); } catch { /* ignore */ }
            }
        }
    } catch (e) {
        logger.debug("setCodecPreferences не удался:", e);
    }
}

/** SDP-мунж: стерео Opus + максимальная полоса для музыки/звука без потерь */
function mungeOpusStereo(sdp: string): string {
    try {
        const lines = sdp.split("\r\n");
        const opusPts = new Set<string>();
        for (const line of lines) {
            const m = line.match(/^a=rtpmap:(\d+)\sopus\/48000/i);
            if (m) opusPts.add(m[1]);
        }
        if (!opusPts.size) return sdp;

        let inAudio = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith("m=")) inAudio = lines[i].startsWith("m=audio");
            if (!inAudio) continue;
            const fm = lines[i].match(/^a=fmtp:(\d+)\s(.+)$/);
            if (fm && opusPts.has(fm[1]) && !fm[2].includes("stereo=1")) {
                lines[i] = `a=fmtp:${fm[1]} ${fm[2]};stereo=1;sprop-stereo=1;maxaveragebandwidth=510000`;
            }
        }
        return lines.join("\r\n");
    } catch {
        return sdp;
    }
}

export function buildDisplayConstraints(): DisplayMediaStreamOptions {
    const fps = Number(settings.store.fps) || 60;
    const res = String(settings.store.resolution);
    const video: MediaTrackConstraints = { frameRate: fps };
    if (res !== "native") video.height = Number(res);

    // «native»: просим и системный звук — он станет фолбэком, если нативный
    // per-app звук недоступен; движок заменит его при успехе
    const mode = String(settings.store.audioMode);
    const audio = mode === "off"
        ? false
        : mode === "system"
            ? { restrictOwnAudio: true } as MediaTrackConstraints
            : true;

    return {
        video,
        audio,
        systemAudio: "include",
        surfaceSwitching: "include",
        selfBrowserSurface: "exclude",
        monitorTypeSurfaces: "include"
    } as DisplayMediaStreamOptions;
}

/** Живое применение качества к захваченному видеотреку (можно менять на лету: профиль Игры/Кино и т.д.) */
export async function applyCaptureConstraints(track: MediaStreamTrack): Promise<void> {
    const fps = Number(settings.store.fps) || 60;
    const res = String(settings.store.resolution);
    const constraints: MediaTrackConstraints = {
        frameRate: { ideal: fps, max: 480 }
    };
    if (res !== "native") constraints.height = { ideal: Number(res) };
    try {
        await track.applyConstraints(constraints);
    } catch (e) {
        logger.debug("applyConstraints не удался:", e);
    }
}

/** Применить битрейт/FPS к видеосендеру (можно вызывать на живую) */
async function applySendParameters(pc: RTCPeerConnection): Promise<void> {
    const wantFps = Number(settings.store.fps) || 60;
    const wantVideoBps = Math.round(Number(settings.store.videoBitrate) * 1_000_000);
    const wantAudioBps = Math.round(Number(settings.store.audioBitrate) * 1000);
    const hint = String(settings.store.contentHint) === "detail" ? "maintain-resolution" : "maintain-framerate";

    for (const sender of pc.getSenders()) {
        try {
            if (sender.track?.kind === "video") {
                const params = sender.getParameters();
                params.degradationPreference = hint as RTCDegradationPreference;
                if (!params.encodings?.length) params.encodings = [{}];
                params.encodings[0].maxBitrate = wantVideoBps;
                params.encodings[0].maxFramerate = wantFps;
                params.encodings[0].scaleResolutionDownBy = 1;
                params.encodings[0].networkPriority = "high";
                params.encodings[0].priority = "high";
                await sender.setParameters(params);
            } else if (sender.track?.kind === "audio") {
                const params = sender.getParameters();
                if (!params.encodings?.length) params.encodings = [{}];
                params.encodings[0].maxBitrate = wantAudioBps;
                params.encodings[0].networkPriority = "high";
                await sender.setParameters(params);
            }
        } catch (e) {
            logger.debug("setParameters не удался:", e);
        }
    }
}

/** Диагностика ICE: сколько внешних кандидатов собрали — сразу видно, пробивается ли NAT */
function logIceSummary(pc: RTCPeerConnection, label: string): void {
    try {
        const sdp = pc.localDescription?.sdp ?? "";
        const srflx = (sdp.match(/typ srflx/g) ?? []).length;
        const relay = (sdp.match(/typ relay/g) ?? []).length;
        const host_ = (sdp.match(/typ host/g) ?? []).length;
        logger.info(`ICE [${label}]: сбор завершён — host=${host_}, srflx=${srflx}, relay=${relay}`);
        if (!srflx && !relay) {
            logger.warn(`ICE [${label}]: внешних кандидатов нет — STUN недоступен или UDP заблокирован; между разными сетями без TURN соединения не будет`);
        }
    } catch { /* ignore */ }
}

/** Дождаться полного сбора ICE-кандидатов (но не дольше ms) — для non-trickle отправки */
function waitIceGathering(pc: RTCPeerConnection, ms: number): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", onChange);
            resolve();
        };
        const onChange = () => {
            if (pc.iceGatheringState === "complete") finish();
        };
        const timer = setTimeout(finish, ms);
        pc.addEventListener("icegatheringstatechange", onChange);
    });
}

function applyReceiveLatency(pc: RTCPeerConnection): void {
    const target = Number(settings.store.jitterBuffer) || 0;
    for (const receiver of pc.getReceivers()) {
        try {
            (receiver as any).jitterBufferTarget = target;
        } catch { /* ignore */ }
        try {
            (receiver as any).playoutDelayHint = target / 1000;
        } catch { /* ignore */ }
    }
}
// endregion

// region статистика
export interface StreamStats {
    mbps: number;
    fps: number;
    w: number;
    h: number;
    codec: string;
    rttMs: number;
    lossPct: number;
    jitterMs: number;
    encoder: string;
    limit: string;
}

export function createStatsTracker(direction: "out" | "in") {
    let lastBytes = -1;
    let lastLost = -1;
    let lastPackets = -1;
    let lastTs = 0;

    return async (pc: RTCPeerConnection | null | undefined): Promise<StreamStats | null> => {
        if (!pc || pc.connectionState === "closed" || pc.connectionState === "failed") return null;
        try {
            const report = await pc.getStats();
            const codecs = new Map<string, any>();
            report.forEach((r: any) => { if (r.type === "codec") codecs.set(r.id, r); });

            const stats: StreamStats = {
                mbps: 0, fps: 0, w: 0, h: 0, codec: "", rttMs: 0, lossPct: 0, jitterMs: 0, encoder: "", limit: ""
            };
            let bytes = -1, lost = -1, packets = -1;

            report.forEach((r: any) => {
                if (direction === "out" && r.type === "outbound-rtp" && r.kind === "video") {
                    bytes = r.bytesSent ?? bytes;
                    stats.fps = Math.round(r.framesPerSecond ?? 0);
                    stats.w = r.frameWidth ?? 0;
                    stats.h = r.frameHeight ?? 0;
                    stats.encoder = r.encoderImplementation ?? "";
                    stats.limit = r.qualityLimitationReason ?? "";
                    if (r.codecId) {
                        const c = codecs.get(r.codecId);
                        if (c?.mimeType) stats.codec = String(c.mimeType).replace("video/", "");
                    }
                } else if (direction === "in" && r.type === "inbound-rtp" && r.kind === "video") {
                    bytes = r.bytesReceived ?? bytes;
                    lost = r.packetsLost ?? lost;
                    packets = r.packetsReceived ?? packets;
                    stats.fps = Math.round(r.framesPerSecond ?? 0);
                    stats.w = r.frameWidth ?? 0;
                    stats.h = r.frameHeight ?? 0;
                    stats.jitterMs = Math.round((r.jitter ?? 0) * 1000);
                    if (r.codecId) {
                        const c = codecs.get(r.codecId);
                        if (c?.mimeType) stats.codec = String(c.mimeType).replace("video/", "");
                    }
                } else if (direction === "out" && r.type === "remote-inbound-rtp" && r.kind === "video") {
                    stats.jitterMs = Math.round((r.jitter ?? 0) * 1000);
                    if (r.fractionLost != null) stats.lossPct = Math.round(r.fractionLost * 1000) / 10;
                } else if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded") {
                    if (r.currentRoundTripTime != null) stats.rttMs = Math.round(r.currentRoundTripTime * 1000);
                }
            });

            const now = performance.now();
            if (bytes >= 0 && lastBytes >= 0 && lastTs > 0 && now > lastTs) {
                stats.mbps = Math.round(((bytes - lastBytes) * 8) / (now - lastTs)) / 1000;
            }
            if (direction === "in" && lost >= 0 && lastLost >= 0 && packets >= 0 && lastPackets >= 0) {
                const dLost = lost - lastLost;
                const dPkt = packets - lastPackets;
                if (dLost + dPkt > 0) stats.lossPct = Math.round((dLost / (dLost + dPkt)) * 1000) / 10;
            }
            lastBytes = bytes;
            lastLost = lost;
            lastPackets = packets;
            lastTs = now;

            return stats;
        } catch {
            return null;
        }
    };
}
// endregion

// region HostPeer (стример → один зритель)
class HostPeer {
    pc: RTCPeerConnection;
    closed = false;

    private makingOffer = false;
    private pendingIce: RTCIceCandidateInit[] = [];
    private iceBuf: RTCIceCandidateInit[] = [];
    private iceTimer: NodeJS.Timeout | undefined;
    /** идёт сборка non-trickle сообщения (кандидаты уйдут вместе с offer/answer) */
    private bundling = false;
    private restarted = false;
    /** Публичный ECDH-ключ зрителя (пришёл в join) — им шифруем offer/ice ему */
    peerPk: string | null = null;
    /** Канал превью (кадры для плиток, пока зритель не смотрит) */
    previewDc?: RTCDataChannel;

    constructor(
        private host: HostSession,
        public userId: string
    ) {
        this.pc = new RTCPeerConnection(buildRtcConfig());

        try {
            this.previewDc = this.pc.createDataChannel("vcP2PPreview");
        } catch { /* ignore */ }

        for (const track of host.capture.getTracks()) {
            this.pc.addTrack(track, host.capture);
        }
        applyVideoCodecPreference(this.pc, String(settings.store.codec));

        this.pc.onnegotiationneeded = () => { void this.negotiate(false); };
        this.pc.onicecandidate = e => {
            if (e.candidate) {
                this.iceBuf.push(e.candidate.toJSON());
                if (!this.bundling && !this.iceTimer) {
                    this.iceTimer = setTimeout(() => this.flushIce(), 120);
                }
            }
        };
        this.pc.onicegatheringstatechange = () => {
            if (this.pc.iceGatheringState === "complete") {
                logIceSummary(this.pc, `эфир → ${userId}`);
                this.flushIce(); // финальная порция кандидатов
            }
        };
        this.pc.onconnectionstatechange = () => {
            const st = this.pc.connectionState;
            logger.info(`Пир ${userId}: ${st}`);
            if (st === "failed" && !this.restarted) {
                this.restarted = true;
                void this.negotiate(true);
            } else if (st === "closed" || (st === "failed" && this.restarted)) {
                this.close();
                this.host.removePeer(this.userId, false);
            }
            this.host.mgr.bump();
        };

        void applySendParameters(this.pc);
    }

    private flushIce(): void {
        this.iceTimer = undefined;
        if (this.bundling) return; // кандидаты сейчас уйдут вместе с offer/answer
        if (!this.iceBuf.length) return;
        const candidates = this.iceBuf;
        this.iceBuf = [];
        sendSignals(this.host.channelId, {
            v: 1, t: "ice", s: this.host.streamId, from: myId(), to: this.userId,
            pk: this.peerPk ?? undefined,
            _route: this.host.mgr.routeFor(this.userId),
            d: { candidates }
        });
    }

    private async negotiate(iceRestart: boolean): Promise<void> {
        if (this.closed || this.makingOffer) return;
        this.makingOffer = true;
        this.bundling = true;
        try {
            const offer = await this.pc.createOffer({ iceRestart });
            await this.pc.setLocalDescription(offer);
            // параметры энкодера применяем после установки локального SDP
            void applySendParameters(this.pc);
            const desc = this.pc.localDescription;
            if (desc) {
                // NON-TRICKLE: все кандидаты едут ВМЕСТЕ с оффером — в чат-режиме
                // это 1-2 кода на всю сессию вместо ливни отдельных сообщений
                await waitIceGathering(this.pc, 1500);
                const candidates = this.iceBuf.splice(0);
                sendSignals(this.host.channelId, {
                    v: 1, t: "offer", s: this.host.streamId, from: myId(), to: this.userId,
                    pk: this.peerPk ?? undefined,
                    _route: this.host.mgr.routeFor(this.userId),
                    d: { sdp: mungeOpusStereo(desc.sdp), type: desc.type, candidates }
                });
            }
        } catch (e) {
            logger.error("Ошибка оффера:", e);
        } finally {
            this.makingOffer = false;
            this.bundling = false;
        }
    }

    async handleAnswer(d: { sdp: string; type: RTCSdpType; candidates?: RTCIceCandidateInit[] }): Promise<void> {
        try {
            if (this.pc.signalingState === "have-local-offer" && !this.pc.remoteDescription) {
                await this.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
                const queue = [...this.pendingIce, ...(d.candidates ?? [])];
                this.pendingIce = [];
                for (const c of queue) {
                    try { await this.pc.addIceCandidate(c); } catch { /* ignore */ }
                }
            }
        } catch (e) {
            logger.error("Ошибка answer:", e);
        }
    }

    async handleIce(candidates: RTCIceCandidateInit[]): Promise<void> {
        if (!this.pc.remoteDescription) {
            this.pendingIce.push(...candidates);
            return;
        }
        for (const c of candidates) {
            try { await this.pc.addIceCandidate(c); } catch { /* ignore */ }
        }
    }

    /** Отправить кадр превью зрителю (DataChannel) */
    sendPreview(url: string): void {
        const dc = this.previewDc;
        if (!dc || dc.readyState !== "open") return;
        try {
            dc.send(JSON.stringify({ t: "preview", s: this.host.streamId, d: url }));
        } catch { /* ignore */ }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.iceTimer) clearTimeout(this.iceTimer);
        try { this.pc.close(); } catch { /* ignore */ }
    }
}
// endregion

// region HostSession (мой эфир)
export class HostSession {
    readonly streamId: string;
    readonly peers = new Map<string, HostPeer>();
    /** Нативный аудио-хелпер (v1.4): хранится здесь, чтобы stop() всё закрыл */
    nativeAudio: NativeAudioHandle | null = null;

    constructor(
        readonly mgr: P2PManager,
        readonly channelId: string,
        readonly capture: MediaStream
    ) {
        this.streamId = `${myId()}-${Date.now().toString(36)}-${randomId(4)}`;

        const video = capture.getVideoTracks()[0];
        if (video) {
            video.onended = () => {
                logger.info("Захват остановлен системой");
                this.mgr.stopShare();
                toast("Захват экрана остановлен — P2P-эфир завершён");
            };
        }
    }

    get meta(): StreamMeta {
        return currentMeta();
    }

    /** Живое применение профиля/качества к идущему эфиру (Игры/Кино, битрейт, FPS) */
    applyLiveChanges(): void {
        const video = this.capture.getVideoTracks()[0];
        if (video) {
            try {
                video.contentHint = String(settings.store.contentHint) === "detail" ? "detail" : "motion";
            } catch { /* ignore */ }
            void applyCaptureConstraints(video);
        }
        this.updateEncodings();
        this.mgr.announce();
    }

    createPeer(userId: string, peerPk?: string): HostPeer {
        const existing = this.peers.get(userId);
        if (existing && !existing.closed) {
            const st = existing.pc?.connectionState;
            if (st === "new" || st === "connecting" || st === "connected") {
                // живая сессия — обновляем ключ, если он впервые пришёл
                if (peerPk && !existing.peerPk) existing.peerPk = peerPk;
                return existing;
            }
            // МЁРТВАЯ сессия (disconnected/failed/closed): зритель прислал свежий join —
            // пересоздаём пира. Иначе новый оффер НЕ УЙДЁТ НИКОГДА и зритель зависнет
            // в join-цикле (спам кодами без результата).
            logger.info(`Пересоздаю пира ${userId} (state=${st ?? "нет"})`);
            existing.close();
            this.peers.delete(userId);
        }

        if (this.peers.size >= MAX_VIEWERS) {
            toast(`Достигнут лимит зрителей (${MAX_VIEWERS})`, "critical");
            return existing!;
        }

        logger.info(`Зритель подключается: ${userId}`);
        const peer = new HostPeer(this, userId);
        if (peerPk) peer.peerPk = peerPk;
        this.peers.set(userId, peer);
        this.mgr.bump();
        return peer;
    }

    removePeer(userId: string, notify = true): void {
        const peer = this.peers.get(userId);
        if (!peer) return;
        peer.close();
        this.peers.delete(userId);
        if (notify) {
            // зритель уже ушёл — ничего отправлять не нужно
        }
        this.mgr.bump();
    }

    /** Переприменить параметры отправки (живая смена профиля/битрейта) */
    updateEncodings(): void {
        for (const peer of this.peers.values()) {
            void applySendParameters(peer.pc);
        }
    }

    /** Разослать кадр превью всем зрителям (для плиток до подключения просмотра) */
    broadcastPreview(url: string): void {
        for (const peer of this.peers.values()) peer.sendPreview(url);
    }

    stop(sendBye = true): void {
        if (sendBye) {
            sendSignals(this.channelId, { v: 1, t: "bye", s: this.streamId, from: myId() });
        }
        for (const peer of this.peers.values()) peer.close();
        this.peers.clear();
        for (const track of this.capture.getTracks()) {
            try { track.stop(); } catch { /* ignore */ }
        }
        this.nativeAudio?.stop();
        this.nativeAudio = null;
    }
}
// endregion

// region WatchSession (просмотр чужого эфира)
export class WatchSession {
    pc: RTCPeerConnection | undefined;
    readonly stream = new MediaStream();
    state: WatchState = "connecting";
    host: LiveHost;

    private joinTimer: NodeJS.Timeout | undefined;
    private joinAttempts = 0;
    private pendingIce: RTCIceCandidateInit[] = [];
    private restarts = 0;
    /** буфер ICE-кандидатов (батчинг, как у хоста) — против спама по 1 сообщению на кандидата */
    private iceBuf: RTCIceCandidateInit[] = [];
    private iceTimer: NodeJS.Timeout | undefined;
    /** идёт сборка non-trickle сообщения (кандидаты уйдут вместе с answer) */
    private bundling = false;
    /** Публичный ECDH-ключ хоста (пришёл в offer) — им шифруем answer/ice ему */
    hostPk: string | null = null;

    /** Маршрут сигналов к хосту: по транспорту его анонса (совместимость со старыми версиями) */
    private hostRoute(): "broker" | "chat" | "both" {
        if (this.host.via === "chat") return "chat";
        if (this.host.via === "broker") return "broker";
        return "both";
    }

    /** Шифровать ли answer/ice для этого хоста: брокерные пиры — всегда
     *  (их движок требует e), Discord-транспорт — только v1.10+. */
    private shouldSealHost(): boolean {
        if (this.hostRoute() === "broker") return true;
        return versionAtLeast(this.host.hostVersion, 1, 10);
    }

    constructor(
        private mgr: P2PManager,
        host: LiveHost
    ) {
        this.host = host;
        this.startJoinLoop();
    }

    private startJoinLoop(): void {
        this.joinAttempts = 0;
        this.sendJoin();
        this.joinTimer = setInterval(() => {
            if (this.state !== "connecting") {
                this.stopJoinLoop();
                return;
            }
            this.joinAttempts++;
            if (this.joinAttempts > 2) { // 1 отправка + 2 повтора — раньше 6 join'ов подряд заливали чат
                this.stopJoinLoop();
                this.setState("failed");
                toast("Не удалось подключиться к P2P-эфиру (хост недоступен?)", "critical");
                return;
            }
            this.sendJoin();
        }, 3000);
    }

    private stopJoinLoop(): void {
        if (this.joinTimer) {
            clearInterval(this.joinTimer);
            this.joinTimer = undefined;
        }
    }

    private sendJoin(): void {
        sendSignals(this.host.channelId, {
            v: 1, t: "join", s: this.host.streamId, from: myId(), to: this.host.userId,
            _route: this.hostRoute()
        });
    }

    private setState(state: WatchState): void {
        if (this.state === state) return;
        this.state = state;
        this.mgr.bump();
    }

    async handleOffer(d: { sdp: string; type: RTCSdpType; candidates?: RTCIceCandidateInit[] }, hostPk?: string): Promise<void> {
        try {
            // шифруем answer/ice хосту только если его сторона распечатает:
            // старые хосты в чат-режиме ждут plain-d — шифрование их сломало бы
            if (hostPk && this.shouldSealHost()) this.hostPk = hostPk;
            if (!this.pc) this.setupPc();
            const pc = this.pc!;
            this.stopJoinLoop();

            await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
            applyReceiveLatency(pc);

            // кандидаты хоста, приехавшие вместе с оффером (non-trickle)
            if (d.candidates?.length) {
                for (const c of d.candidates) {
                    try { await pc.addIceCandidate(c); } catch { /* ignore */ }
                }
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // NON-TRICKLE: все наши кандидаты едут вместе с answer одним сообщением
            this.bundling = true;
            await waitIceGathering(pc, 1500);
            const candidates = this.iceBuf.splice(0);
            this.bundling = false;

            sendSignals(this.host.channelId, {
                v: 1, t: "answer", s: this.host.streamId, from: myId(), to: this.host.userId,
                pk: this.hostPk ?? undefined,
                _route: this.hostRoute(),
                d: { sdp: pc.localDescription!.sdp, type: pc.localDescription!.type, candidates }
            });

            const queue = this.pendingIce;
            this.pendingIce = [];
            for (const c of queue) {
                try { await pc.addIceCandidate(c); } catch { /* ignore */ }
            }
        } catch (e) {
            logger.error("Ошибка обработки оффера:", e);
        } finally {
            this.bundling = false;
        }
    }

    async handleIce(candidates: RTCIceCandidateInit[]): Promise<void> {
        const { pc } = this;
        if (!pc || !pc.remoteDescription) {
            this.pendingIce.push(...candidates);
            return;
        }
        for (const c of candidates) {
            try { await pc.addIceCandidate(c); } catch { /* ignore */ }
        }
    }

    /** Отправить накопленных кандидатов одной пачкой (батчинг как у хоста) */
    private flushIce(): void {
        if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = undefined; }
        if (this.bundling) return; // кандидаты сейчас уйдут вместе с answer
        if (!this.iceBuf.length) return;
        const candidates = this.iceBuf;
        this.iceBuf = [];
        sendSignals(this.host.channelId, {
            v: 1, t: "ice", s: this.host.streamId, from: myId(), to: this.host.userId,
            pk: this.hostPk ?? undefined,
            _route: this.hostRoute(),
            d: { candidates }
        });
    }

    handleBye(): void {
        this.setState("ended");
    }

    private setupPc(): void {
        const pc = new RTCPeerConnection(buildRtcConfig());
        this.pc = pc;

        pc.ondatachannel = e => {
            const dc = e.channel;
            dc.onmessage = ev => {
                try {
                    const m = JSON.parse(String(ev.data));
                    if (m?.t === "preview" && m.s && m.d) this.mgr.onPreviewFrame?.(String(m.s), String(m.d));
                } catch { /* ignore */ }
            };
        };

        pc.ontrack = e => {
            const { track } = e;
            try { this.stream.addTrack(track); } catch { /* ignore */ }
            if (track.kind === "video") {
                track.onunmute = () => this.setState("live");
                if (track.readyState === "live" && track.muted === false) this.setState("live");
            }
            this.mgr.bump();
        };
        // Кандидаты — БАТЧАМИ (как у хоста). Раньше каждый кандидат был отдельным
        // сообщением: в чат-фолбэке зритель заливал 10-20 кодов за сессию.
        pc.onicecandidate = e => {
            if (e.candidate) {
                this.iceBuf.push(e.candidate.toJSON());
                if (!this.bundling && !this.iceTimer) {
                    this.iceTimer = setTimeout(() => this.flushIce(), 120);
                }
            }
        };
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") {
                logIceSummary(pc, `просмотр ${this.host.name}`);
                this.flushIce(); // финальная порция
            }
        };
        pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            logger.info(`Просмотр ${this.host.name}: ${st}`);
            if (st === "connected") {
                this.setState("live");
            } else if (st === "disconnected") {
                this.setState("reconnecting");
            } else if (st === "failed") {
                this.reconnect();
            } else if (st === "closed") {
                this.setState("ended");
            }
            this.mgr.bump();
        };
    }

    private reconnect(): void {
        if (this.restarts >= 2) {
            this.setState("failed");
            toast("P2P не подключился: скорее всего, NAT не пробивается. Помогает TURN-сервер (настройки плагина)", "critical");
            return;
        }
        this.restarts++;
        this.stopJoinLoop();
        if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = undefined; }
        this.iceBuf = [];
        try { this.pc?.close(); } catch { /* ignore */ }
        this.pc = undefined;
        this.setState("reconnecting");
        this.startJoinLoop();
    }

    stop(sendLeave = true): void {
        this.stopJoinLoop();
        if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = undefined; }
        this.iceBuf = [];
        if (sendLeave && this.state !== "ended") {
            sendSignals(this.host.channelId, {
                v: 1, t: "leave", s: this.host.streamId, from: myId(), to: this.host.userId,
                _route: this.hostRoute()
            });
        }
        try { this.pc?.close(); } catch { /* ignore */ }
        this.pc = undefined;
    }
}
// endregion

// region P2PManager
export class P2PManager {
    host: HostSession | null = null;
    readonly watches = new Map<string, WatchSession>();
    readonly liveHosts = new Map<string, LiveHost>();

    /** Транспорт, с которого последний раз приходили сигналы пира —
     *  по нему адресуем ответные (совместимость v1.7 ↔ старые версии). */
    private peerTransport = new Map<string, "broker" | "chat">();

    /** true пока startShare() сам ждёт gdm — пикер в этом случае не показывает
     *  кнопку «Обычный стрим Discord» (Discord своей поток не ждёт) */
    internalGdmCall = false;

    version = 0;
    /** вызывается UI-слоем: открывает окно просмотра для новой сессии */
    onWatchCreated: ((session: WatchSession) => void) | null = null;
    /** кадр превью пришёл по DataChannel (подключается nativeTiles) */
    onPreviewFrame: ((streamId: string, url: string) => void) | null = null;

    private listeners = new Set<() => void>();
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private pruneTimer: NodeJS.Timeout | undefined;
    private discoverTimer: NodeJS.Timeout | undefined;
    private lastQuerySent = 0;
    private lastQueryReply = 0;
    /** время последнего announce, ушедшего в чат (троттлинг чат-фолбэка) */
    private lastChatAnnounce = 0;
    private signalingWarned = false;
    private lastVoiceJoinAt = 0;
    private lastVoiceChannelId: string | null = null;
    private lastDiscoveryRequestAt = 0;

    // region подписка для React
    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    };

    getSnapshot = (): number => this.version;

    bump(): void {
        this.version++;
        for (const fn of this.listeners) fn();
    }
    // endregion

    start(): void {
        setCleanupEnabledGetter(() => settings.store.autoDeleteSignals);
        // брокерный сигналинг: все сигналы (announce/query/join/offer/answer/ice)
        // идут через публичный MQTT-брокер, в чат Discord ничего не попадает
        setBrokerMessageHandler((msg, topic) => this.onBrokerMessage(msg, topic));
        this.pruneTimer = setInterval(() => {
            pruneFragments();
            this.pruneLiveHosts();
            const active = !!this.host || this.watches.size > 0 || !!currentVoiceChannelId();
            // брокер выключили на лету — закрываем сокет
            if (!settings.store.brokerEnabled && brokerIsConnected()) brokerShutdown();
            brokerIdleCheck(active);
        }, 5000);
        // discovery-пинг «есть эфиры?» шлём ТОЛЬКО по событию, а не по таймеру:
        //  - сразу после входа в голосовой канал (анонс мог быть пропущен);
        //  - при явном запросе (команда /p2p-watch, открытие окна просмотра).
        // Пока просто сидишь в канале — никаких служебных сообщений не уходит.
        this.discoverTimer = setInterval(() => {
            if (this.host || this.liveHosts.size > 0) return;
            if (settings.store.discoverPings === false) return;
            const voice = currentVoiceChannelId();
            if (!voice) return;
            const now = Date.now();
            const recentJoin = now - this.lastVoiceJoinAt < 9_000;
            const recentRequest = now - this.lastDiscoveryRequestAt < 7_000;
            if (!recentJoin && !recentRequest) return;
            if (now - this.lastQuerySent < 8_000) return;
            this.lastQuerySent = now;
            setTimeout(() => {
                if (this.host || this.liveHosts.size > 0) return;
                const v = currentVoiceChannelId();
                if (!v) return;
                sendSignals(v, { v: 1, t: "query", s: "*", from: myId() });
            }, (myId().charCodeAt(0) % 5) * 700);
        }, 3_000);
        logger.info("P2P-движок запущен");
    }

    /** Вызывается из flux VOICE_STATE_UPDATES: фиксируем момент входа в голосовой канал.
     *  Здесь же обновляем подписку брокера на топик канала (discovery без чата). */
    onVoiceStateUpdate(): void {
        // читаем SelectedChannelStore ПОСЛЕ того, как сторы обработают диспетч — иначе увидим старый канал
        setTimeout(() => {
            try {
                const voice = currentVoiceChannelId();
                if (voice && voice !== this.lastVoiceChannelId) {
                    this.lastVoiceJoinAt = Date.now();
                }
                this.lastVoiceChannelId = voice;
                brokerSetChannel(voice); // подписка на announce/query топик канала
            } catch { /* ignore */ }
        }, 0);
    }

    /** Явный запрос discovery (команда /p2p-watch, открытие окна просмотра) */
    requestDiscovery(): void {
        this.lastDiscoveryRequestAt = Date.now();
    }

    /** Маршрут адресных сигналов к пиру (см. peerTransport) */
    routeFor(userId: string): "broker" | "chat" | "both" {
        return this.peerTransport.get(userId) ?? "both";
    }

    /** Сбросить знание о транспорте пира (новая сессия соединения) */
    resetPeerTransport(userId: string): void {
        this.peerTransport.delete(userId);
    }

    private rememberTransport(userId: string, via: "broker" | "chat"): void {
        if (!userId || this.peerTransport.get(userId) === via) return;
        // не откатываем "broker" на "chat" из-за дубликата join (both-маршрут):
        // предпочитаем более тихий транспорт, пока он реально живой
        const prev = this.peerTransport.get(userId);
        if (prev === "broker" && via === "chat" && Date.now() - (this.transportSetAt.get(userId) ?? 0) < 4_000) return;
        this.peerTransport.set(userId, via);
        this.transportSetAt.set(userId, Date.now());
    }

    private transportSetAt = new Map<string, number>();

    /**
     * Полный сценарий «подключиться к эфиру в моём голосовом канале»:
     * если локально эфиров не знаем — шлём query и даём хосту ~3.5 с ответить,
     * и только потом честно сообщаем, что эфиров нет (с подсказкой про обычные
     * Discord-стримы, если они есть).
     */
    async watchInVoice(): Promise<void> {
        this.requestDiscovery();
        // брокер мог быть ещё не подключён — даём ему до секунды (иначе первый query уйдёт в чат)
        brokerEnsure();
        let list = [...this.liveHosts.values()];
        if (list.length === 0) {
            const voice = currentVoiceChannelId();
            if (!voice) {
                toast("Сначала подключитесь к голосовому каналу", "critical");
                return;
            }
            await new Promise(r => setTimeout(r, 900)); // окно на подключение брокера
            sendSignals(voice, { v: 1, t: "query", s: "*", from: myId() });
            await new Promise(r => setTimeout(r, 2500));
            list = [...this.liveHosts.values()];
        }
        // в канале могут сидеть хосты со старой версией (только чат). Второй чат-
        // пинг нужен ТОЛЬКО если первый ушёл через брокер (старые хосты его не
        // слышат). Если брокер лежал — первый query уже упал в чат: дубль не нужен.
        if (list.length === 0 && brokerIsConnected() && currentVoiceChannelId() && settings.store.discoverPings !== false) {
            const voice = currentVoiceChannelId()!;
            sendSignals(voice, { v: 1, t: "query", s: "*", from: myId(), _route: "chat" });
            await new Promise(r => setTimeout(r, 2500));
            list = [...this.liveHosts.values()];
        }
        if (list.length === 1) {
            this.watch(list[0].streamId);
            return;
        }
        if (list.length > 1) {
            toast(`Несколько эфиров (${list.map(h => h.name).join(", ")}) — выберите пилюлю внизу экрана`);
            return;
        }
        const native = this.nativeStreamsInVoice();
        if (native.length > 0) {
            toast(`P2P-эфиров нет, но ${native.map(n => n.name).join(", ")} стримит через обычный Discord — смотрите плиткой в звонке`);
        } else {
            toast("Активных P2P-эфиров в канале нет");
        }
    }

    shutdown(): void {
        this.stopShare(false);
        for (const w of this.watches.values()) w.stop(false);
        this.watches.clear();
        this.liveHosts.clear();
        if (this.pruneTimer) clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
        if (this.discoverTimer) clearInterval(this.discoverTimer);
        this.discoverTimer = undefined;
        this.stopHeartbeat();
        brokerShutdown();
        this.bump();
        logger.info("P2P-движок остановлен");
    }

    private pruneLiveHosts(): void {
        const now = Date.now();
        let changed = false;
        for (const [sid, host] of this.liveHosts) {
            if (now - host.lastSeen > HOST_TIMEOUT_MS) {
                // Активный просмотр не убиваем: в чат-фолбэке announce редеет до
                // 1/20 с, и гэп в 22 с ещё не значит, что эфир кончился.
                const watch = this.watches.get(sid);
                if (watch && (watch.state === "connecting" || watch.state === "live" || watch.state === "reconnecting")) continue;
                this.liveHosts.delete(sid);
                if (watch) watch.handleBye();
                changed = true;
            }
        }
        if (changed) this.bump();
    }

    // region стриминг
    /** Проверки перед стартом эфира. true — можно начинать */
    checkCanStart(): boolean {
        if (this.host) {
            toast("P2P-эфир уже идёт — остановите его в панели внизу", "critical");
            return false;
        }
        if (!currentVoiceChannelId()) {
            toast("Сначала подключитесь к голосовому каналу", "critical");
            return false;
        }
        return true;
    }

    /** Старт эфира из собственного пикера (источник уже захвачен).
     *  source: выбранный источник пикера (null — неизвестен/весь экран:
     *  нативный звук пойдёт как «система без Discord»). */
    async startShareWithCapture(capture: MediaStream, source: P2PSourceInfo | null = null): Promise<void> {
        brokerEnsure(); // зрители должны найти нас через брокер, не через чат
        if (!this.checkCanStart()) {
            for (const t of capture.getTracks()) {
                try { t.stop(); } catch { /* ignore */ }
            }
            return;
        }

        const video = capture.getVideoTracks()[0];
        if (!video) {
            capture.getTracks().forEach(t => t.stop());
            toast("Видеодорожка не получена", "critical");
            return;
        }

        try {
            video.contentHint = String(settings.store.contentHint) === "detail" ? "detail" : "motion";
        } catch { /* ignore */ }
        void applyCaptureConstraints(video);

        // region звук (v1.4: нативный per-app с фолбэком на системный loopback)
        const sysAudio = capture.getAudioTracks()[0] ?? null;
        let nativeAudioHandle: NativeAudioHandle | null = null;
        if (String(settings.store.audioMode) === "off") {
            if (sysAudio) {
                try { sysAudio.stop(); } catch { /* ignore */ }
                capture.removeTrack(sysAudio);
            }
        } else if (String(settings.store.audioMode) === "native") {
            nativeAudioHandle = await startNativeAudio({
                mode: source && !source.isScreen ? "include-window" : "exclude-tree",
                sourceId: source?.id
            });
            if (nativeAudioHandle) {
                // системный loopback больше не нужен — в эфире только звук приложения/системы без Discord
                if (sysAudio) {
                    try { sysAudio.stop(); } catch { /* ignore */ }
                    capture.removeTrack(sysAudio);
                }
                try { capture.addTrack(nativeAudioHandle.track); } catch { /* ignore */ }
            } else if (!sysAudio) {
                toast("Нативный звук недоступен — эфир пойдёт без звука", "critical");
            }
            // если native недоступен, а sysAudio есть — прозрачно работаем как раньше (system)
        }
        // endregion

        this.host = new HostSession(this, currentVoiceChannelId()!, capture);
        this.host.nativeAudio = nativeAudioHandle;
        this.startHeartbeat();
        this.lastChatAnnounce = 0; // новый эфир — первый анонс уходит сразу, без троттлинга
        this.bump();

        // мгновенное объявление (не ждём первого тика heartbeat)
        this.announce();
        void this.checkSignalingAlive();

        const meta = currentMeta();
        toast(`P2P-эфир начат: ${meta.res} ${meta.fps} FPS, ${meta.bitrate} Мбит/с`, "success");
        logger.info("Эфир начат", meta);
    }

    /** Через несколько секунд убедиться, что анонс реально ушёл (иначе зрители не увидят эфир) */
    private async checkSignalingAlive(): Promise<void> {
        await new Promise(r => setTimeout(r, 4500));
        if (!this.host || this.signalingWarned) return;
        if (signalingHealth.consecutiveFailures > 0) {
            this.signalingWarned = true;
            logger.error("Сигналинг не работает:", signalingHealth.lastError);
            toast("Сигналинг не работает — зрители не увидят эфир. Наберите /p2p-doctor", "critical");
        }
    }

    async startShare(): Promise<void> {
        if (!this.checkCanStart()) return;

        const gdm = navigator.mediaDevices?.getDisplayMedia;
        if (!gdm) {
            toast("Захват экрана недоступен в этом клиенте — используйте Vencord в браузере", "critical");
            return;
        }

        const constraints = buildDisplayConstraints();
        let capture: MediaStream;
        try {
            this.internalGdmCall = true;
            try {
                capture = await gdm.call(navigator.mediaDevices, constraints);
            } finally {
                this.internalGdmCall = false;
            }
        } catch (e: any) {
            const name = e?.name ?? "";
            if (name === "NotAllowedError") return; // пользователь отменил — молча
            logger.error("getDisplayMedia failed:", e);
            if (name === "NotSupportedError" || name === "InvalidStateError" || name === "AbortError") {
                toast("Клиент не разрешил захват экрана. Попробуйте Vencord в браузере (discord.com)", "critical");
            } else {
                toast("Не удалось начать захват экрана", "critical");
            }
            return;
        }

        await this.startShareWithCapture(capture, null);
    }

    stopShare(sendBye = true): void {
        const { host } = this;
        if (!host) return;
        this.host = null;
        this.stopHeartbeat();
        host.stop(sendBye);
        this.bump();
        logger.info("Эфир остановлен");
    }

    /** Объявить всем в канале текущее состояние эфира (announce = heartbeat).
     *  route "chat" — ответ старому зрителю, запросившему через чат. */
    announce(route?: "chat"): void {
        const { host } = this;
        if (!host) return;
        // Чат-фолбэк при лежащем брокере: announce-хартбит раз в 8 с превращал чат
        // в кашу (7+ сообщений в минуту, удаление не успевает). В брокере не видно —
        // там без изменений; в чат — не чаще раза в 20 с (укладывается в HOST_TIMEOUT_MS 22 с).
        if (!route && !brokerIsConnected()) {
            const now = Date.now();
            if (now - this.lastChatAnnounce < 20_000) return;
            this.lastChatAnnounce = now;
        }
        sendSignals(host.channelId, {
            v: 1, t: "announce", s: host.streamId, from: myId(),
            _route: route,
            d: { ...this.host!.meta, av: PLUGIN_VERSION }
        });
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.host) return;
            const voice = currentVoiceChannelId();
            if (!voice || voice !== this.host.channelId) {
                this.stopShare();
                toast("Вы покинули голосовой канал — P2P-эфир остановлен");
                return;
            }
            this.announce();
        }, HEARTBEAT_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
    }
    // endregion

    // region просмотр
    watch(streamId: string): WatchSession | null {
        const existing = this.watches.get(streamId);
        if (existing) return existing;

        brokerEnsure(); // join уйдёт адресно через брокер
        const host = this.liveHosts.get(streamId);
        if (!host) {
            toast("Эфир не найден — возможно, он уже завершился", "critical");
            return null;
        }
        if (this.watches.size >= MAX_VIEWERS) {
            toast("Слишком много активных просмотров", "critical");
            return null;
        }

        this.resetPeerTransport(host.userId); // новый просмотр — транспорт заново
        const session = new WatchSession(this, host);
        this.watches.set(streamId, session);
        this.bump();
        this.onWatchCreated?.(session);
        return session;
    }

    unwatch(streamId: string): void {
        const w = this.watches.get(streamId);
        if (!w) return;
        w.stop(true);
        this.watches.delete(streamId);
        this.bump();
    }
    // endregion

    // region сигналы
    handleSignal(sig: Signal, channelId: string, via: "broker" | "chat" = "chat"): boolean {
        const me = myId();
        if (!me || sig.from === me) return false;
        this.rememberTransport(sig.from, via);

        switch (sig.t) {
            case "announce": {
                const voice = currentVoiceChannelId();
                const prev = this.liveHosts.get(sig.s);
                this.liveHosts.set(sig.s, {
                    streamId: sig.s,
                    userId: sig.from,
                    name: userNameSafe(sig.from),
                    channelId,
                    lastSeen: Date.now(),
                    meta: sig.d ?? {},
                    hostVersion: typeof sig.d?.av === "string" ? sig.d.av : undefined,
                    via
                });

                if (!prev && channelId === voice) {
                    if (settings.store.notifyLive) {
                        toast(`${userNameSafe(sig.from)} начал P2P-эфир — нажмите пилюлю внизу экрана`, "success");
                    }
                    if (settings.store.autoWatch && !this.watches.has(sig.s)) {
                        this.watch(sig.s);
                    }
                }
                this.bump();
                return true;
            }
            case "query": {
                // зритель спрашивает «есть эфиры?» — отвечаем анонсом (не чаще раза в 5 с).
                // Спросили через чат (старая версия) — отвечаем тоже через чат.
                if (this.host && (sig.s === "*" || sig.s === this.host.streamId)) {
                    const now = Date.now();
                    if (now - this.lastQueryReply > 5000) {
                        this.lastQueryReply = now;
                        this.announce(via === "chat" ? "chat" : undefined);
                        // (v1.10) адресный ответ зрителю: broadcast-анонс троттлится,
                        // а зритель ждёт ответ на СВОЙ query. Через ЛС он придёт
                        // гарантированно и никому больше не виден.
                        if (via === "chat" && sig.from && settings.store.silentDm !== false) {
                            sendSignals(channelId, {
                                v: 1, t: "announce", s: this.host.streamId, from: myId(), to: sig.from,
                                _route: "chat",
                                d: { ...this.host.meta, av: PLUGIN_VERSION }
                            });
                        }
                    }
                }
                return true;
            }
            case "bye": {
                if (this.liveHosts.delete(sig.s)) {
                    this.watches.get(sig.s)?.handleBye();
                    this.bump();
                }
                return true;
            }
            case "join": {
                if (this.host && sig.s === this.host.streamId) {
                    // Шифруем offer/ice зрителю, если его сторона умеет распечатывать:
                    //  - брокерные пиры (v1.7+) — ВСЕГДА (их движок требует запечатанные e);
                    //  - Discord-транспорт — только v1.10+ (старые версии ждут plain-d).
                    const canSeal = via === "broker" || versionAtLeast(sig.av, 1, 10);
                    this.host.createPeer(sig.from, canSeal ? sig.pk : undefined);
                }
                return true;
            }
            case "offer": {
                if (sig.to === me) {
                    void this.watches.get(sig.s)?.handleOffer(sig.d, sig.pk);
                }
                return true;
            }
            case "answer": {
                if (sig.to === me && this.host && sig.s === this.host.streamId) {
                    void this.host.peers.get(sig.from)?.handleAnswer(sig.d);
                }
                return true;
            }
            case "ice": {
                if (sig.to !== me) return true;
                const candidates: RTCIceCandidateInit[] = sig.d?.candidates ?? [];
                if (this.host && sig.s === this.host.streamId) {
                    void this.host.peers.get(sig.from)?.handleIce(candidates);
                } else {
                    void this.watches.get(sig.s)?.handleIce(candidates);
                }
                return true;
            }
            case "leave": {
                if (this.host && sig.s === this.host.streamId) {
                    this.host.removePeer(sig.from);
                }
                return true;
            }
        }
        return false;
    }

    /**
     * Обработчик MESSAGE_CREATE (регистрируется через flux-хендлер плагина).
     * С v1.7 нужен ТОЛЬКО для чат-фолбэка (брокер недоступен): в штатном режиме
     * сигналы ходят через MQTT-брокер и чат молчит.
     * ВАЖНО: flux-хендлер Vencord получает ВЕСЬ payload диспетчера, а само
     * сообщение лежит в payload.message (так же его читают плагины Vencord,
     * например xsOverlay: MESSAGE_CREATE({ message, optimistic })).
     */
    onMessageCreate = (payload: any): void => {
        try {
            const msg = payload?.message ?? payload;
            if (!msg || !isSignalContent(msg.content)) return;

            const me = myId();
            if (msg.author?.id === me) {
                // своё эхо (только legacy-путь): удаляем только реальный id из шлюза (не optimistic)
                if (settings.store.autoDeleteSignals) {
                    handleOwnEcho({ ...msg, optimistic: payload?.optimistic === true });
                }
                return;
            }

            void parseSignals(msg.content).then(sigs => {
                for (const sig of sigs) {
                    // (v1.10) тихий транспорт: конверт несёт голосовой канал (ch) —
                    // в ЛС msg.channel_id это ЛС, а не канал эфира
                    this.handleSignal(sig, sig.ch ?? msg.channel_id, "chat");
                }
            });
        } catch (e) {
            logger.debug("onMessageCreate error:", e);
        }
    };

    /**
     * Сигнал из брокера (основной транспорт с v1.7). Форма конверта — см. broker.ts:
     * { v:1, k:тип, from, to?, s, ch?, pk?, d? | e? }, для offer/answer/ice — e
     * зашифрован ECDH+AES-GCM ключом отправителя.
     */
    private onBrokerMessage = async (msg: any, _topic?: string): Promise<void> => {
        try {
            if (!msg || msg.v !== 1 || typeof msg.k !== "string" || typeof msg.from !== "string") return;
            if (msg.from === myId()) return; // MQTT возвращает и свои публикации в подписанный топик
            const me = myId();
            if (msg.to && msg.to !== me) return;

            let d = msg.d;
            if (msg.k === "offer" || msg.k === "answer" || msg.k === "ice") {
                if (!msg.e || !msg.pk) return;
                d = await brokerOpen(msg.pk, msg.e);
            }

            const sig: Signal = {
                v: 1,
                t: msg.k as Signal["t"],
                s: typeof msg.s === "string" ? msg.s : "*",
                from: msg.from,
                to: msg.to,
                d
            };
            const channelId = typeof msg.ch === "string" && msg.ch ? msg.ch : currentVoiceChannelId();
            this.handleSignal(sig, channelId ?? "", "broker");
        } catch (e) {
            logger.debug("onBrokerMessage error:", e);
        }
    };

    /** Есть ли у пользователя активный Discord-стрим (чтобы не конфликтовать) */
    hasDiscordStream(userId: string): boolean {
        try {
            return !!ApplicationStreamingStore.getStreamForUser?.(userId);
        } catch {
            return false;
        }
    }

    /** Обычные (нативные) Discord-стримы в текущем голосовом канале — для подсказок в UI */
    nativeStreamsInVoice(): Array<{ userId: string; name: string }> {
        const voice = currentVoiceChannelId();
        if (!voice) return [];
        try {
            const all: any[] = (ApplicationStreamingStore as any).getAllActiveStreams?.() ?? [];
            const out: Array<{ userId: string; name: string }> = [];
            for (const st of all) {
                try {
                    if (String(st?.channelId ?? st?.channel_id ?? "") !== voice) continue;
                    const uid = String(st?.userId ?? st?.ownerId ?? "");
                    if (!uid || uid === myId()) continue;
                    out.push({ userId: uid, name: userNameSafe(uid) });
                } catch { /* ignore */ }
            }
            return out;
        } catch {
            return [];
        }
    }
    // endregion
}

function userNameSafe(userId: string): string {
    try {
        const u = UserStore.getUser?.(userId);
        return (u?.globalName ?? u?.username) ?? userId;
    } catch {
        return userId;
    }
}

export const manager = new P2PManager();
// endregion
