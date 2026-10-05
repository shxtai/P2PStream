/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { FluxDispatcher, UserStore } from "@webpack/common";

import { captureDesktopSource, listSources, type P2PSourceInfo } from "./capture";
import { manager } from "./engine";
import { settings } from "./settings";
import { openSharePicker } from "./ui/SharePicker";
import { toast } from "./utils";

const logger = new Logger("P2PStream:Hooks");

/**
 * Оригинальный getDisplayMedia, снятый в момент загрузки модуля — до того,
 * как кто-либо (WebScreenShare, Vesktop и т.д.) успел его подменить.
 * Через него идут «обычные» стримы Discord — так пользователь видит ровно
 * тот пикер, к которому привык (Vesktop-пикер / браузерный).
 */
const realGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

function notAllowedError(): Error {
    const e = new Error("P2PStream: cancelled");
    e.name = "NotAllowedError";
    return e;
}

let installed = false;
let reassertTimer: NodeJS.Timeout | undefined;
let ourWrapper: ((opts: DisplayMediaStreamOptions) => Promise<MediaStream>) | null = null;

function makeWrapper(): (opts: DisplayMediaStreamOptions) => Promise<MediaStream> {
    return async function (opts: DisplayMediaStreamOptions) {
        if (String(settings.store.goliveMode) !== "p2p") {
            return realGetDisplayMedia(opts);
        }
        try {
            const me = UserStore.getCurrentUser()?.id ?? "";
            if (manager.hasDiscordStream(me)) {
                toast("Сначала остановите Discord-стрим", "critical");
                throw notAllowedError();
            }
            if (manager.host) {
                toast("P2P-эфир уже идёт — панель остановки внизу экрана", "critical");
                throw notAllowedError();
            }
            // Свой пикер: резолвится потоком для «обычного стрима»,
            // кидает NotAllowedError при отмене и после старта P2P.
            const stream = await openSharePicker({
                discordOptions: opts,
                gdm: realGetDisplayMedia
            });
            return stream;
        } catch (e) {
            // Пользователь отменил / выбрал P2P — для Discord это «отмена захвата».
            if ((e as any)?.name === "NotAllowedError") throw e;
            logger.error("Ошибка пикера:", e);
            throw notAllowedError();
        }
    };
}

/** Установить/переподтвердить нашу подмену getDisplayMedia (устойчиво к чужим подменам). */
function assertWrapper(): void {
    if (!ourWrapper) ourWrapper = makeWrapper();
    const current = navigator.mediaDevices.getDisplayMedia;
    if (current !== ourWrapper) {
        navigator.mediaDevices.getDisplayMedia = ourWrapper as any;
        logger.info("getDisplayMedia перехвачен: кнопка стрима открывает пикер P2PStream");
    }
}

// region перехват стоковой кнопки Discord (Go Live)
/**
 * Десктопный Discord НЕ использует navigator.getDisplayMedia — его кнопка
 * «Стримить» открывает свой пикер, а подтверждение доходит до движка Flux-экшеном
 * MEDIA_ENGINE_SET_GO_LIVE_SOURCE (см. типы MediaEngineStore.setGoLiveSource).
 * Перехватываем экшен через FluxDispatcher.addInterceptor: в режиме p2p отменяем
 * Discord-эфир и запускаем наш P2P-движок с тем же источником.
 * Возврат false из интерцептора отменяет экшен — Discord-стрим не стартует.
 */
const GO_LIVE_SOURCE_ACTION = "MEDIA_ENGINE_SET_GO_LIVE_SOURCE";
const FALLBACK_FLAG = "__p2pstreamFallback";

let goLiveInterceptor: ((payload: any) => boolean | void) | null = null;
let goLiveHijackInstalled = false;

/** Достать Electron source id ("screen:0:0" / "window:pid:id") из полезной нагрузки экшена */
function resolveGoLiveSourceId(payload: any): string | null {
    const candidates = [payload, payload?.source, payload?.goLiveSource, payload?.options];
    for (const c of candidates) {
        const id = c?.desktopSource?.id ?? (typeof c?.id === "string" ? c.id : null);
        if (typeof id === "string" && id) return id;
    }
    return null;
}

/** Повторно отправить экшен с флагом — Discord стримит как обычно (фолбэк, без тупика) */
function redispatchGoLive(payload: any): void {
    try {
        void FluxDispatcher.dispatch({ ...payload, [FALLBACK_FLAG]: true });
    } catch (e) {
        logger.error("Не удалось вернуть экшен Discord:", e);
    }
}

