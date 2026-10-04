/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { settings } from "./settings";

const logger = new Logger("P2PStream:Capture");

export interface P2PSourceInfo {
    id: string;
    name: string;
    thumb: string | null;
    isScreen: boolean;
}

export interface CaptureOptions {
    fps: number;
    /** Целевая высота; null/undefined — родное разрешение источника */
    height?: number | null;
    /** Пытаться ли захватить системный звук */
    audio: boolean;
}

/**
 * Источники через main-процесс Vesktop (нативный канал плагина).
 * Возвращает null, если канал недоступен (веб-версия, старый Vencord и т.п.).
 */
export async function listSources(): Promise<P2PSourceInfo[] | null> {
    try {
        const helpers = (globalThis as any).VencordNative?.pluginHelpers?.P2PStream;
        if (!helpers?.getSources) return null;
        const res: unknown = await helpers.getSources(384, 216);
        return Array.isArray(res) ? (res as P2PSourceInfo[]) : null;
    } catch (e) {
        logger.debug("listSources:", e);
        return null;
    }
}

function legacyConstraints(sourceId: string, opts: CaptureOptions, withAudio: boolean): any {
    const video: any = {
        mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            maxFrameRate: Math.max(1, Math.min(480, opts.fps)),
            maxWidth: 4096,
            maxHeight: 4096
        }
    };
    if (opts.height) {
        video.mandatory.maxHeight = opts.height;
        video.mandatory.maxWidth = Math.round(opts.height * (21 / 9)); // ультраширокие тоже влезают
    }
    if (!withAudio) return { video, audio: false };

    return {
        video,
        audio: {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: sourceId
            }
        }
    };
}

/**
 * Прямой захват источника через Electron (getUserMedia + chromeMediaSource),
 * минуя чужие пикеры. Пробует варианты «со звуком» и «без» — возвращает null при полном провале.
 */
export async function captureDesktopSource(sourceId: string, opts: CaptureOptions): Promise<MediaStream | null> {
    const gUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    const attempts: Array<[string, any]> = [];
    if (opts.audio) {
        attempts.push(["video+audio", legacyConstraints(sourceId, opts, true)]);
    }
    attempts.push(["video", legacyConstraints(sourceId, opts, false)]);

    for (const [label, constraints] of attempts) {
        try {
            const stream = await gUM(constraints);
            logger.info(`Захват (${label}) ok:`, stream.getVideoTracks()[0]?.label);
            return stream;
        } catch (e: any) {
            logger.debug(`Захват (${label}) не удался:`, e?.name ?? e);
        }
    }
    return null;
}

/** Живое применение FPS/высоты к треку (работает и для легаси-захвата, и для gdm) */
export async function liveApplyTrackConstraints(track: MediaStreamTrack): Promise<void> {
    const fps = Number(settings.store.fps) || 60;
    const res = String(settings.store.resolution);
    const constraints: MediaTrackConstraints = {
        frameRate: { ideal: fps, max: 480 }
    };
    if (res !== "native") constraints.height = { ideal: Number(res) };
    try {
        await track.applyConstraints(constraints);
    } catch (e) {
        logger.debug("applyConstraints:", e);
    }
}
