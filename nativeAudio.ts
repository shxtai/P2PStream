/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Нативный звук приложения (v1.4, Windows 10 2004+).
 *
 * Main-процесс (native.ts) запускает встроенный хелпер p2paudio.exe —
 * WASAPI Process Loopback, тот же механизм, что использует сам Discord:
 *   - стримишь окно/приложение  -> звук только этого приложения;
 *   - стримишь весь экран       -> звук всей системы, КРОМЕ Discord.
 * PCM (float32 48k stereo) едет в рендерер пуллингом по IPC, собирается
 * AudioWorklet'ом в MediaStreamTrack и уходит в обычный WebRTC-поток.
 *
 * Если нативный звук недоступен (не Windows, старая система, хелпер упал) —
 * движок прозрачно использует системный loopback как раньше.
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("P2PStream:NativeAudio");

export type NativeAudioMode = "include-window" | "exclude-tree";

export interface NativeAudioHandle {
    /** Готовый аудиотрек для добавления в захваченный MediaStream */
    track: MediaStreamTrack;
    /** Остановить хелпер, пуллинг и AudioContext */
    stop(): void;
}

interface Helpers {
    startAudio(opts: { mode: string; id?: string }): Promise<{ ok: boolean; error?: string }>;
    pullAudio(): Promise<Uint8Array | null>;
    stopAudio(): Promise<void>;
}

function helpers(): Helpers | null {
    const h = (globalThis as any).VencordNative?.pluginHelpers?.P2PStream;
    if (!h?.startAudio || !h?.pullAudio || !h?.stopAudio) return null;
    return h as Helpers;
}

/** Доступен ли вообще канал нативного звука (Vesktop + main-часть плагина). */
export function nativeAudioAvailable(): boolean {
    return helpers() !== null;
}

/** AudioWorklet: кольцевой буфер PCM -> стереовыход. Код как строка (без сборочных файлов). */
const WORKLET_SRC = `
class VcP2pRing extends AudioWorkletProcessor {
    constructor() {
        super();
        this.cap = 48000 * 2 * 2;       /* 2 с стерео (float) */
        /* Под нагрузкой (игра) данные приходят рывками: то пусто 100+ мс, то сразу пачка.
           Раньше очередь > 200 мс обрезалась до 100 мс (слышимый пропуск), а после
           опустошения звук шёл крупицами (серия щелчков). Теперь: копим 80 мс перед
           стартом и после провала, обрезаем только накопления > 350 мс (до 150 мс). */
        this.prefill = 48000 * 2 * 0.08;
        this.maxLag = 48000 * 2 * 0.35;
        this.trimTo = 48000 * 2 * 0.15;
        this.buffering = true;
        this.buf = new Float32Array(this.cap);
        this.read = 0;
        this.count = 0;                 /* кол-во валидных float-значений */
        this.port.onmessage = e => {
            const d = e.data;
            if (!d || !d.length) return;
            const n = d.length - (d.length % 2); /* только целые стерео-кадры */
            for (let i = 0; i < n; i++) {
                if (this.count >= this.cap) {
                    /* переполнение: роняем самый старый КАДР (2 значения) — раньше
                       ронялось по одному, и левый/правый каналы менялись местами */
                    this.read = (this.read + 2) % this.cap;
                    this.count -= 2;
                }
                this.buf[(this.read + this.count) % this.cap] = d[i];
                this.count++;
            }
            if (this.count > this.maxLag) {
                const drop = (this.count - this.trimTo) & ~1;
                this.read = (this.read + drop) % this.cap;
                this.count -= drop;
            }
        };
    }
    process(_inputs, outputs) {
        const out = outputs[0];
        const L = out[0];
        const R = out[1] || out[0];
        const n = L.length;
        if (this.buffering && this.count >= this.prefill) this.buffering = false;
        if (!this.buffering && this.count < n * 2) this.buffering = true; /* провал: копим заново */
        for (let i = 0; i < n; i++) {
            if (!this.buffering && this.count >= 2) {
                L[i] = this.buf[this.read];
                R[i] = this.buf[(this.read + 1) % this.cap];
                this.read = (this.read + 2) % this.cap;
                this.count -= 2;
            } else {
                L[i] = 0;
                R[i] = 0;
            }
        }
        return true;
    }
}
registerProcessor("vc-p2p-ring", VcP2pRing);
`;

/** 20 мс: при 40 мс под нагрузкой игры забор опаздывал, и буфер ворклета пустел
 *  (пропадал звук). Запросы не идут внахлёст (флаг pulling), так что это дёшево. */
const PULL_INTERVAL_MS = 20;

/**
 * Запустить нативный звук. null — если недоступен (звука нет: рендерер
 * должен откатиться на системный loopback, который уже в захвате).
 */
export async function startNativeAudio(opts: { mode: NativeAudioMode; sourceId?: string }): Promise<NativeAudioHandle | null> {
    const Native = helpers();
    if (!Native) return null;

    try {
        const startRes = await Native.startAudio({ mode: opts.mode, id: opts.sourceId ?? "" });
        if (!startRes?.ok) {
            logger.info("Нативный звук недоступен:", startRes?.error ?? "нет ответа main-процесса");
            return null;
        }

        const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "balanced" });
        if (ctx.state === "suspended") {
            await ctx.resume().catch(() => { /* ignore */ });
        }

        const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "text/javascript" }));
        try {
            await ctx.audioWorklet.addModule(blobUrl);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }

        const node = new AudioWorkletNode(ctx, "vc-p2p-ring", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });
        const dest = ctx.createMediaStreamDestination();
        node.connect(dest);

        let stopped = false;
        let pulling = false; // запросы не внахлёст: иначе куски PCM могли прийти не по порядку
        const pullTimer = setInterval(() => {
            if (stopped || pulling) return;
            pulling = true;
            void (async () => {
                try {
                    const chunk = await Native.pullAudio();
                    if (!chunk || !chunk.length) return;
                    // одна копия байтов вместо поэлементного DataView (Windows/x64 — little-endian,
                    // как и формат хелпера); copy гарантирует выравнивание по 4
                    const f32 = new Float32Array(chunk.slice().buffer, 0, chunk.byteLength >> 2);
                    node.port.postMessage(f32, [f32.buffer]);
                } catch { /* main уже всё почистил — тишина */ } finally {
                    pulling = false;
                }
            })();
        }, PULL_INTERVAL_MS);

        const track = dest.stream.getAudioTracks()[0];
        if (!track) {
            stopped = true;
            clearInterval(pullTimer);
            node.disconnect();
            void ctx.close().catch(() => { /* ignore */ });
            void Native.stopAudio().catch(() => { /* ignore */ });
            return null;
        }

        logger.info("Нативный звук запущен:", opts.mode);
        return {
            track,
            stop() {
                if (stopped) return;
                stopped = true;
                clearInterval(pullTimer);
                try { track.stop(); } catch { /* ignore */ }
                try { node.disconnect(); } catch { /* ignore */ }
                void ctx.close().catch(() => { /* ignore */ });
                void Native.stopAudio().catch(() => { /* ignore */ });
                logger.info("Нативный звук остановлен");
            }
        };
    } catch (e) {
        logger.error("startNativeAudio:", e);
        try { await Native.stopAudio(); } catch { /* ignore */ }
        return null;
    }
}
