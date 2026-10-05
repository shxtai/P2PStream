/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType } from "@api/Commands";
import { Settings as AppSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

import { manager } from "./engine";
import { installShareHook, uninstallShareHook } from "./hooks";
import { installNativeTiles, uninstallNativeTiles } from "./nativeTiles";
import { settings } from "./settings";
import managedStyle from "./styles.css?managed";
import { AboutCard } from "./ui/AboutCard";
import { mountBars } from "./ui/Bars";
import { openViewerModal } from "./ui/ViewerModal";
import { toast } from "./utils";

const logger = new Logger("P2PStream");

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
                const list = [...manager.liveHosts.values()];
                if (list.length === 0) {
                    toast("Активных P2P-эфиров в канале нет");
                    return;
                }
                if (list.length === 1) {
                    manager.watch(list[0].streamId);
                    return;
                }
                toast(`Несколько эфиров (${list.map(h => h.name).join(", ")}) — выберите пилюлю внизу экрана`);
            }
        }
    ],

    flux: {
        MESSAGE_CREATE: (msg: any) => manager.onMessageCreate(msg),
        VOICE_STATE_UPDATES: () => manager.bump()
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

        logger.info("P2PStream v1.4 запущен (пикер v2 + нативный звук)");
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