/** Старт P2P с источником, выбранным в стоковом пикере Discord */
async function startP2PFromDiscordSource(sourceId: string, payload: any): Promise<void> {
    const isScreen = sourceId.startsWith("screen:");
    let meta: P2PSourceInfo = { id: sourceId, name: isScreen ? "Экран" : "Окно", thumb: null, isScreen };
    try {
        const found = (await listSources())?.find(s => s.id === sourceId);
        if (found) meta = found;
    } catch { /* имя останется базовым */ }

    // уважим качество, выбранное в стоковом пикере
    const quality = payload?.quality ?? payload?.source?.quality;
    try {
        if (quality?.frameRate) (settings.store as any).fps = String(quality.frameRate);
        if (quality?.resolution) (settings.store as any).resolution = String(quality.resolution);
    } catch { /* ignore */ }

    const stream = await captureDesktopSource(sourceId, {
        fps: Number(settings.store.fps) || 60,
        height: String(settings.store.resolution) === "native" ? null : Number(settings.store.resolution),
        audio: String(settings.store.audioMode) !== "off"
    });
    if (!stream) throw new Error("Захват источника не удался");
    await manager.startShareWithCapture(stream, meta);
    toast(`P2P-эфир начат (источник: ${meta.name})`, "success");
}

async function hijackGoLive(payload: any): Promise<void> {
    const sourceId = resolveGoLiveSourceId(payload);
    if (!sourceId) {
        logger.warn("GoLive-экшен без source id:", JSON.stringify(payload)?.slice(0, 400));
        toast("P2P: не понял выбранный источник — запускаю обычный стрим Discord", "critical");
        redispatchGoLive(payload);
        return;
    }
    try {
        await startP2PFromDiscordSource(sourceId, payload);
    } catch (e) {
        logger.error("P2P из кнопки Discord не удался:", e);
        toast(`P2P не завёлся (${(e as Error)?.message ?? e}) — запускаю обычный стрим Discord`, "critical");
        redispatchGoLive(payload);
    }
}

function goLiveInterceptorImpl(payload: any): boolean | void {
    if (!payload || payload.type !== GO_LIVE_SOURCE_ACTION) return;
    if (String(settings.store.goliveMode) !== "p2p") return;
    if ((payload as any)?.[FALLBACK_FLAG]) return;
    if (manager.host) {
        toast("P2P-эфир уже идёт — сначала остановите его в панели внизу", "critical");
        return false;
    }
    logger.info("Перехвачен стоковый Go Live — запускаю P2P");
    void hijackGoLive(payload);
    return false; // отменяем Discord-эфир
}

function installGoLiveHijack(): void {
    if (goLiveHijackInstalled) return;
    if (typeof (FluxDispatcher as any)?.addInterceptor !== "function") {
        logger.warn("FluxDispatcher.addInterceptor недоступен — стоковая кнопка будет работать как обычный Discord-стрим");
        return;
    }
    goLiveInterceptor = goLiveInterceptorImpl;
    (FluxDispatcher as any).addInterceptor(goLiveInterceptor);
    goLiveHijackInstalled = true;
    logger.info("Стоковая кнопка «Стримить» направлена в P2P (перехват Go Live-экшена)");
}

function uninstallGoLiveHijack(): void {
    if (!goLiveHijackInstalled || !goLiveInterceptor) return;
    try {
        const fd = FluxDispatcher as any;
        if (typeof fd.removeInterceptor === "function") fd.removeInterceptor(goLiveInterceptor);
        else if (Array.isArray(fd._interceptors)) {
            const i = fd._interceptors.indexOf(goLiveInterceptor);
            if (i >= 0) fd._interceptors.splice(i, 1);
        }
    } catch { /* ignore */ }
    goLiveInterceptor = null;
    goLiveHijackInstalled = false;
    logger.info("Перехват стоковой кнопки снят");
}

export function isGoLiveHijackInstalled(): boolean {
    return goLiveHijackInstalled;
}
// endregion

export function installShareHook(): void {
    assertWrapper();
    installGoLiveHijack();
    if (!reassertTimer) {
        // если другой плагин (например, WebScreenShare) подменяет getDisplayMedia
        // после нас — тихо перекрываем обратно
        reassertTimer = setInterval(assertWrapper, 3000);
    }
    installed = true;
}

export function uninstallShareHook(): void {
    uninstallGoLiveHijack();
    if (reassertTimer) {
        clearInterval(reassertTimer);
        reassertTimer = undefined;
    }
    if (installed && ourWrapper && navigator.mediaDevices.getDisplayMedia === ourWrapper) {
        navigator.mediaDevices.getDisplayMedia = realGetDisplayMedia as any;
    }
    installed = false;
    logger.info("Перехват getDisplayMedia снят");
}

export function isShareHookInstalled(): boolean {
    return installed;
}
