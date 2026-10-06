/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Авто-качество (v1.14): чистые функции решений — без Discord/WebRTC, покрыты
 * тестом (devtest/quality.test.js).
 *
 * Зачем: встроенный регулятор WebRTC (GCC) снижает битрейт по потерям лишь
 * после ~10%. На дальнем туннелированном канале (ZeroTier, обходы DPI) при
 * 2–8% потерь картинка «залипает»: кадр потерян -> зритель ждёт ключевой
 * (PLI) -> тяжёлый ключевой кадр снова теряется. Хост реагирует раньше и
 * мягче: снижает битрейт/разрешение конкретному зрителю, на чистом канале
 * плавно возвращает. Зритель при заморозках растит буфер (сглаживание).
 */

/** Замер с отправителя за интервал (~2 с) */
export interface SendSample {
    /** доля потерь по отчёту зрителя (0..1), null — нет данных */
    loss: number | null;
    /** запросов ключевого кадра (PLI) за интервал */
    pli: number;
    /** RTT, мс (null — нет данных) */
    rttMs: number | null;
    /** оценка пропускной способности канала от самого WebRTC (бит/с), null — нет */
    bweBps?: number | null;
    /** время замера, мс */
    now: number;
}

export interface SendState {
    /** текущий потолок битрейта, бит/с */
    capBps: number;
    /** сглаженные потери (EWMA) */
    lossEwma: number;
    /** с какого момента канал чистый (мс) */
    cleanSince: number;
    /** последнее снижение (мс) — не душим чаще раза в 2 с */
    lastCut: number;
    /** минимальный RTT за сессию (база для оценки очереди) */
    minRtt: number;
    /** потери в момент последнего снижения — помогло ли оно */
    lossAtCut: number;
    /** снижений подряд, после которых потери НЕ уменьшились */
    uselessCuts: number;
}

export const MIN_CAP_BPS = 1_500_000;

export function initSendState(userMaxBps: number, now: number): SendState {
    return { capBps: userMaxBps, lossEwma: 0, cleanSince: now, lastCut: 0, minRtt: Infinity, lossAtCut: 0, uselessCuts: 0 };
}

/**
 * Следующий потолок битрейта. Снижение — мультипликативное и быстрое (канал
 * «захлёбывается» прямо сейчас), рост — плавный и только после 10 с чистоты.
 */
/**
 * Итоговый потолок = min(потолок по потерям, 90% оценки канала WebRTC).
 * Реальный случай 1.15: в настройках 100 Мбит/с, канал ~36, энкодер выдавал 63 —
 * потери 15%, сотни NACK и заморозки. Потолки независимы: за оценкой канала идём
 * сразу (в т.ч. на старте, пока она разгоняется), а по потерям — режем быстро,
 * возвращаем осторожно (nextCap).
 */
export function effectiveCap(st: SendState, bweBps: number | null | undefined, userMaxBps: number): number {
    const bweCap = bweBps && bweBps > 0 ? Math.max(MIN_CAP_BPS, Math.round(bweBps * 0.9)) : Infinity;
    return Math.min(st.capBps, bweCap, userMaxBps);
}

