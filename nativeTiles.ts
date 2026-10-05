/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByProps } from "@webpack";
import {
    ApplicationStreamingStore,
    ApplicationStreamPreviewStore,
    ChannelRTCStore,
    ChannelStore,
    FluxDispatcher,
    UserStore
} from "@webpack/common";

import { type LiveHost, manager } from "./engine";
import { setNativeTilesHandler, settings } from "./settings";
import { myId, myName } from "./utils";

const logger = new Logger("P2PStream:NativeTiles");

let installed = false;
const restoreFns: Array<() => void> = [];
let previewTimer: NodeJS.Timeout | undefined;
let unsubscribeManager: (() => void) | undefined;
let pokeScheduled = false;

/** Живые превью плитки: streamId -> dataURL */
const previewUrls = new Map<string, string>();
const previewVideos = new Map<string, HTMLVideoElement>();
let previewCanvas: HTMLCanvasElement | null = null;

let PLACEHOLDER = "";

// region вспомогательные
function participantTypeValue(): string {
    // ParticipantType — enum Discord'а; определяем во время выполнения, чтобы не зависеть от версии
    try {
        const mod: any = findByProps("USER", "STREAM", "ACTIVITY", "HIDDEN_STREAM")
            ?? findByProps("USER", "STREAM", "ACTIVITY");
        if (mod && (typeof mod.STREAM === "string" || typeof mod.STREAM === "number")) {
            return mod.STREAM;
        }
    } catch { /* ignore */ }
    return "stream";
}

function guildIdOfChannel(channelId: string): string | null {
    try {
        const channel: any = ChannelStore.getChannel?.(channelId);
        const gid = channel?.getGuildId?.() ?? channel?.guild_id ?? null;
        return gid != null && gid !== "" ? String(gid) : null;
    } catch {
        return null;
    }
}

function allHosts(): LiveHost[] {
    const list = [...manager.liveHosts.values()];
    // Свою трансляцию тоже показываем (как Discord показывает свой Go Live)
    if (manager.host) {
        const { host } = manager;
        list.push({
            streamId: host.streamId,
            userId: myId(),
            name: myName(),
            channelId: host.channelId,
            lastSeen: Date.now(),
            meta: host.meta
        });
    }
    return list;
}

function hostsInChannel(channelId: any): LiveHost[] {
    if (channelId == null) return [];
    const id = String(channelId);
    return allHosts().filter(h => h.channelId === id);
}

function hostByOwner(ownerId: any): LiveHost | null {
    if (ownerId == null) return null;
    const id = String(ownerId);
    return allHosts().find(h => h.userId === id) ?? null;
}

function streamKeyFor(host: LiveHost): string {
    const gid = guildIdOfChannel(host.channelId);
    return gid ? `${gid}:${host.channelId}:${host.userId}` : `${host.channelId}:${host.userId}`;
}

function hostByStreamKey(streamKey: any): LiveHost | null {
    if (streamKey == null) return null;
    const key = String(streamKey);
    const byKey = allHosts().find(h => streamKeyFor(h) === key);
    if (byKey) return byKey;
    // запасной вариант: ключ оканчивается на userId
    return allHosts().find(h => key.endsWith(h.userId)) ?? null;
}

function maxResolution(): { height: number; width: number } {
    const res = String(settings.store.resolution);
    const height = res === "native" ? 2160 : Number(res) || 1080;
    return { height, width: Math.round((height * 16) / 9) };
}
// endregion

// region фейковый ApplicationStream / StreamParticipant
/** Объект с полями стрима Discord + запасные Immutable-подобные методы через Proxy */
function fakeStream(host: LiveHost): any {
    const key = streamKeyFor(host);
    const gid = guildIdOfChannel(host.channelId);
    const user = UserStore.getUser?.(host.userId) ?? null;

    const target: any = {
        // идентификаторы
        id: host.userId,
        streamId: key,
        streamKey: key,
        key,
        // привязка
        channelId: host.channelId,
        guildId: gid,
        ownerId: host.userId,
        userId: host.userId,
        streamType: gid ? "guild" : "call",
        // состояние
        state: "ACTIVE",
        sourceName: "P2P STREAM",
        sourceId: null,
        sourceIcon: null,
        secondStreamId: null,
        region: "p2p",
        rtcServerId: undefined,
        viewerIds: [],
        // участник
        type: participantTypeValue(),
        user,
        userNick: host.name,
        userVideo: false,
        // качество (бейдж 1080p60 и т.п.)
        maxResolution: maxResolution(),
        maxFrameRate: Number(host.meta.fps) || 60,
        __vcP2PFake: true
    };

    return new Proxy(target, {
        get(t, p) {
            if (p in t) return t[p];
            switch (p) {
                case "get": return (k: any) => t[String(k)];
                case "getIn": return (path: any) => t[String(Array.isArray(path) ? path[0] : path)];
                case "has": return (k: any) => String(k) in t;
                case "toJS":
                case "toJSON": return () => {
                    const copy: any = {};
                    for (const k of Object.keys(t)) copy[k] = t[k];
                    return copy;
                };
                default: return undefined;
            }
        }
    });
}
/** Участник-стрим для плиток звонка. У Discord пользователь и его стрим — ДВА
 *  разных участника: у стрима id = streamKey и ссылка на ApplicationStream в stream.
 *  (Раньше фейк имел id = userId и подменял участника-пользователя — иконка
 *  стримера пропадала из звонка, будто его там нет.) */
