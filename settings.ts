/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export type GoliveMode = "p2p" | "boost" | "off";
export type Profile = "games" | "movies" | "manual";
export type Codec = "auto" | "h264" | "vp9" | "av1";
export type ContentHint = "motion" | "detail";
export type AudioMode = "native" | "system" | "off";

/** Обработчик переключения «нативных плиток» (регистрируется в nativeTiles, чтобы избежать цикла импортов) */
export let onNativeTilesChange: ((enabled: boolean) => void) | null = null;

export function setNativeTilesHandler(fn: (enabled: boolean) => void): void {
    onNativeTilesChange = fn;
}

/** Порядок предпочтения кодеков в режиме «Авто» (от самого лёгкого для CPU/GPU) */
export const AUTO_CODEC_ORDER: string[] = ["h264", "vp9", "av1"];

export const settings = definePluginSettings({
    goliveMode: {
        type: OptionType.SELECT,
        description: "Что делает кнопка «Демонстрация экрана» в Discord",
        options: [
            { label: "Свой пикер: P2P-стрим или обычный стрим Discord", value: "p2p", default: true },
            { label: "Discord Go Live + буст качества", value: "boost" },
            { label: "Обычный Discord-стрим (без изменений)", value: "off" },
        ] as const,
        onChange: (v: any) => {
            if (v === "p2p") {
                settings.store.jitterBuffer = 0;
                settings.store.contentHint = "motion";
            }
        }
    },
    profile: {
        type: OptionType.SELECT,
        description: "Профиль качества P2P-стрима (Игры/Кино — применяют пресет к значениям ниже)",
        options: [
            { label: "Игры — минимальная задержка", value: "games", default: true },
            { label: "Кино — плавность и детализация", value: "movies" },
            { label: "Вручную — значения ниже", value: "manual" },
        ] as const,
        onChange: (v: any) => applyProfile(v as Profile)
    },
    resolution: {
        type: OptionType.SELECT,
        description: "Разрешение захвата (источник)",
        options: [
            { label: "720p", value: "720" },
            { label: "1080p", value: "1080", default: true },
            { label: "1440p", value: "1440" },
            { label: "2160p (4K)", value: "2160" },
            { label: "Родное (без масштабирования)", value: "native" },
        ] as const
    },
    fps: {
        type: OptionType.SELECT,
        description: "Частота кадров — Discord ограничивает 60, здесь до 240",
        options: [
            { label: "30 FPS", value: "30" },
            { label: "48 FPS", value: "48" },
            { label: "60 FPS", value: "60", default: true },
            { label: "72 FPS", value: "72" },
            { label: "90 FPS", value: "90" },
            { label: "120 FPS", value: "120" },
            { label: "144 FPS", value: "144" },
            { label: "240 FPS", value: "240" },
        ] as const
    },
    videoBitrate: {
        type: OptionType.SLIDER,
        description: "Видеобитрейт, Мбит/с (Discord даёт максимум ~8, здесь — до 100)",
        markers: [2, 5, 10, 15, 20, 25, 30, 40, 50, 65, 80, 100],
        default: 25,
        stickToMarkers: false
    },
    audioBitrate: {
        type: OptionType.SLIDER,
        description: "Аудиобитрейт Opus (стерео), кбит/с — Discord даёт ~96",
        markers: [64, 96, 128, 192, 256, 320, 384, 448, 512],
        default: 256,
        stickToMarkers: false
    },
    codec: {
        type: OptionType.SELECT,
        description: "Видеокодек (Авто: H.264 → VP9 → AV1, самый лёгкий для системы первым)",
        options: [
            { label: "Авто", value: "auto", default: true },
            { label: "H.264 — аппаратный на всех GPU", value: "h264" },
            { label: "VP9 — лучшее сжатие", value: "vp9" },
            { label: "AV1 — максимум эффективности (RTX 40 / RX 7000 / Arc)", value: "av1" },
        ] as const
    },
    contentHint: {
        type: OptionType.SELECT,
        description: "Оптимизация контента: Motion — держать FPS в движении (игры), Detail — чёткость (фильмы, текст)",
        options: [
            { label: "Motion (игры)", value: "motion", default: true },
            { label: "Detail (фильмы, статика)", value: "detail" },
        ] as const
    },
    jitterBuffer: {
        type: OptionType.SLIDER,
        description: "Буфер зрителя, мс: 0 — минимальная задержка (~30–80 мс), выше — плавнее при нестабильной сети",
        markers: [0, 25, 50, 100, 150, 250, 350, 500],
        default: 0,
        stickToMarkers: false
    },
    audioMode: {
        type: OptionType.SELECT,
        description: "Звук трансляции. «Умный» (Windows 10 2004+): окно — звук только этого приложения; экран — вся система без Discord. Недоступен — автоматически системный",
        options: [
            { label: "Умный: звук приложения / система без Discord", value: "native", default: true },
            { label: "Системный звук всегда", value: "system" },
            { label: "Без звука", value: "off" },
        ] as const
    },
    autoDeleteSignals: {
        type: OptionType.BOOLEAN,
        description: "Автоудаление служебных сообщений из Discord (для тихого транспорта тоже: ЛС-коды живут ~2 с)",
        default: true
    },
    silentDm: {
        type: OptionType.BOOLEAN,
        description: "Тихий сигналинг: служебные коды идут сообщениями @silent (флаг Discord «без уведомлений») — адресные в ЛС с пиром, анонсы в голосовой канал; каждое удаляется за ~2 с. Ни у кого никаких уведомлений",
        default: true
    },
    chatFallback: {
        type: OptionType.BOOLEAN,
        description: "Discord-транспорт сигналинга (тихие коды, см. выше). Выключите — тогда без брокера соединение не установится вовсе",
        default: true
    },
    brokerEnabled: {
        type: OptionType.BOOLEAN,
        description: "Сигналинг через MQTT-брокер (мимо Discord). Публичные брокеры у части сетей блокируются; свой брокер — cf-worker/worker.js из репозитория (Cloudflare, 2 мин) или mosquitto на своём сервере. Без брокера работает тихий Discord-транспорт",
        default: false
    },
    brokerUrl: {
        type: OptionType.STRING,
        description: "Свой брокер сигналинга (WSS, MQTT). Работает только при включённом брокере",
        default: "",
        placeholder: "wss://мой-брокер:8084/mqtt"
    },
    notifyLive: {
        type: OptionType.BOOLEAN,
        description: "Показывать уведомление, когда кто-то в голосовом канале начинает P2P-эфир",
        default: false
    },
    autoWatch: {
        type: OptionType.BOOLEAN,
        description: "Автоматически подключаться к P2P-эфиру (как у нативного стрима Discord)",
        default: false
    },
    discoverPings: {
        type: OptionType.BOOLEAN,
        description: "Служебный пинг «есть эфиры?» после входа в голос (идёт через брокер; в чат — только в фолбэке)",
        default: true
    },
    nativeTiles: {
        type: OptionType.BOOLEAN,
        description: "Показывать P2P-эфир в звонке как обычный стрим: плитка с LIVE, меткой P2P, превью и зрителями (экспериментально)",
        default: true,
        onChange: (v: boolean) => onNativeTilesChange?.(v)
    },
    showStats: {
        type: OptionType.BOOLEAN,
        description: "Показывать панель статистики (битрейт/FPS/задержка) в окне просмотра",
        default: true
    },
    stunServers: {
        type: OptionType.STRING,
        description: "STUN-серверы через запятую (помогают пробить NAT)",
        default: "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478",
        placeholder: "stun:stun.l.google.com:19302"
    },
    turnUrl: {
        type: OptionType.STRING,
        description: "Свой TURN-сервер — нужен только если P2P не подключается (симметричный NAT)",
        default: "",
        placeholder: "turn:host:port?transport=udp"
    },
    emergencyTurn: {
        type: OptionType.BOOLEAN,
        description: "Аварийный публичный TURN (openrelay.metered.ca): включается, только если прямое соединение не собирается. Трафик идёт через чужой сервер — медленнее; выключите, если добавили свой TURN",
        default: true
    },
    turnUser: {
        type: OptionType.STRING,
        description: "TURN username",
        default: ""
    },
    turnPassword: {
        type: OptionType.STRING,
        description: "TURN password",
        default: ""
    }
});

/** Применить пресет профиля к значениям настроек */
export function applyProfile(profile: Profile): void {
    if (profile === "games") {
        settings.store.resolution = "1080";
        settings.store.fps = "60";
        settings.store.videoBitrate = 30;
        settings.store.jitterBuffer = 0;
        settings.store.contentHint = "motion";
    } else if (profile === "movies") {
        settings.store.resolution = "1080";
        settings.store.fps = "60";
        settings.store.videoBitrate = 20;
        settings.store.jitterBuffer = 150;
        settings.store.contentHint = "detail";
    }
}