export function nextCap(st: SendState, s: SendSample, userMaxBps: number): { state: SendState; reason: string | null; } {
    const next: SendState = { ...st };
    if (s.loss != null) next.lossEwma = st.lossEwma * 0.6 + s.loss * 0.4;
    if (s.rttMs != null && s.rttMs > 0) next.minRtt = Math.min(st.minRtt, s.rttMs);
    // рост очереди: RTT заметно выше минимального — канал переполнен, даже если потерь ещё нет
    const queueing = s.rttMs != null && Number.isFinite(next.minRtt) && s.rttMs > next.minRtt + 150 && s.rttMs > next.minRtt * 2;
    // Запросы ключевых кадров — признак перегрузки, только если есть и потери.
    // PLI при НУЛЕВЫХ потерях = декодер зрителя не справляется с потоком (реальный
    // случай: аппаратный H.264 AMD) — битрейт тут не поможет, это лечит смена
    // кодека (decodeTrouble ниже). Раньше такой «шторм» душил поток до 1.5 Мбит/с.
    const pliStorm = s.pli >= 2 && (s.loss ?? 0) >= 0.01;
    let lossy = next.lossEwma > 0.03;

    // Помогло ли прошлое снижение? Если потери не упали хотя бы на четверть —
    // они не от перегрузки (туннель/фильтр режет часть пакетов при любой скорости):
    // после двух таких «бесполезных» снижений по потерям больше не режем,
    // иначе задушили бы картинку до минимума без пользы.
    if (st.lastCut && s.now - st.lastCut >= 4000 && s.now - st.lastCut < 8000 && st.lossAtCut > 0) {
        next.uselessCuts = next.lossEwma >= st.lossAtCut * 0.75 ? st.uselessCuts + 1 : 0;
        next.lossAtCut = 0;
    }
    if (next.uselessCuts >= 2) lossy = false;

    if ((lossy || pliStorm || queueing) && (!st.lastCut || s.now - st.lastCut >= 4000)) {
        const factor = next.lossEwma > 0.1 || s.pli >= 4 ? 0.6 : 0.75;
        next.capBps = Math.max(MIN_CAP_BPS, Math.round(st.capBps * factor));
        next.lastCut = s.now;
        next.cleanSince = s.now;
        next.lossAtCut = lossy ? next.lossEwma : 0;
        const why = lossy ? `потери ${(next.lossEwma * 100).toFixed(1)}%` : pliStorm ? `запросы ключевых кадров ×${s.pli}` : `очередь (RTT ${Math.round(s.rttMs!)} мс)`;
        return { state: next, reason: next.capBps !== st.capBps ? why : null };
    }
    if (lossy || pliStorm || queueing) return { state: next, reason: null };

    if (next.lossEwma < 0.01) next.uselessCuts = 0;
    // чисто: после 10 с без проблем — +15% за шаг до пользовательского максимума
    if (next.lossEwma < 0.01 && s.now - st.cleanSince >= 10_000 && st.capBps < userMaxBps) {
        next.capBps = Math.min(userMaxBps, Math.round(st.capBps * 1.15));
        next.cleanSince = s.now;
        return { state: next, reason: "канал чистый" };
    }
    return { state: next, reason: null };
}

/**
 * Во сколько раз уменьшить разрешение при данном потолке битрейта, чтобы на
 * пиксель хватало бит (иначе энкодер выдаёт «кашу», а ключевые кадры огромные).
 * ~0.06 бит/пиксель/кадр — минимально прилично для экрана/игр (H.264/VP9).
 */
export function scaleFor(capBps: number, height: number, width: number, fps: number): number {
    if (!height || !width || !fps) return 1;
    const needBps = width * height * fps * 0.06;
    if (capBps >= needBps) return 1;
    // площадь пропорциональна битрейту -> сторона пропорциональна sqrt
    const k = Math.sqrt(needBps / capBps);
    // не ниже 540p и ступенями (1 / 1.333 / 1.5 / 2 / ...) — меньше переключений
    const steps = [1, 4 / 3, 1.5, 2, 2.667, 3, 4];
    const maxK = Math.max(1, height / 540);
    return steps.find(x => x >= k && x <= maxK) ?? Math.min(maxK, steps[steps.length - 1]);
}

/**
 * Счётчик «декодер не справляется»: интервалы подряд, где зритель просит
 * ключевые кадры (PLI ≥ 2 за 2 с), а потерь нет. ≥ DECODE_TROUBLE_LIMIT —
 * пора менять кодек этому зрителю.
 */
export const DECODE_TROUBLE_LIMIT = 3;

export function nextDecodeTrouble(count: number, s: { pli: number; loss: number | null; nack?: number; }): number {
    // NACK = зритель недосчитался пакетов: это сеть, а не декодер
    return s.pli >= 2 && (s.loss ?? 0) < 0.01 && (s.nack ?? 0) <= 2 ? count + 1 : 0;
}

/**
 * Счётчик «энкодер завис»: захват подаёт кадры (≥10 за интервал), а энкодер
 * выпускает ≤10% из них. Реальный случай: аппаратный H.264 AMD через Media
 * Foundation иногда «встаёт» — 0–1 FPS при живом захвате. По времени
 * захвата отличаем от статичного экрана (там кадров не подаётся вовсе).
 */
export function nextEncoderStall(count: number, s: { srcFrames: number; encFrames: number; }): number {
    return s.srcFrames >= 10 && s.encFrames <= s.srcFrames * 0.1 ? count + 1 : 0;
}

/** Следующий кодек при сбое декодирования: от «тяжёлого/капризного» к самому совместимому */
export function fallbackCodec(current: string, tried: string[]): string | null {
    const chain = ["vp9", "vp8", "h264"];
    return chain.find(c => c !== current && !tried.includes(c)) ?? null;
}

/**
 * Стабилизатор FPS. Когда энкодер упирается в процессор (игра + программный VP9),
 * WebRTC выкидывает кадры неравномерно — FPS скачет 35–60, глазу это «рваные
 * кадры». Ровные 48 или 30 смотрятся плавнее. Шаг вниз — после 3 интервалов
 * подряд с cpu-ограничением и FPS < 85% цели; шаг вверх — после 30 с без
 * ограничения и не раньше чем через 60 с после последнего шага вниз.
 */