function fakeParticipant(host: LiveHost): any {
    const stream = fakeStream(host);
    const key = streamKeyFor(host);
    return new Proxy({ id: key, stream, __vcP2PFake: true }, {
        get(t: any, p) {
            if (p in t) return t[p];
            return stream[p];
        },
        has(t: any, p) {
            return p in t || p in stream;
        }
    });
}

function isOurStreamParticipant(channelId: any, participantId: any): LiveHost | null {
    if (participantId == null) return null;
    const id = String(participantId);
    return hostsInChannel(channelId).find(h => streamKeyFor(h) === id) ?? null;
}
// endregion

// region обёртки сторов
function override(obj: any, method: string, impl: (orig: (...args: any[]) => any, ...args: any[]) => any): void {
    if (!obj || typeof obj[method] !== "function") return;
    const orig = obj[method];
    const wrapped = function (this: any, ...args: any[]) {
        try {
            return impl(orig.bind(obj), ...args);
        } catch (e) {
            logger.debug(`${method} wrapper error:`, e);
            return orig.apply(obj, args);
        }
    };
    obj[method] = wrapped;
    restoreFns.push(() => {
        try { obj[method] = orig; } catch { /* ignore */ }
    });
}

function wrapApplicationStreamingStore(): void {
    const store: any = ApplicationStreamingStore;
    if (!store) return;

    override(store, "getAllApplicationStreams", orig => {
        const res = orig() ?? [];
        const fakes = allHosts().map(fakeStream);
        return fakes.length ? [...res, ...fakes] : res;
    });

    override(store, "getAllApplicationStreamsForChannel", (orig, channelId) => {
        const res = orig(channelId) ?? [];
        const fakes = hostsInChannel(channelId).map(fakeStream);
        return fakes.length ? [...res, ...fakes] : res;
    });

    override(store, "getAllActiveStreamsForChannel", (orig, channelId) => {
        const res = orig(channelId) ?? [];
        const fakes = hostsInChannel(channelId).map(fakeStream);
        return fakes.length ? [...res, ...fakes] : res;
    });

    override(store, "getAnyStreamForUser", (orig, userId) => {
        const host = hostByOwner(userId);
        return host ? fakeStream(host) : orig(userId);
    });

    override(store, "getStreamForUser", (orig, userId, guildId) => {
        const host = hostByOwner(userId);
        return host ? fakeStream(host) : orig(userId, guildId);
    });

    override(store, "getActiveStreamForUser", (orig, userId, guildId) => {
        const host = hostByOwner(userId);
        return host ? fakeStream(host) : orig(userId, guildId);
    });

    override(store, "getAnyDiscoverableStreamForUser", (orig, userId) => {
        const host = hostByOwner(userId);
        return host ? fakeStream(host) : orig(userId);
    });

    override(store, "getActiveStreamForStreamKey", (orig, streamKey) => {
        const host = hostByStreamKey(streamKey);
        return host ? fakeStream(host) : orig(streamKey);
    });

    override(store, "getRTCStream", (orig, streamKey) => {
        const host = hostByStreamKey(streamKey);
        if (host) return { region: "p2p", streamKey: streamKeyFor(host), viewerIds: [] };
        return orig(streamKey);
    });

    override(store, "getStreamerActiveStreamMetadataForStream", (orig, streamKey) => {
        if (hostByStreamKey(streamKey)) {
            return { id: null, pid: null, sourceName: "P2P STREAM", previewDisabled: false };
        }
        return orig(streamKey);
    });

    override(store, "getIsActiveStreamPreviewDisabled", (orig, streamKey) => {
        if (hostByStreamKey(streamKey)) return false;
        return orig(streamKey);
    });

    override(store, "isStreamMarkedFull", (orig, streamKey) => {
        if (hostByStreamKey(streamKey)) return false;
        return orig(streamKey);
    });
}

