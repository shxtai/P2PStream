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

import { AUDIO_WS_WORKER_SRC } from "./audioWsWorker";
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
    /** усреднённый уровень (~5 с) — по нему зрители сдвигают видео: мгновенный
     *  скакал 180–290 мс между анонсами, и сдвиг видео «плавал» */
    avgMs: number;
    /** провалы доставки (данные застряли между хелпером и ворклетом) с начала эфира */
    underruns: number;
    /** паузы источника (в системе было тихо — хелпер ничего не слал) */
    srcPauses: number;
    /** звук идёт напрямую main → Worker → ворклет (true) или опросом через главный поток */
    direct: boolean;
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
    audioStream?(): Promise<{ port: number; token: string } | null>;
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
        this.prefill = 48000 * 2 * 0.08;
        this.maxLag = 48000 * 2 * 0.35;
        this.trimTo = 48000 * 2 * 0.24;
        /* v1.20 дрейф-коррекция: часы хелпера (устройство захвата) и AudioContext
           (устройство вывода) расходятся на 10–100 ppm — буфер без коррекции
           медленно ползёт вверх/вниз, звук уезжает от картинки минутами.
           Держим уровень около 200 мс: коррекция ±1–2 кадра на блок —
           неслышно, рассинхрон исчезает, а запас переживает рывки
           рендерера под нагрузкой игры (до 180 мс). */
        this.target = 48000 * 2 * 0.20;
        /* (1.23.16) АДАПТИВНЫЙ запас, как jitter buffer в самом WebRTC: стартуем с
           минимума и растём только после реального провала, без провалов —
           медленно сжимаемся. Без игры рывков нет — звук (а с ним и видео, которое
           ждёт звук) идёт с задержкой ~80 мс вместо постоянных 200; под игрой после
           первых провалов запас вырастает до прежнего уровня. */
        this.minT = 48000 * 2 * 0.08;
        this.maxT = 48000 * 2 * 0.24;
        this.calm = 0;
        this.setTarget(this.minT);
        this.levelMs = 0;
        this.reportTick = 0;
        this.buffering = true;
        this.buf = new Float32Array(this.cap);
        this.read = 0;
        this.count = 0;                 /* кол-во валидных float-значений */
        this.judge = false;
        this.gapBlocks = 0;
        /* решение «застряло / источник молчал» — по сумме данных за ~10 мс после
           возврата: застрявшее приходит пачкой, иногда несколькими сообщениями подряд */
        this.judgeLeft = -1;
        this.judgeFrames = 0;
        const onData = e => {
            const d = e.data;
            if (!d || !d.length) return;
            const n = d.length - (d.length % 2); /* только целые стерео-кадры */
            if (this.judge) {
                this.judgeFrames += n / 2;
                if (this.judgeLeft < 0) this.judgeLeft = 4;
            }
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
        /* (1.23.23) данные идут либо из главного потока (опрос), либо напрямую из
           Worker через присланный MessagePort — мимо главного потока окна */
        this.port.onmessage = e => {
            if (e.data && e.data.port) { e.data.port.onmessage = onData; return; }
            onData(e);
        };
    }
    setTarget(t) {
        this.target = Math.max(this.minT, Math.min(this.maxT, t));
        /* после провала копим сразу до рабочего уровня (иначе дрейф-коррекция
           набирала бы его секундами); перелив режем выше target + 150 мс */
        this.prefill = this.target;
        /* (1.23.20) жёсткая обрезка — только при крайнем переливе (+200 мс): каждая
           обрезка = слышимый пропуск звука, а при +80 мс (1.23.18) после каждого рывка
           рендерера звук «херовил». Умеренный перелив сдувает дрейф-коррекция ниже
           (±2 кадра на блок — неслышно), теперь чуть быстрее (до ±3). */
        this.maxLag = this.target + 48000 * 2 * 0.20;
        this.trimTo = this.target + 48000 * 2 * 0.06;
    }
    process(_inputs, outputs) {
        const out = outputs[0];
        const L = out[0];
        const R = out[1] || out[0];
        const n = L.length;
        if (this.buffering && this.count >= this.prefill) this.buffering = false;
        if (!this.buffering && this.count < n * 2) {
            /* провал: копим заново. Запас (+50 мс) растёт, только если данные потом
               пришли ПАЧКОЙ — значит, застряли по дороге (рендерер/main). Хелпер
               молчит, когда в системе тишина (WASAPI не шлёт пакетов), — тогда
               вернутся маленьким куском, и задержку не трогаем (1.23.22: «провалов 25»
               раздували буфер до максимума, а с ним и сдвиг видео у зрителя). */
            this.buffering = true;
            this.judge = true;
            this.gapBlocks = 0;
            this.judgeLeft = -1;
            this.judgeFrames = 0;
        }
        if (this.judge) {
            if (this.judgeLeft < 0) this.gapBlocks++;
            else if (--this.judgeLeft <= 0) {
                this.judge = false;
                this.judgeLeft = -1;
                const gapFrames = this.gapBlocks * 128;
                const gapMs = Math.round(gapFrames / 48);
                if (this.judgeFrames >= gapFrames * 0.5 || gapFrames < 48000 * 0.05) {
                    this.setTarget(this.target + 48000 * 2 * 0.05);
                    this.calm = 0;
                    this.port.postMessage({ u: 1, ms: gapMs });
                } else {
                    this.port.postMessage({ p: 1, ms: gapMs });
                }
            }
        }
        /* 20 с без провалов — сжимаемся на 10 мс, дальше каждые 5 с (375 блоков/с) */
        if (++this.calm >= 375 * 20 && this.target > this.minT) {
            this.setTarget(this.target - 48000 * 2 * 0.01);
            this.calm = 375 * 15;
        }
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
            if (corr > 3) corr = 3;
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
        /* уровень буфера наружу (~раз в 100 мс): по нему зрители задерживают видео
           под звук, и его показывает /p2p-doctor (раньше там всегда было 0 мс) */
        if (++this.reportTick >= 38) {
            this.reportTick = 0;
            this.port.postMessage(this.buffering ? 0 : this.levelMs);
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
        avgMs: 0,
        underruns: 0,
        srcPauses: 0,
        direct: false,
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
        node.port.onmessage = e => {
            if (e.data && typeof e.data === "object") {
                const now = Date.now();
                if (e.data.u) {
                    st.underruns++;
                    // в лог — не чаще раза в 20 с (по нему видно, где рвётся звук)
                    if (now - lastStallLog > 20_000) {
                        lastStallLog = now;
                        logger.info(`Звук: данные от захвата не приходили ${e.data.ms} мс (застряли по дороге) — запас буфера +50 мс; всего таких ${st.underruns}`);
                    }
                } else if (e.data.p) st.srcPauses++;
                return;
            }
            if (typeof e.data !== "number") return;
            st.levelMs = e.data;
            // ~10 замеров/с: постоянная времени ~5 с; провалы (0 = копим заново) не тянут вниз
            if (e.data > 0) st.avgMs = st.avgMs ? st.avgMs * 0.98 + e.data * 0.02 : e.data;
        };

        let lastStallLog = 0;
        // (1.23.23) прямая доставка: main → WebSocket → Worker → ворклет (главный поток
        // окна Discord не участвует; его зависания на 250+ мс и давали провалы звука)
        let worker: Worker | null = null;
        let workerUrl = "";
        const stopWorker = () => {
            try { worker?.postMessage({ stop: 1 }); } catch { /* ignore */ }
            try { worker?.terminate(); } catch { /* ignore */ }
            worker = null;
            if (workerUrl) URL.revokeObjectURL(workerUrl);
            workerUrl = "";
            st.direct = false;
        };
        try {
            const ep = await Native.audioStream?.();
            if (ep?.port && ep.token) {
                const ch = new MessageChannel();
                node.port.postMessage({ port: ch.port2 }, [ch.port2]);
                workerUrl = URL.createObjectURL(new Blob([AUDIO_WS_WORKER_SRC], { type: "text/javascript" }));
                worker = new Worker(workerUrl);
                let announced = false;
                worker.onmessage = e => {
                    const d = e.data ?? {};
                    if (d.open) {
                        st.direct = true;
                        if (!announced) logger.info("Звук: прямая доставка из main-процесса (мимо главного потока окна)");
                        announced = true;
                    }
                    if (d.closed) st.direct = false;
                    if (d.beat) lastDataAt = Date.now();
                };
                worker.onerror = e => {
                    logger.info("Звук: Worker прямой доставки упал — остаётся опрос:", (e as ErrorEvent).message ?? e);
                    stopWorker();
                };
                worker.postMessage({ url: `ws://127.0.0.1:${ep.port}/${ep.token}`, port: ch.port1 }, [ch.port1]);
            }
        } catch (e) {
            logger.info("Звук: прямая доставка недоступна — остаётся опрос:", e);
            stopWorker();
        }
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
            stopWorker();
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
                    avgMs: Math.round(st.avgMs),
                    underruns: st.underruns,
                    srcPauses: st.srcPauses,
                    direct: st.direct,
                    restarts: st.restarts,
                    dead: st.dead,
                    silenceMs: st.silenceMs,
                    mode: st.mode
                };
            },
            stop() {
                if (stopped) return;
                stopped = true;
                stopWorker();
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
