/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, SelectedChannelStore, UserStore } from "@webpack/common";

import { AUTO_CODEC_ORDER, settings } from "./settings";
import {
    deleteSignalMessage,
    isSignalContent,
    parseSignals,
    pruneFragments,
    SELF_DESTRUCT_MS,
    sendSignals,
    setCleanupEnabledGetter,
    type Signal
} from "./signaling";
import { myId, randomId, toast } from "./utils";

const logger = new Logger("P2PStream:Engine");

const ApplicationStreamingStore = findByPropsLazy("getStreamForUser", "getAllApplicationStreams");

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
    for (const urls of stuns) iceServers.push({ urls });

    const turnUrl = String(settings.store.turnUrl ?? "").trim();
    if (turnUrl) {
        iceServers.push({
            urls: turnUrl,
            username: String(settings.store.turnUser ?? ""),
            credential: String(settings.store.turnPassword ?? "")
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

    const audio = settings.store.audioMode === "system"
        ? { restrictOwnAudio: true } as MediaTrackConstraints
        : false;

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
    private restarted = false;

    constructor(
        private host: HostSession,
        public userId: string
    ) {
        this.pc = new RTCPeerConnection(buildRtcConfig());

        for (const track of host.capture.getTracks()) {
            this.pc.addTrack(track, host.capture);
        }
        applyVideoCodecPreference(this.pc, String(settings.store.codec));

        this.pc.onnegotiationneeded = () => { void this.negotiate(false); };
        this.pc.onicecandidate = e => {
            if (e.candidate) {
                this.iceBuf.push(e.candidate.toJSON());
                if (!this.iceTimer) {
                    this.iceTimer = setTimeout(() => this.flushIce(), 120);
                }
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
        if (!this.iceBuf.length) return;
        const candidates = this.iceBuf;
        this.iceBuf = [];
        sendSignals(this.host.channelId, {
            v: 1, t: "ice", s: this.host.streamId, from: myId(), to: this.userId,
            d: { candidates }
        });
    }

    private async negotiate(iceRestart: boolean): Promise<void> {
        if (this.closed || this.makingOffer) return;
        this.makingOffer = true;
        try {
            const offer = await this.pc.createOffer({ iceRestart });
            await this.pc.setLocalDescription(offer);
            // параметры энкодера применяем после установки локального SDP
            void applySendParameters(this.pc);
            const desc = this.pc.localDescription;
            if (desc) {
                sendSignals(this.host.channelId, {
                    v: 1, t: "offer", s: this.host.streamId, from: myId(), to: this.userId,
                    d: { sdp: mungeOpusStereo(desc.sdp), type: desc.type }
                });
            }
        } catch (e) {
            logger.error("Ошибка оффера:", e);
        } finally {
            this.makingOffer = false;
        }
    }

    async handleAnswer(d: { sdp: string; type: RTCSdpType }): Promise<void> {
        try {
            if (this.pc.signalingState === "have-local-offer" && !this.pc.remoteDescription) {
                await this.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
                const queue = this.pendingIce;
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

    createPeer(userId: string): HostPeer {
        const existing = this.peers.get(userId);
        if (existing && !existing.closed) return existing;

        if (this.peers.size >= MAX_VIEWERS) {
            toast(`Достигнут лимит зрителей (${MAX_VIEWERS})`, "critical");
            return existing!;
        }

        logger.info(`Зритель подключается: ${userId}`);
        const peer = new HostPeer(this, userId);
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

    stop(sendBye = true): void {
        if (sendBye) {
            sendSignals(this.channelId, { v: 1, t: "bye", s: this.streamId, from: myId() });
        }
        for (const peer of this.peers.values()) peer.close();
        this.peers.clear();
        for (const track of this.capture.getTracks()) {
            try { track.stop(); } catch { /* ignore */ }
        }
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
            if (this.joinAttempts > 5) {
                this.stopJoinLoop();
                this.setState("failed");
                toast("Не удалось подключиться к P2P-эфиру (хост недоступен?)", "critical");
                return;
            }
            this.sendJoin();
        }, 2500);
    }

    private stopJoinLoop(): void {
        if (this.joinTimer) {
            clearInterval(this.joinTimer);
            this.joinTimer = undefined;
        }
    }

    private sendJoin(): void {
        sendSignals(this.host.channelId, {
            v: 1, t: "join", s: this.host.streamId, from: myId(), to: this.host.userId
        });
    }

    private setState(state: WatchState): void {
        if (this.state === state) return;
        this.state = state;
        this.mgr.bump();
    }

    async handleOffer(d: { sdp: string; type: RTCSdpType }): Promise<void> {
        try {
            if (!this.pc) this.setupPc();
            const pc = this.pc!;
            this.stopJoinLoop();

            await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
            applyReceiveLatency(pc);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            sendSignals(this.host.channelId, {
                v: 1, t: "answer", s: this.host.streamId, from: myId(), to: this.host.userId,
                d: { sdp: pc.localDescription!.sdp, type: pc.localDescription!.type }
            });

            const queue = this.pendingIce;
            this.pendingIce = [];
            for (const c of queue) {
                try { await pc.addIceCandidate(c); } catch { /* ignore */ }
            }
        } catch (e) {
            logger.error("Ошибка обработки оффера:", e);
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

    handleBye(): void {
        this.setState("ended");
    }

    private setupPc(): void {
        const pc = new RTCPeerConnection(buildRtcConfig());
        this.pc = pc;

        pc.ontrack = e => {
            const { track } = e;
            try { this.stream.addTrack(track); } catch { /* ignore */ }
            if (track.kind === "video") {
                track.onunmute = () => this.setState("live");
                if (track.readyState === "live" && track.muted === false) this.setState("live");
            }
            this.mgr.bump();
        };
        pc.onicecandidate = e => {
            if (e.candidate) {
                sendSignals(this.host.channelId, {
                    v: 1, t: "ice", s: this.host.streamId, from: myId(), to: this.host.userId,
                    d: { candidates: [e.candidate.toJSON()] }
                });
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
            return;
        }
        this.restarts++;
        try { this.pc?.close(); } catch { /* ignore */ }
        this.pc = undefined;
        this.setState("reconnecting");
        this.startJoinLoop();
    }

    stop(sendLeave = true): void {
        this.stopJoinLoop();
        if (sendLeave && this.state !== "ended") {
            sendSignals(this.host.channelId, {
                v: 1, t: "leave", s: this.host.streamId, from: myId(), to: this.host.userId
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

    version = 0;
    /** вызывается UI-слоем: открывает окно просмотра для новой сессии */
    onWatchCreated: ((session: WatchSession) => void) | null = null;

    private listeners = new Set<() => void>();
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private pruneTimer: NodeJS.Timeout | undefined;

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
        this.pruneTimer = setInterval(() => {
            pruneFragments();
            this.pruneLiveHosts();
        }, 5000);
        logger.info("P2P-движок запущен");
    }

    shutdown(): void {
        this.stopShare(false);
        for (const w of this.watches.values()) w.stop(false);
        this.watches.clear();
        this.liveHosts.clear();
        if (this.pruneTimer) clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
        this.stopHeartbeat();
        this.bump();
        logger.info("P2P-движок остановлен");
    }

    private pruneLiveHosts(): void {
        const now = Date.now();
        let changed = false;
        for (const [sid, host] of this.liveHosts) {
            if (now - host.lastSeen > HOST_TIMEOUT_MS) {
                this.liveHosts.delete(sid);
                const watch = this.watches.get(sid);
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

    /** Старт эфира из собственного пикера (источник уже захвачен) */
    async startShareWithCapture(capture: MediaStream): Promise<void> {
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

        this.host = new HostSession(this, currentVoiceChannelId()!, capture);
        this.startHeartbeat();
        this.bump();

        // мгновенное объявление (не ждём первого тика heartbeat)
        this.announce();

        const meta = currentMeta();
        toast(`P2P-эфир начат: ${meta.res} ${meta.fps} FPS, ${meta.bitrate} Мбит/с`, "success");
        logger.info("Эфир начат", meta);
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
            capture = await gdm.call(navigator.mediaDevices, constraints);
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

        await this.startShareWithCapture(capture);
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

    /** Объявить всем в канале текущее состояние эфира (announce = heartbeat) */
    announce(): void {
        const { host } = this;
        if (!host) return;
        sendSignals(host.channelId, {
            v: 1, t: "announce", s: host.streamId, from: myId(), d: this.host!.meta
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

        const host = this.liveHosts.get(streamId);
        if (!host) {
            toast("Эфир не найден — возможно, он уже завершился", "critical");
            return null;
        }
        if (this.watches.size >= MAX_VIEWERS) {
            toast("Слишком много активных просмотров", "critical");
            return null;
        }

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
    handleSignal(sig: Signal, channelId: string): boolean {
        const me = myId();
        if (!me || sig.from === me) return false;

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
                    meta: sig.d ?? {}
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
            case "bye": {
                if (this.liveHosts.delete(sig.s)) {
                    this.watches.get(sig.s)?.handleBye();
                    this.bump();
                }
                return true;
            }
            case "join": {
                if (this.host && sig.s === this.host.streamId) {
                    this.host.createPeer(sig.from);
                }
                return true;
            }
            case "offer": {
                if (sig.to === me) {
                    void this.watches.get(sig.s)?.handleOffer(sig.d);
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

    /** Обработчик MESSAGE_CREATE (регистрируется через flux-хендлер плагина) */
    onMessageCreate = (msg: any): void => {
        try {
            if (!msg || !isSignalContent(msg.content)) return;

            const me = myId();
            if (msg.author?.id === me) {
                // своё эхо: самоуничтожение
                if (settings.store.autoDeleteSignals && msg.channel_id && msg.id) {
                    setTimeout(() => deleteSignalMessage(msg.channel_id, msg.id), SELF_DESTRUCT_MS);
                }
                return;
            }

            void parseSignals(msg.content).then(sigs => {
                let matched = false;
                for (const sig of sigs) {
                    matched = this.handleSignal(sig, msg.channel_id) || matched;
                }
                if (matched && settings.store.autoDeleteSignals && msg.channel_id && msg.id) {
                    deleteSignalMessage(msg.channel_id, msg.id);
                }
            });
        } catch (e) {
            logger.debug("onMessageCreate error:", e);
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