export interface FpsState {
    capFps: number;
    /** интервалов подряд «не тянет» */
    strain: number;
    /** с какого момента энкодеру легко */
    easySince: number;
    lastDown: number;
}

export function initFpsState(userFps: number, now: number): FpsState {
    return { capFps: userFps, strain: 0, easySince: now, lastDown: 0 };
}

/** Минимальный FPS, ниже которого авто-качество не опускается (если в настройках не меньше) */
export const MIN_FPS = 60;

export function fpsSteps(userFps: number): number[] {
    // ниже 60 не уходим: при нехватке процессора/бит WebRTC в режиме «Игры»
    // сохраняет FPS и снижает разрешение — это и нужно для игр
    if (userFps <= MIN_FPS) return [userFps];
    return [...new Set([userFps, 144, 120, 90, MIN_FPS].filter(f => f <= userFps && f >= MIN_FPS))].sort((a, b) => b - a);
}

/**
 * FPS выше 60 — только когда хватает бит на кадр. Битрейт делится на все кадры:
 * 50 Мбит/с при 110 FPS в 1440p — ~0.11 бит/пиксель/кадр, и в быстрых сценах
 * картинка «мылится»; при 60 FPS бит на кадр почти вдвое больше. Порог ~0.16
 * бит/пиксель/кадр (с гистерезисом: подняться — от 0.19), иначе держим 60.
 */
export const BPP_HIGH_FPS = 0.16;
export const BPP_HIGH_FPS_UP = 0.19;

export function qualityFpsCap(prevCap: number, capBps: number, width: number, height: number, userFps: number): number {
    const steps = fpsSteps(userFps);
    if (!width || !height || steps.length === 1) return steps[0];
    const bpp = (fps: number) => capBps / (width * height * fps);
    for (const f of steps) {
        if (f <= MIN_FPS) return f;
        const need = f > prevCap ? BPP_HIGH_FPS_UP : BPP_HIGH_FPS; // выше текущего — с запасом
        if (bpp(f) >= need) return f;
    }
    return steps[steps.length - 1];
}

export function nextFpsCap(st: FpsState, s: { encFps: number; cpuLimited: boolean; now: number; }, userFps: number): { state: FpsState; reason: string | null; } {
    const steps = fpsSteps(userFps);
    const next: FpsState = { ...st };
    if (st.capFps > userFps) next.capFps = userFps;
    const idx = Math.max(0, steps.indexOf(next.capFps));
    if (s.cpuLimited && s.encFps < next.capFps * 0.85) {
        next.strain = st.strain + 1;
        next.easySince = s.now;
        if (next.strain >= 3 && idx < steps.length - 1) {
            next.capFps = steps[idx + 1];
            next.strain = 0;
            next.lastDown = s.now;
            return { state: next, reason: `энкодер упирается в процессор (${Math.round(s.encFps)} FPS из ${st.capFps}) — ставлю ровные ${next.capFps}` };
        }
        return { state: next, reason: null };
    }
    next.strain = 0;
    if (s.cpuLimited) { next.easySince = s.now; return { state: next, reason: null }; }
    if (idx > 0 && s.now - next.easySince >= 30_000 && s.now - st.lastDown >= 60_000) {
        next.capFps = steps[idx - 1];
        next.easySince = s.now;
        return { state: next, reason: `процессор свободен — пробую ${next.capFps} FPS` };
    }
    return { state: next, reason: null };
}

/** Замер со стороны зрителя за интервал */
export interface RecvSample {
    /** новых заморозок за интервал */
    freezes: number;
    /** джиттер, мс */
    jitterMs: number;
    now: number;
}

export interface RecvState {
    targetMs: number;
    calmSince: number;
}

export const MAX_JITTER_TARGET_MS = 300;

/**
 * Адаптивный буфер зрителя: при заморозках/скачках задержки — +50 мс (до 300),
 * после 20 с спокойствия — −25 мс до минимума пользователя.
 */
export function nextJitterTarget(st: RecvState, s: RecvSample, userMinMs: number): RecvState {
    const rough = s.freezes > 0 || s.jitterMs > 30;
    if (rough) {
        const want = Math.max(st.targetMs + 50, Math.min(MAX_JITTER_TARGET_MS, Math.round(s.jitterMs * 3)));
        return { targetMs: Math.min(MAX_JITTER_TARGET_MS, want), calmSince: s.now };
    }
    if (s.now - st.calmSince >= 20_000 && st.targetMs > userMinMs) {
        return { targetMs: Math.max(userMinMs, st.targetMs - 25), calmSince: s.now };
    }
    return st;
}
