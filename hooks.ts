/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { FluxDispatcher, SelectedChannelStore, UserStore } from "@webpack/common";

import { captureDesktopSource, listSources, type P2PSourceInfo } from "./capture";
import { manager } from "./engine";
import { settings } from "./settings";
import { isPickerOpen, openSharePicker } from "./ui/SharePicker";
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
            // Если вызов пошёл от нас (/p2p-start) — кнопку «Обычный стрим Discord»
            // скрываем: отданный поток вернулся бы в наш же startShare (получился бы P2P).
            const stream = await openSharePicker({
                discordOptions: opts,
                gdm: realGetDisplayMedia,
                fromDiscord: !manager.internalGdmCall
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
 * MEDIA_ENGINE_SET_GO_LIVE_SOURCE. Стратегия из двух слоёв:
 *
 *  1. ПЕРЕХВАТ КЛИКА (capture-фаза на document): клик по кнопке стрима в панели
 *     звонка открывает НАШ пикер. Устойчив к переименованиям webpack-модулей —
 *     ищем кнопку по aria-label в панели звонка (panels), а не по модулям.
 *  2. Flux-интерцептор MEDIA_ENGINE_SET_GO_LIVE_SOURCE — страховка: если клик
 *     перехватить не удалось (нестандартная метка кнопки, другой путь запуска),
 *     то после подтверждения источника в стоковом пикере всё равно стартуем P2P.
 */
const GO_LIVE_SOURCE_ACTION = "MEDIA_ENGINE_SET_GO_LIVE_SOURCE";
const FALLBACK_FLAG = "__p2pstreamFallback";

/** Метки кнопки начала стрима (EN/RU и близкие); матчим только «старт» */
const START_STREAM_LABEL_RE = /(go[ ._-]?live|stream|screen[ ._-]?share|share|broadcast|стрим|трансляц|демонстрац|экран|поделиться|эфир)/i;
/**
 * Исключения: остановка стрима, просмотр чужого, участники и т.п.
 * ВАЖНО (v1.10): сюда же добавлены полноэкранные метки — кнопка фуллскрина на
 * плитке обычного Discord-стрима («Полноэкранный режим») содержит слово «экран»
 * и раньше ошибочно открывала наш пикер вместо разворачивания видео.
 */
const NOT_START_LABEL_RE = /(stop|end|leave|disconnect|watch|view|просмотр|смотр|останов|стоп|законч|заверш|отключ|выключ|полноэкран|фуллскрин|full[ ._-]?screen|во весь экран|весь экран|развернут|pop[ ._-]?out|настройк|setting)/i;

let goLiveInterceptor: ((payload: any) => boolean | void) | null = null;
let goLiveHijackInstalled = false;

/** Пользователь выбрал «Обычный стрим Discord» в нашем пикере — пропускаем один
 *  Go Live-путь в Discord (клик по стоковой кнопке / экшен с источником). */
let bypassToDiscordOnce = false;
let bypassSetAt = 0;

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
    // (только значения, которые есть в настройках: Discord шлёт resolution 0 = «источник»
    // и FPS вроде 5/15 — раньше они записывались как есть и ломали селекты/захват)
    const quality = payload?.quality ?? payload?.source?.quality;
    try {
        const fps = Number(quality?.frameRate);
        if ([30, 48, 60, 72, 90, 120, 144, 240].includes(fps)) (settings.store as any).fps = String(fps);
        const res = Number(quality?.resolution);
        if (res === 0) (settings.store as any).resolution = "native";
        else if ([720, 1080, 1440, 2160].includes(res)) (settings.store as any).resolution = String(res);
    } catch { /* ignore */ }

    const stream = await captureDesktopSource(sourceId, {
        fps: Number(settings.store.fps) || 60,
        height: String(settings.store.resolution) === "native" ? null : Number(settings.store.resolution),
        audio: String(settings.store.audioMode) !== "off"
    });
    if (!stream) throw new Error("Захват источника не удался");
    await manager.startShareWithCapture(stream, meta); // тост «эфир начат» показывает движок
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
    // «Обычный стрим Discord» выбран в нашем пикере — пропускаем экшен в Discord
    if (bypassToDiscordOnce) {
        bypassToDiscordOnce = false;
        logger.info("Bypass: обычный стрим Discord запускается без перехвата");
        return;
    }
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

// region перехват КЛИКА по стоковой кнопке «Стримить» (слой 1)
/**
 * Слушаем клики в capture-фазе на document: клик по кнопке начала стрима
 * открывает НАШ пикер (а не пикер Discord).
 *
 * Кнопку ищем без webpack (устойчиво к обновлениям Discord). ВАЖНО (v1.7):
 * раньше требовали closest('[class*="panels_"]') — это работает в панели
 * аккаунта, но в ЛС-звонке кнопка живёт в контролах звонка с другими классами,
 * и перехват молча не срабатывал. Теперь:
 *  - кнопка иконочная (без текста) с aria-label «начать стрим» (EN/RU);
 *  - НЕ в модалках/слоях/меню/настройках и не в нашем UI;
 *  - активна (не disabled);
 *  - мы в голосовом канале.
 * Побочные кнопки панели (микрофон, камера, звуковая панель, настройки) не
 * подходят под фильтр; свой Discord-стрим — кнопка «Остановить» (исключается
 * по слову и по hasDiscordStream).
 */
const EXCLUDED_ZONE_RE = '[class*="layerContainer"],[class*="modal"],[role="menu"],[class*="popout"],[class*="standardSidebarView"],[class*="chatLayer"],[class*="emojiPicker"],#vc-p2p-bars';

let clickInterceptor: ((e: MouseEvent) => void) | null = null;
let clickInterceptorInstalled = false;

function inVoiceChannel(): boolean {
    try {
        return !!SelectedChannelStore.getVoiceChannelId?.();
    } catch {
        return false;
    }
}

/** Пропустить один клик/экшен в Discord — там откроется свой пикер и пойдёт обычный стрим */
function bypassOnceToDiscord(): void {
    bypassToDiscordOnce = true;
    bypassSetAt = Date.now();
    // страховка: если Discord-путь так и не случился, снимаем флаг через 2 минуты
    setTimeout(() => {
        if (bypassToDiscordOnce && Date.now() - bypassSetAt >= 115_000) {
            bypassToDiscordOnce = false;
        }
    }, 120_000);
}

function docClickCapture(e: MouseEvent): void {
    try {
        if (String(settings.store.goliveMode) !== "p2p") return;
        if (bypassToDiscordOnce) return; // разрешили обычный стрим — не мешаем
        if (isPickerOpen()) return; // наш пикер уже открыт
        if (!inVoiceChannel()) return;

        const target = e.target as Element | null;
        const btn = target?.closest?.("button, [role=button]") as Element | null;
        if (!btn) return;

        const label = btn.getAttribute("aria-label") ?? "";
        if (!label || !START_STREAM_LABEL_RE.test(label) || NOT_START_LABEL_RE.test(label)) return;
        // только иконочные кнопки: у share-кнопок в embeds/профилях есть текст — отсекаем их
        if (btn.textContent?.trim()) return;
        // (v1.10) страховка от ложных срабатываний на плитках стрима: если кнопка
        // живёт в контейнере с <video> (плитка/поп-аут стрима) — это кнопка
        // фуллскрина/настроек стрима, а не «начать демонстрацию»
        if (btn.closest("video")) return;
        const tile = btn.closest('[class*="tile"], [class*="tileContainer"], [class*="videoLayer"], [class*="popout_"]');
        if (tile && tile.querySelector("video")) return;
        // не в модалках/слоях/меню/настройках и не в нашем UI
        if (btn.closest(EXCLUDED_ZONE_RE)) return;
        if (btn.getAttribute("aria-disabled") === "true" || btn.hasAttribute("disabled")) return;

        const me = UserStore.getCurrentUser()?.id ?? "";
        if (me && manager.hasDiscordStream(me)) return; // это кнопка остановки своего Discord-стрима
        if (manager.host) return; // наш P2P уже идёт — пусть Discord показывает свой UI

        // перехватываем: Discord-пикер вообще не откроется
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        logger.info("Перехвачен клик по стоковой кнопке стрима — открываю пикер P2PStream");

        void openSharePicker({
            discordOptions: {},
            gdm: realGetDisplayMedia,
            fromDiscord: true,
            onWantDiscordPicker: () => {
                bypassOnceToDiscord();
                // отдаём ход Discord: повторный клик по той же кнопке откроет его пикер
                try {
                    (btn as HTMLElement).click?.();
                } catch (err) {
                    logger.warn("Не удалось повторно кликнуть стоковую кнопку:", err);
                }
            }
        });
    } catch (err) {
        logger.debug("docClickCapture error:", err);
    }
}

function installClickInterceptor(): void {
    if (clickInterceptorInstalled) return;
    clickInterceptor = docClickCapture;
    document.addEventListener("click", clickInterceptor, true);
    clickInterceptorInstalled = true;
    logger.info("Клик по стоковой кнопке «Стримить» открывает пикер P2PStream");
}

function uninstallClickInterceptor(): void {
    if (!clickInterceptorInstalled || !clickInterceptor) return;
    document.removeEventListener("click", clickInterceptor, true);
    clickInterceptor = null;
    clickInterceptorInstalled = false;
}

export function isClickInterceptorInstalled(): boolean {
    return clickInterceptorInstalled;
}
// endregion

export function installShareHook(): void {
    assertWrapper();
    installGoLiveHijack();
    installClickInterceptor();
    if (!reassertTimer) {
        // если другой плагин (например, WebScreenShare) подменяет getDisplayMedia
        // после нас — тихо перекрываем обратно
        reassertTimer = setInterval(assertWrapper, 3000);
    }
    installed = true;
}

export function uninstallShareHook(): void {
    uninstallGoLiveHijack();
    uninstallClickInterceptor();
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