function wrapChannelRTCStore(): void {
    const store: any = ChannelRTCStore;
    if (!store) return;

    override(store, "getParticipants", (orig, channelId) => {
        const res = orig(channelId) ?? [];
        const hosts = hostsInChannel(channelId);
        if (!hosts.length) return res;
        // участника-пользователя НЕ трогаем — плитку стрима добавляем рядом
        const list = [...res].filter((p: any) => !p?.__vcP2PFake);
        for (const host of hosts) {
            const key = streamKeyFor(host);
            if (list.some((p: any) => p && String(p.id) === key)) continue;
            list.push(fakeParticipant(host));
        }
        return list;
    });

    override(store, "getParticipant", (orig, channelId, participantId) => {
        const host = isOurStreamParticipant(channelId, participantId);
        return host ? fakeParticipant(host) : orig(channelId, participantId);
    });

    override(store, "getStreamParticipants", (orig, channelId) => {
        const res = orig(channelId) ?? [];
        const fakes = hostsInChannel(channelId).map(fakeParticipant);
        if (!fakes.length) return res;
        const list = [...res].filter((p: any) => !p?.__vcP2PFake);
        return [...list, ...fakes];
    });

    override(store, "isParticipantPoppedOut", (orig, channelId, participantId) => {
        if (isOurStreamParticipant(channelId, participantId)) return false;
        return orig(channelId, participantId);
    });
}

// endregion

// region превью плиток
function placeholderUrl(): string {
    if (!PLACEHOLDER) {
        const svg =
            "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'>" +
            "<rect width='640' height='360' fill='#111214'/>" +
            "<circle cx='320' cy='150' r='10' fill='#f23f42'/>" +
            "<text x='320' y='200' fill='#f2f3f5' font-family='sans-serif' font-size='30' font-weight='800' text-anchor='middle'>P2P STREAM</text>" +
            "<text x='320' y='232' fill='#949ba4' font-family='sans-serif' font-size='15' text-anchor='middle'>нажмите, чтобы смотреть</text>" +
            "</svg>";
        PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
    return PLACEHOLDER;
}

/** Снять кадр с видео в jpeg-dataURL (480x270) */
function grabFrame(video: HTMLVideoElement): string | null {
    if (!previewCanvas) {
        previewCanvas = document.createElement("canvas");
        previewCanvas.width = 480;
        previewCanvas.height = 270;
    }
    const ctx = previewCanvas.getContext("2d");
    if (!ctx) return null;
    try {
        ctx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
        return previewCanvas.toDataURL("image/jpeg", 0.55);
    } catch {
        return null;
    }
}

function tickPreviews(): void {
    try {
        const active = new Set(manager.watches.keys());
        let changed = false;

        // Превью собственного эфира + рассылка кадров зрителям
        const { host } = manager;
        if (host) {
            active.add(host.streamId);
            let video = previewVideos.get(host.streamId);
            if (!video) {
                video = document.createElement("video");
                video.muted = true;
                video.autoplay = true;
                video.playsInline = true;
                video.srcObject = host.capture;
                void video.play().catch(() => { /* ignore */ });
                previewVideos.set(host.streamId, video);
            }
            if (video.readyState >= 2) {
                const url = grabFrame(video);
                if (url && previewUrls.get(host.streamId) !== url) {
                    previewUrls.set(host.streamId, url);
                    host.broadcastPreview(url);
                    changed = true;
                }
            }
        }

        for (const [streamId, watch] of manager.watches) {
            if (watch.state !== "live" || watch.pc == null) continue;

            let video = previewVideos.get(streamId);
            if (!video) {
                video = document.createElement("video");
                video.muted = true;
                video.autoplay = true;
                video.playsInline = true;
                video.srcObject = watch.stream;
                void video.play().catch(() => { /* ignore */ });
                previewVideos.set(streamId, video);
            }
            if (video.readyState < 2) continue;

            const url = grabFrame(video);
            if (url && previewUrls.get(streamId) !== url) {
                previewUrls.set(streamId, url);
                changed = true;
            }
        }

        for (const streamId of [...previewVideos.keys()]) {
            if (!active.has(streamId)) {
                const video = previewVideos.get(streamId);
                try { video?.pause(); } catch { /* ignore */ }
                previewVideos.delete(streamId);
            }
        }
        for (const streamId of [...previewUrls.keys()]) {
            if (!active.has(streamId)) previewUrls.delete(streamId);
        }

        if (changed) pokeUI();
    } catch (e) {
        logger.debug("tickPreviews:", e);
    }
}

function wrapPreviewStore(): void {
    const store: any = ApplicationStreamPreviewStore;
    if (!store) return;

    const urlFor = (ownerId: any): string | null => {
        const host = hostByOwner(ownerId);
        if (!host) return null;
        return previewUrls.get(host.streamId) ?? placeholderUrl();
    };

    override(store, "getPreviewURL", (orig, guildId, channelId, ownerId) => {
        const url = urlFor(ownerId);
        return url ?? orig(guildId, channelId, ownerId);
    });

    override(store, "getPreviewURLForStreamKey", (orig, streamKey) => {
        const host = hostByStreamKey(streamKey);
        if (!host) return orig(streamKey);
        return previewUrls.get(host.streamId) ?? placeholderUrl();
    });

    override(store, "shouldFetchPreview", (orig, guildId, channelId, ownerId) => {
        if (hostByOwner(ownerId)) return false;
        return orig(guildId, channelId, ownerId);
    });

    override(store, "getIsPreviewLoading", (orig, guildId, channelId, ownerId) => {
        if (hostByOwner(ownerId)) return false;
        return orig(guildId, channelId, ownerId);
    });
}
// endregion

// region перехват «Смотреть»
/** При клике «Смотреть» на нашей плитке Discord пытается подключиться к своему RTC —
 *  перехватываем и открываем наш P2P-просмотрщик. */
function installWatchIntercept(): void {
    const modules = new Set<any>();
    for (const props of [
        ["setActiveStream", "clearActiveStream"],
        ["setActiveStream", "sendStreamPing"],
        ["setActiveStream"],
        ["watchStream"]
    ]) {
        try {
            const mod: any = findByProps(...props);
            if (mod) modules.add(mod);
        } catch { /* ignore */ }
    }

    for (const key of ["setActiveStream", "watchStream", "streamUser"]) {
        for (const mod of modules) {
            const orig = mod[key];
            if (typeof orig !== "function" || orig.__vcP2PWrapped) continue;

            const wrapped = function (this: any, ...args: any[]) {
                try {
                    const first = args[0];
                    const key0 = first?.streamKey ?? first?.streamId ?? (typeof first === "string" ? first : undefined);
                    const host = key0 != null ? hostByStreamKey(key0) : null;
                    if (host) {
                        const session = manager.watch(host.streamId);
                        if (session) manager.onWatchCreated?.(session);
                        return;
                    }
                } catch (e) {
                    logger.debug("watch intercept:", e);
                }
                return orig.apply(this, args);
            };
            (wrapped as any).__vcP2PWrapped = true;
            mod[key] = wrapped;
            restoreFns.push(() => {
                try { mod[key] = orig; } catch { /* ignore */ }
            });
        }
    }
}
// endregion

// region обновление UI Discord'а
/** Мягкий «пинок»: пустой VOICE_STATE_UPDATES заставляет сторы эмитнуть изменение
 *  и перерисовать плитки звонка. */
function pokeUI(): void {
    if (pokeScheduled) return;
    pokeScheduled = true;
    setTimeout(() => {
        pokeScheduled = false;
        try {
            FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [] } as any);
        } catch { /* ignore */ }
    }, 150);
}
// endregion

