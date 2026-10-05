/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType } from "@api/Commands";
import { Settings as AppSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { MessageActions, SelectedChannelStore } from "@webpack/common";

import { manager } from "./engine";
import { installShareHook, isClickInterceptorInstalled, isGoLiveHijackInstalled, isShareHookInstalled, uninstallShareHook } from "./hooks";
import { installNativeTiles, uninstallNativeTiles } from "./nativeTiles";
import { settings } from "./settings";
import { signalingHealth } from "./signaling";
import managedStyle from "./styles.css?managed";
import { AboutCard } from "./ui/AboutCard";
import { mountBars } from "./ui/Bars";
import { openViewerModal } from "./ui/ViewerModal";
import { PLUGIN_VERSION, toast } from "./utils";

const logger = new Logger("P2PStream");

/** Собрать снимок состояния плагина — для /p2p-doctor и стартового баннера */
function collectDiagnostics(): string[] {
    const lines: string[] = [];
    const push = (k: string, v: unknown) => lines.push(`P2P-DOC | ${k}: ${String(v)}`);

    push("версия", PLUGIN_VERSION);
    push("клиент", navigator.userAgent);
    push("голосовой канал", (() => { try { return SelectedChannelStore.getVoiceChannelId?.() ?? "нет"; } catch { return "нет"; } })());
    push("режим кнопки стрима", settings.store.goliveMode);
    push("getDisplayMedia перехвачен", isShareHookInstalled());
    push("стоковая кнопка (Go Live → P2P)", isGoLiveHijackInstalled());
    push("клик по кнопке «Стримить» → наш пикер", isClickInterceptorInstalled());

    const helpers = (globalThis as any).VencordNative?.pluginHelpers?.P2PStream;
    push("native-каналы (getSources/звук)", helpers ? Object.keys(helpers).join(", ") : "НЕТ — плагин без native-части (однофайловая сборка?)");

    push("CompressionStream", typeof CompressionStream === "function");
    try {
        const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs
            ?.map(c => c.mimeType.split("/")[1]?.toUpperCase())
            .filter((v, i, a) => v && a.indexOf(v) === i);
        push("видеокодеки", codecs?.join(", ") ?? "неизвестно");
    } catch { push("видеокодеки", "ошибка"); }
    push("sendMessage доступен", typeof MessageActions.sendMessage === "function");
    push("сигналинг (усп/ошибок подряд)", `${signalingHealth.sent} / ${signalingHealth.consecutiveFailures}${signalingHealth.lastError ? ` (последняя: ${signalingHealth.lastError})` : ""}`);
    push("эфиров видно", manager.liveHosts.size);
    push("своих P2P-эфиров", manager.host ? 1 : 0);
    push("просмотров", manager.watches.size);
    push("нативные плитки", settings.store.nativeTiles);
    push("звук", settings.store.audioMode);
    return lines;
}

/** Допускает UI-слой к открытию окна просмотра при создании сессии просмотра */
manager.onWatchCreated = session => openViewerModal(session);

/** Миграция старой настройки shareAudio (bool) -> audioMode (select) */
function migrateLegacyAudio(): void {
    try {
        const raw = (AppSettings.plugins.P2PStream as any)?.shareAudio;
        if (raw === false) settings.store.audioMode = "off";
    } catch { /* ignore */ }
}

export default definePlugin({
    name: "P2PStream",
    description: "P2P-стриминг вместо Discord Go Live: до 100 Мбит/с, задержка 30–80 мс, до 240 FPS, AV1/VP9/H.264. Свой пикер с выбором P2P/обычного стрима, умный звук приложения (WASAPI Process Loopback — как у Discord: окно → звук приложения, экран → система без Discord), плитка стрима в звонке с меткой P2P и превью, зум/PiP/фуллскрин у зрителя.",
    searchTerms: ["p2p", "stream", "quality", "bitrate", "webrtc", "golive", "стрим", "качество"],
    tags: ["Voice", "Media", "Utility"],
    authors: [{ name: "Super Z", id: 0n }],
    enabledByDefault: false,
    managedStyle,
    settings,
    settingsAboutComponent: AboutCard,

    toolboxActions: {
        "Начать P2P-стрим": () => void manager.startShare(),
        "Остановить P2P-стрим": () => manager.stopShare()
    },

    commands: [
        {
            name: "p2p-start",
            description: "Начать P2P-стрим (откроется выбор источника)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => {
                void manager.startShare();
            }
        },
        {
            name: "p2p-stop",
            description: "Остановить свой P2P-стрим",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => {
                manager.stopShare();
            }
        },
        {
            name: "p2p-watch",
            description: "Подключиться к P2P-эфиру в этом голосовом канале",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => {
                // если локально эфиров не знаем — спросит канал (query) и подождёт ответ хоста
                void manager.watchInVoice();
            }
        },
        {
            name: "p2p-doctor",
            description: "Диагностика P2PStream в консоль (для проверки установки и тестов)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => {
                for (const ln of collectDiagnostics()) logger.info(ln);
                logger.info("P2P-DOC | Скопируйте эти строки и отправьте разработчику");
                toast("Диагностика P2PStream записана в консоль (Ctrl+Shift+I → Console)", "success");
            }
        }
    ],

    flux: {
        MESSAGE_CREATE: (payload: any) => manager.onMessageCreate(payload),
        VOICE_STATE_UPDATES: () => manager.onVoiceStateUpdate()
    },

    patches: [
        {
            // Буст качества Discord Go Live (включается только в режиме boost).
            // Тот же приём, что у встроенного плагина Vencord WebScreenShare.
            find: "this.getDefaultGoliveQuality()",
            replacement: {
                match: /this\.getDefaultGoliveQuality\(\)/,
                replace: "$self.boostGoLiveQuality($&)"
            }
        }
    ],

    /** Подмена «максимального качества» Go Live у Discord (режим boost) */
    boostGoLiveQuality(opts: any) {
        if (String(settings.store.goliveMode) !== "boost") return opts;
        const fps = Number(settings.store.fps) || 60;
        const res = String(settings.store.resolution);
        const height = res === "native" ? 2160 : Number(res) || 1080;
        const width = Math.round((height * 16) / 9);
        const maxBitrate = Math.round(Number(settings.store.videoBitrate) * 1_000_000);

        Object.assign(opts ?? {}, {
            bitrateMin: 500_000,
            bitrateMax: maxBitrate,
            bitrateTarget: Math.round(maxBitrate * 0.8)
        });
        if (opts?.encode) {
            Object.assign(opts.encode, { framerate: fps, width, height, pixelCount: width * height });
        }
        if (opts?.capture) {
            Object.assign(opts.capture, { framerate: fps, width, height, pixelCount: width * height });
        }
        return opts;
    },

    start() {
        manager.start();
        manager.onWatchCreated = session => openViewerModal(session);
        migrateLegacyAudio();

        // v1.4: старый дефолт «system» -> новый дефолт «native» (умный звук).
        // Один раз: флаг audioModeMigrated14 не даёт перекрыть явный выбор пользователя.
        try {
            const s = settings.store as any;
            if (!s.audioModeMigrated14) {
                if (s.audioMode === "system") s.audioMode = "native";
                s.audioModeMigrated14 = true;
            }
        } catch { /* ignore */ }

        if (settings.store.nativeTiles) installNativeTiles();

        this.unmountBars = mountBars();

        // Кнопка «Демонстрация экрана» → наш пикер: подменяем getDisplayMedia
        // (тот же приём, что у встроенного плагина Vencord WebScreenShare —
        // устойчив к переименованиям модулей Discord).
        installShareHook();

        // стартовый баннер: сразу видно версию и доступность нативных каналов
        logger.info(`P2PStream v${PLUGIN_VERSION} запущен`);
        for (const ln of collectDiagnostics()) logger.info(ln);
    },

    stop() {
        uninstallShareHook();
        uninstallNativeTiles();
        this.unmountBars?.();
        this.unmountBars = undefined;
        manager.onWatchCreated = null;
        manager.shutdown();
        logger.info("Плагин остановлен");
    },

    unmountBars: undefined as (() => void) | undefined
});
