/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, findOption } from "@api/Commands";
import { Settings as AppSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { MessageActions, RestAPI, SelectedChannelStore } from "@webpack/common";

import { brokerEnsure, brokerLabel, brokerLastError, brokerShutdown, brokerStatus } from "./broker";
import { manager, mediaReport, probeNat, relayStatus } from "./engine";
import { installShareHook, isClickInterceptorInstalled, isGoLiveHijackInstalled, isShareHookInstalled, uninstallShareHook } from "./hooks";
import { installNativeTiles, uninstallNativeTiles } from "./nativeTiles";
import { DEFAULT_BROKER_URL, settings } from "./settings";
import { signalingHealth } from "./signaling";
import managedStyle from "./styles.css?managed";
import { AboutCard } from "./ui/AboutCard";
import { mountBars } from "./ui/Bars";
import { openViewerModal } from "./ui/ViewerModal";
import { PLUGIN_VERSION, toast } from "./utils";

const logger = new Logger("P2PStream");

/** Хот-свап: применить настройки брокера из ссылки `p2ps://connect?broker=...&secret=...`
 *  без перезагрузки Discord/плагина. Останавливает текущее соединение и
 *  немедленно переподключается с новыми параметрами. */
function applyBrokerLink(url: string): void {
    try {
        const parsed = new URL(url);
        const broker = parsed.searchParams.get("broker");
        const secret = parsed.searchParams.get("secret");
        if (!broker) {
            toast("Неверная ссылка подключения", "critical");
            return;
        }
        // Применяем настройки мгновенно
        const store = settings.store as any;
        store.brokerUrl = broker;
        if (secret != null) store.brokerSecret = secret;
        store.brokerEnabled = true;
        // Перезапускаем брокер
        brokerShutdown();
        setTimeout(() => {
            brokerEnsure();
            toast(`Подключено к брокеру: ${new URL(broker).host}`, "success");
        }, 100);
    } catch (e) {
        logger.error("applyBrokerLink:", e);
        toast("Ошибка подключения (неверная ссылка?)", "critical");
    }
}

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
    push("RestAPI доступен", typeof (RestAPI as any)?.post === "function");
    push("сигналинг (усп/ошибок подряд)", `${signalingHealth.sent} / ${signalingHealth.consecutiveFailures}${signalingHealth.lastError ? ` (последняя: ${signalingHealth.lastError})` : ""}`);
    push("брокер сигналинга", !settings.store.brokerEnabled
        ? "выключен — используется тихий Discord-транспорт"
        : brokerStatus() === "connected"
            ? `${brokerLabel()} — Discord для сигналинга не используется`
            : `включён, не подключён (${brokerStatus()}; посл. причина: ${brokerLastError()}) — фолбэк: ${settings.store.chatFallback ? "тихий Discord-транспорт" : "выключен"}`);
    push("тихий Discord-транспорт", settings.store.silentDm === false ? "выключен (видимые коды с автоудалением)" : "@silent: адресные коды в ЛС, анонсы в голосовой канал; самоудаление ~2 с; уведомлений нет");
    push("чат-фолбэк (Discord-транспорт)", settings.store.chatFallback);
    try {
        const stuns = String(settings.store.stunServers ?? "").split(",").map(s => s.trim()).filter(Boolean);
        push("STUN", stuns.join(", ") || "НЕТ — P2P между разными сетями не соберётся");
        push("TURN", relayStatus());
    } catch { /* ignore */ }
    push("эфиров видно", manager.liveHosts.size);
    push("своих P2P-эфиров", manager.host ? 1 : 0);
    push("просмотров", manager.watches.size);
    for (const [uid, peer] of manager.host?.peers ?? []) {
        push(`  зритель ${uid}`, `conn=${peer.pc.connectionState}, ice=${peer.pc.iceConnectionState}, sig=${peer.pc.signalingState}, шифр=${peer.peerPk ? "да" : "нет"}, декодер зрителя: ${peer.viewerRx && Date.now() - peer.viewerRx.at < 5000 ? `показывает ${Math.max(0, Math.round(peer.viewerRx.decFps - peer.viewerRx.dropFps))} из ${Math.round(peer.viewerRx.recvFps)} FPS (${peer.viewerRx.hw ? "аппаратный" : "программный"}, ${peer.viewerRx.impl})` : "нет данных"}, авто-качество: ${peer.aqCapBps ? `${(peer.aqCapBps / 1e6).toFixed(1)} Мбит/с, масштаб ÷${peer.aqScale.toFixed(2)}${peer.aqFps ? `, FPS ${peer.aqFps}` : ""}` : "ещё не активно"}`);
    }
    for (const w of manager.watches.values()) {
        const { pc } = w;
        push(`  просмотр ${w.host.name}`, `буфер ${w.jitterTargetMs} мс, сдвиг видео под звук ${w.audioLeadMs()} мс, state=${w.state}, ${pc ? `conn=${pc.connectionState}, ice=${pc.iceConnectionState}, sig=${pc.signalingState}` : "оффер от хоста НЕ получен"}, дорожек=${w.stream.getTracks().length}, хост v${w.host.hostVersion ?? "?"} via ${w.host.via ?? "?"}`);
    }
    push("нативные плитки", settings.store.nativeTiles);
    push("нативный плеер", settings.store.nativePlayer === false ? "выключен — просмотр в своём окне" : "вкл — P2P в штатном плеере Discord (фолбэк: свой)");
    push("звук", settings.store.audioMode);
    const audioSt = manager.host?.nativeAudio?.stats?.();
    if (audioSt) {
        push("нативный звук (сейчас)", `режим ${audioSt.mode} · буфер ${audioSt.levelMs} мс · рестартов ${audioSt.restarts} · тишина ${Math.round(audioSt.silenceMs / 1000)} с${audioSt.dead ? " · ХЕЛПЕР МЁРТВ (перезапуск)" : ""}`);
    }
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

/** v1.21: брокер-воркер зашит по умолчанию. У старых установок в store мог
 *  сохраниться явный brokerUrl = "" (старый дефолт) и брокер был выключен —
 *  один раз проставляем новые значения. Свой брокер, настроенный вручную,
 *  не трогаем: раз адрес вписан, выбор был осознанным. */
function migrateBroker121(): void {
    try {
        const s = settings.store as any;
        if (s.brokerMigrated121) return;
        const url = String(s.brokerUrl ?? "").trim();
        if (!url) {
            s.brokerUrl = DEFAULT_BROKER_URL;
            s.brokerEnabled = true;
        } else if (url === DEFAULT_BROKER_URL) {
            s.brokerEnabled = true;
        }
        s.brokerMigrated121 = true;
    } catch { /* ignore */ }
}

export default definePlugin({
    name: "P2PStream",
    description: "P2P-стриминг вместо Discord Go Live: до 100 Мбит/с, задержка 30–80 мс, до 240 FPS, H.264/H.265/VP9/AV1. Автокачество: FPS не ниже 45 (если не выставлено меньше) с авто-срезкой/возвратом разрешения, звук не пропадает (вотчдог) и не уезжает (дрейф-коррекция), P2P-эфир в штатном плеере Discord (фуллскрин/поп-аут/PiP) и в плитках звонка, остановка — штатной красной кнопкой Discord, свой пикер, умный звук приложения (WASAPI Process Loopback). Сигналинг через свой MQTT-брокер в Cloudflare (зашит по умолчанию) или тихие @silent-коды в ЛС.",
    searchTerms: ["p2p", "stream", "quality", "bitrate", "webrtc", "golive", "стрим", "качество"],
    tags: ["Voice", "Media", "Utility"],
    authors: [{ name: "Super Z", id: 0n }],
    enabledByDefault: false,
    managedStyle,
    settings,
    settingsAboutComponent: AboutCard,

    toolboxActions: {
        "Начать P2P-стрим": () => void manager.startShare(),
        "Остановить P2P-стрим": () => manager.stopShare(),
        "🔌 Подключиться к брокеру (ссылка из приглашения)": () => {
            const link = prompt("Вставьте ссылку p2ps://connect… из приглашения:");
            if (link?.trim()) applyBrokerLink(link.trim());
        }
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
                toast("Диагностика P2PStream: проверяю сеть и поток (~4 с)…");
                void (async () => {
                    // статистика потока (если идёт эфир/просмотр) — параллельно с проверкой NAT
                    const reports: Array<Promise<string[]>> = [];
                    const labels: string[] = [];
                    for (const [uid, peer] of manager.host?.peers ?? []) {
                        labels.push(`поток → ${uid}`);
                        reports.push(mediaReport(peer.pc, "out"));
                    }
                    for (const w of manager.watches.values()) {
                        if (!w.pc) continue;
                        labels.push(`поток ← ${w.host.name}`);
                        reports.push(mediaReport(w.pc, "in"));
                    }
                    const [nat, ...media] = await Promise.all([probeNat(), ...reports]);
                    media.forEach((lines, i) => lines.forEach(l => logger.info(`P2P-DOC | ${labels[i]} | ${l}`)));
                    logger.info(`P2P-DOC | NAT: ${nat}`);
                    logger.info("P2P-DOC | Скопируйте эти строки и отправьте разработчику");
                    toast("Диагностика P2PStream записана в консоль (Ctrl+Shift+I → Console)", "success");
                })();
            }
        },
        {
            name: "p2p-share",
            description: "Отправить приглашение на P2P-стрим в текущий чат",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async () => {
                const brokerUrl = settings.store.brokerUrl || DEFAULT_BROKER_URL;
                const secret = String(settings.store.brokerSecret ?? "");
                if (!brokerUrl) {
                    toast("Настройте brokerUrl", "critical");
                    return;
                }
                const voiceId = SelectedChannelStore.getVoiceChannelId?.();
                if (!voiceId) {
                    toast("Зайдите в голосовой канал", "critical");
                    return;
                }
                const channelId = SelectedChannelStore.getChannelId?.();
                if (!channelId) {
                    toast("Откройте текстовый канал", "critical");
                    return;
                }
                // Ссылка-приглашение: зритель копирует её и применяет
                // инструментом «🔌 Подключиться к брокеру» (хот-свап, без перезагрузки).
                const link = `p2ps://connect?broker=${encodeURIComponent(brokerUrl)}&secret=${encodeURIComponent(secret)}`;
                try {
                    await RestAPI.post({
                        url: `/channels/${channelId}/messages`,
                        body: {
                            content: "🎬 **P2P-эфир** — чтобы смотреть, скопируйте ссылку ниже и используйте в Vencord: **Tools → P2PStream → 🔌 Подключиться к брокеру** (без перезагрузки Discord)",
                            embeds: [{
                                title: "P2P-стрим: подключение",
                                description: "```\n" + link + "\n```",
                                color: 0x5865F2,
                                fields: [
                                    { name: "📡 Брокер", value: brokerUrl },
                                    { name: "🔑 Секрет", value: secret ? "✅ в ссылке" : "❌ не задан (нужен для воркера с защитой)" },
                                    { name: "🎙 Канал", value: "<#" + voiceId + ">" }
                                ],
                                footer: { text: "P2PStream v" + PLUGIN_VERSION }
                            }]
                        }
                    });
                    toast("Приглашение отправлено", "success");
                } catch (e) {
                    logger.error("p2p-share error:", e);
                    toast("Ошибка отправки приглашения", "critical");
                }
            }
        },
        {
            name: "p2p-join",
            description: "Подключиться к P2P-брокеру по ссылке-приглашению (p2ps://connect…)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "link",
                    description: "Ссылка p2ps://connect?broker=...&secret=...",
                    type: 3,
                    required: true
                }
            ],
            execute: async args => {
                applyBrokerLink(String(findOption(args, "link", "")));
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
        migrateBroker121();

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

        // Обработка ссылок p2ps://connect (хот-свап настроек брокера)
        // Пользователь открывает ссылку из приглашения — настройки применяются мгновенно
        const handleDeepLink = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const link = target.closest("a[href^='p2ps://']") as HTMLAnchorElement | null;
            if (link?.href) {
                e.preventDefault();
                applyBrokerLink(link.href);
            }
        };
        document.addEventListener("click", handleDeepLink, true);

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