export function installNativeTiles(): boolean {
    if (installed) return true;

    try {
        wrapApplicationStreamingStore();
        wrapChannelRTCStore();
        wrapPreviewStore();
        installWatchIntercept();

        previewTimer = setInterval(tickPreviews, 2000);
        unsubscribeManager = manager.subscribe(pokeUI);

        installed = true;
        logger.info("Нативные плитки P2P-эфиров включены");
    } catch (e) {
        logger.error("Не удалось включить нативные плитки:", e);
        uninstallNativeTiles();
    }
    return installed;
}

export function uninstallNativeTiles(): void {
    for (const fn of restoreFns) {
        try { fn(); } catch { /* ignore */ }
    }
    restoreFns.length = 0;
    if (previewTimer) clearInterval(previewTimer);
    previewTimer = undefined;
    unsubscribeManager?.();
    unsubscribeManager = undefined;
    for (const video of previewVideos.values()) {
        try { video.pause(); } catch { /* ignore */ }
    }
    previewVideos.clear();
    previewUrls.clear();
    installed = false;
    logger.info("Нативные плитки выключены");
}

// обработчик переключения настройки (избегаем цикла импортов settings -> nativeTiles)
setNativeTilesHandler(enabled => {
    if (enabled) installNativeTiles();
    else uninstallNativeTiles();
});

// входящие превью-кадры от хостов (DataChannel) — рисуем их в плитках сразу
manager.onPreviewFrame = (streamId, url) => {
    previewUrls.set(streamId, url);
    pokeUI();
};
