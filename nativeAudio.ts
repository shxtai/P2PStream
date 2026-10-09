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

import { toast } from "./utils";

const logger = new Logger("P2PStream:NativeAudio");

export type NativeAudioMode = "include-window" | "exclude-tree";

export interface NativeAudioHandle {
    /** Готовый аудиотрек для добавления в захваченный MediaStream */
    track: MediaStreamTrack;
    /** Остановить хелпер, пуллинг и AudioContext */
    stop(): void;
    /** Диагностика для /p2p-doctor (v1.20) */
    stats(): NativeAudioStats;
}

export interface NativeAudioStats {
    /** текущий уровень кольцевого буфера, мс */
    levelMs: number;
    /** сколько раз хелпер перезапускался вотчдогом */
    restarts: number;
    /** main-процесс сообщил о смерти хелпера */
    dead: boolean;
    /** хелпер перестал присылать данные, мс */
    silenceMs: number;
    /** активный режим (окно/система — может смениться фолбэком) */
    mode: NativeAudioMode;
}

interface Helpers {
    startAudio(opts: { mode: string; id?: string }): Promise<{ ok: boolean; error?: string }>;
    pullAudio(): Promise<Uint8Array | null>;
    stopAudio(): Promise<void>;
    audioStatus?(): Promise<{ dead?: boolean; hasProc?: boolean }>;
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
           Копим 120 мс перед стартом и после провала, обрезаем накопления > 350 мс
           (до 240 мс), а дрейф-коррекция ниже держит рабочий уровень ~200 мс —
           его хватает на рывки рендерера, и он больше не растёт без предела. */
        this.prefill = 48000 * 2 * 0.12;
        this.maxLag = 48000 * 2 * 0.35;
        this.trimTo = 48000 * 2 * 0.24;
        /* v1.20 дрейф-коррекция: часы хелпера (устройство захвата) и AudioContext
           (устройство вывода) расходятся на 10–100 ppm — буфер без коррекции
           медленно ползёт вверх/вниз, звук уезжает от картинки минутами.
           Держим уровень около 200 мс: коррекция ±1–2 кадра на блок —
           неслышно, рассинхрон исчезает, а запас переживает рывки
           рендерера под нагрузкой игры (до 180 мс). */
        this.target = 48000 * 2 * 0.20;
        this.levelMs = 0;
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
        /* v1.20 дрейф-коррекция уровня буфера (после отдачи блока):
           перелив — выбрасываем 1–2 кадра из головы, недлив — дублируем
           последний кадр. Ошибка делится на 240 блоков/с — плавно и неслышно */
        if (!this.buffering) {
            let corr = Math.round((this.count - this.target) / 2 / 240);
            if (corr > 2) corr = 2;
            if (corr < -2) corr = -2;
            if (corr > 0 && this.count >= corr * 2) {
                this.read = (this.read + corr * 2) % this.cap;
                this.count -= corr * 2;
            } else if (corr < 0 && this.count >= 2) {
                for (let k = 0; k < -corr && this.count + 2 <= this.cap; k++) {
                    this.buf[(this.read + this.count) % this.cap] = this.buf[(this.read + this.count - 2 + this.cap) % this.cap];
                    this.buf[(this.read + this.count + 1) % this.cap] = this.buf[(this.read + this.count - 1 + this.cap) % this.cap];
                    this.count += 2;
                }
            }
            this.levelMs = Math.round(this.count / 2 / 48);
        }
        return true;
    }
}
registerProcessor("vc-p2p-ring", VcP2pRing);
`;

/** 20 мс: при 40 мс под нагрузкой игры забор опаздывал, и буфер ворклета пустел
 *  (пропадал звук). Запросы не идут внахлёст (флаг pulling), так что это дёшево. */
const PULL_INTERVAL_MS = 20;
/** вотчдог: как часто проверяем здоровье хелпера */
const WATCHDOG_MS = 2000;
/** тишина (нет данных из main), после которой хелпер считается зависшим:
 *  для окон — 12 с (приложение закрыли, WASAPI-loopback молчит навсегда),
 *  для системы — 25 с (полная тишина в системе бывает, но редко) */
const SILENCE_RESTART_MS = { "include-window": 12_000, "exclude-tree": 25_000 } as const;
/** предельное число быстрых перезапусков подряд, прежде чем сменить режим */
const MAX_FAST_RESTARTS = 3;

/**
 * Запустить нативный звук. null — если недоступен (звука нет: рендерер
 * должен откатиться на системный loopback, который уже в захвате).
 */
export async function startNativeAudio(opts: { mode: NativeAudioMode; sourceId?: string }): Promise<NativeAudioHandle | null> {
    const Native = helpers();
    if (!Native) return null;

    const st = {
        levelMs: 0,
        restarts: 0,
        dead: false,
        silenceMs: 0,
        mode: opts.mode
    };
    let stopped = false;
    let mode = opts.mode;
    let sourceId = opts.sourceId;
    let lastDataAt = Date.now();

    const startHelper = async (): Promise<boolean> => {
        try {
            const startRes = await Native.startAudio({ mode, id: sourceId ?? "" });
            if (!startRes?.ok) {
                logger.info("Нативный хелпер не стартовал:", startRes?.error ?? "нет ответа main-процесса");
                return false;
            }
            lastDataAt = Date.now();
            st.dead = false;
            return true;
        } catch (e) {
            logger.info("Нативный хелпер не стартовал:", e);
            return false;
        }
    };

    try {
        if (!(await startHelper())) return null;

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
                    // буфер с дрейф-коррекцией сам держит латентность — при явном переливе не подкармливаем
                    if (st.levelMs > 300) return;
                    const chunk = await Native.pullAudio();
                    if (!chunk || !chunk.length) return;
                    lastDataAt = Date.now();
                    // одна копия байтов вместо поэлементного DataView (Windows/x64 — little-endian,
                    // как и формат хелпера); copy гарантирует выравнивание по 4
                    const f32 = new Float32Array(chunk.slice().buffer, 0, chunk.byteLength >> 2);
                    node.port.postMessage(f32, [f32.buffer]);
                } catch { /* main уже всё почистил — тишина */ } finally {
                    pulling = false;
                }
            })();
        }, PULL_INTERVAL_MS);

        // Вотчдог (v1.20): хелпер умер или завис без данных — перезапускаем автоматически.
        // Без него звук «пропадал до конца эфира» при закрытии окна игры/смене устройства:
        // main после смерти хелпера чистит очередь, и pullAudio возвращает null вечно.
        let fastRestarts = 0;
        let lastRestartAt = 0;
        const watchdog = setInterval(() => {
            if (stopped) return;
            void (async () => {
                try {
                    const status = await Native.audioStatus?.().catch(() => null);
                    const dead = status?.dead === true || (status?.hasProc === false);
                    st.dead = dead;
                    st.silenceMs = Date.now() - lastDataAt;
                    const silenceLimit = SILENCE_RESTART_MS[mode];
                    if (!dead && st.silenceMs < silenceLimit) return;

                    if (dead) logger.info("Вотчдог: хелпер мёртв — перезапускаю");
                    else logger.info(`Вотчдог: тишина из main ${Math.round(st.silenceMs / 1000)} с (лимит ${silenceLimit / 1000} с) — перезапускаю`);

                    const now = Date.now();
                    fastRestarts = now - lastRestartAt < 60_000 ? fastRestarts + 1 : 1;
                    lastRestartAt = now;

                    // окно/приложение закрыли — звука этого приложения больше нет,
                    // фолбэк на всю систему честнее, чем тишина
                    if (mode === "include-window" && fastRestarts > MAX_FAST_RESTARTS) {
                        mode = "exclude-tree";
                        sourceId = undefined;
                        st.mode = mode;
                        fastRestarts = 0;
                        toast("Звук приложения недоступен — переключаюсь на звук системы", "critical");
                    }

                    if (await startHelper()) st.restarts++;
                } catch { /* ignore */ }
            })();
        }, WATCHDOG_MS);

        const track = dest.stream.getAudioTracks()[0];
        if (!track) {
            stopped = true;
            clearInterval(pullTimer);
            clearInterval(watchdog);
            node.disconnect();
            void ctx.close().catch(() => { /* ignore */ });
            void Native.stopAudio().catch(() => { /* ignore */ });
            return null;
        }

        logger.info("Нативный звук запущен:", opts.mode, "(v1.20: дрейф-коррекция + вотчдог)");
        return {
            track,
            stats(): NativeAudioStats {
                return {
                    levelMs: st.levelMs,
                    restarts: st.restarts,
                    dead: st.dead,
                    silenceMs: st.silenceMs,
                    mode: st.mode
                };
            },
            stop() {
                if (stopped) return;
                stopped = true;
                clearInterval(pullTimer);
                clearInterval(watchdog);
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
