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
    /** зритель недополучает кадры / замирает (его обратная связь, см. viewerStarved) */
    viewerStall?: boolean;
    /** текущий реальный потолок отправки, бит/с: урезаем от него, а не от настроек */
    curBps?: number;
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
    /** до этого момента не растём (после среза из-за заморозок у зрителя) */
    holdUntil?: number;
    /** лучшая скорость, реально прошедшая чисто в этом сеансе (бит/с): к ней возвращаемся быстро */
    bestClean?: number;
    /** скорость, на которой последний раз начались потери/очередь: возле неё растём осторожно */
    troubleAt?: number;
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

/**
 * Потолок ДЛЯ ЭНКОДЕРА (maxBitrate). В отличие от effectiveCap (по нему выбирается
 * разрешение) на чистом канале он на 60% ВЫШЕ оценки WebRTC: повышение maxBitrate
 * заставляет WebRTC сразу прозондировать канал на новом уровне, и оценка растёт
 * скачками ×1.6 раз в 2 с. Раньше maxBitrate = 90% оценки: WebRTC не пробовал выше
 * потолка, оценка ползла ~8%/с — до 30 Мбит/с полминуты «мыла» на старте.
 * Есть потери/срез — как раньше, 90% оценки (случай 1.15: энкодер выше канала → потери).
 */
export function sendCap(st: SendState, bweBps: number | null | undefined, userMaxBps: number, clean: boolean): number {
    if (!bweBps || bweBps <= 0) return Math.min(st.capBps, userMaxBps);
    const bweCap = Math.max(MIN_CAP_BPS, Math.round(bweBps * (clean ? 1.6 : 0.9)));
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
    // Малые потери (< 5%) без запросов ключевых кадров WebRTC сам восстанавливает
    // повторной отправкой — картинка не страдает, резать нечего. Раньше порог был 3%,
    // и на дальнем канале поток дёргался 80 → 40 Мбит/с из-за неопасных потерь.
    let lossy = next.lossEwma > 0.05 || (next.lossEwma > 0.02 && s.pli >= 1);

    // Помогло ли прошлое снижение? Если потери не упали хотя бы на четверть —
    // они не от перегрузки (туннель/фильтр режет часть пакетов при любой скорости):
    // после двух таких «бесполезных» снижений по потерям больше не режем,
    // иначе задушили бы картинку до минимума без пользы.
    if (st.lastCut && s.now - st.lastCut >= 4000 && s.now - st.lastCut < 8000 && st.lossAtCut > 0) {
        next.uselessCuts = next.lossEwma >= st.lossAtCut * 0.75 ? st.uselessCuts + 1 : 0;
        next.lossAtCut = 0;
    }
    if (next.uselessCuts >= 2) lossy = false;

    // (1.23.13) Зритель недополучает кадры или замирает — это перегрузка, даже если
    // потери «всего» 0.3%: реальный лог — отправлено 58 FPS, собрано 29, показано 9,
    // 5 заморозок за минуту; на VPN с RTT 100 мс каждый потерянный пакет держит кадр
    // до повторной пересылки. Порог потерь (2–5%) этого не ловил.
    const stall = !!s.viewerStall;
    if ((lossy || pliStorm || queueing || stall) && (!st.lastCut || s.now - st.lastCut >= 4000)) {
        // резко — только при реально плохом канале, иначе мягко
        const factor = next.lossEwma > 0.15 || (pliStorm && s.pli >= 4) ? 0.6 : 0.8;
        // режем от реальной скорости: потолок мог стоять на 100 Мбит/с из настроек при
        // фактических 31 — тогда пять срезов подряд ничего не меняли (~20 с заморозок)
        // (1.23.15) но только если поток реально идёт: на статике шлётся ~0.1 Мбит/с,
        // и срез «от реальной» ронял потолок сразу на минимум 1.5 Мбит/с
        const base = s.curBps && s.curBps >= 2 * MIN_CAP_BPS ? Math.min(st.capBps, s.curBps) : st.capBps;
        next.capBps = Math.max(MIN_CAP_BPS, Math.round(base * factor));
        if (lossy || pliStorm || queueing) next.troubleAt = base;
        next.lastCut = s.now;
        next.cleanSince = s.now;
        next.lossAtCut = lossy ? next.lossEwma : 0;
        if (stall && !lossy && !pliStorm && !queueing) next.holdUntil = s.now + 8_000;
        const why = lossy ? `потери ${(next.lossEwma * 100).toFixed(1)}%` : pliStorm ? `запросы ключевых кадров ×${s.pli}` : queueing ? `очередь (RTT ${Math.round(s.rttMs!)} мс)` : "зритель недополучает кадры / замирает";
        return { state: next, reason: next.capBps !== st.capBps ? why : null };
    }
    if (lossy || pliStorm || queueing || stall) return { state: next, reason: null };
    if (st.holdUntil && s.now < st.holdUntil) return { state: next, reason: null };

    if (next.lossEwma < 0.01) next.uselessCuts = 0;
    // чисто: после 10 с без проблем — +15% за шаг до пользовательского максимума
    // возврат: после 6 с чистого канала +20% каждые 4 с (было +15% раз в 10 с —
    // с 40 обратно до 80 Мбит/с уходила почти минута)
    // (1.23.14) Растём, только если поток реально упирается в потолок. На статичной
    // картинке энкодеру нечего слать, канал «чистый» — и потолок раньше разгонялся до
    // 58 Мбит/с при реальных ~35 у VPN; на смене кадра энкодер выстреливал на весь
    // потолок: «собирает 0 из 59 FPS», потери, заикался и звук.
    const used = s.curBps == null || s.curBps >= st.capBps * 0.6;
    // запоминаем, сколько реально прошло чисто
    if (s.curBps && next.lossEwma < 0.01) next.bestClean = Math.max(st.bestClean ?? 0, s.curBps);
    // (1.23.15) рост быстрее: +25% каждые 2 с (раньше +20% раз в 4–6 с — с 1.5 до 12 Мбит/с
    // уходила минута, а сама оценка WebRTC растёт ~8%/с и упирается в наш потолок);
    // ниже уже проверенного в сеансе уровня — сразу ×1.5 («ретест с поднятием»)
    if (used && next.lossEwma < 0.02 && s.now - st.cleanSince >= 2_000 && st.capBps < userMaxBps) {
        const below = (next.bestClean ?? 0) > 0 && st.capBps < next.bestClean! * 0.7;
        // возле скорости, где недавно (≤ 60 с) были потери, — осторожно (+10%), иначе перескок
        const nearTrouble = !!st.troubleAt && st.lastCut > 0 && s.now - st.lastCut < 60_000 && st.capBps * 1.25 > st.troubleAt * 0.9;
        next.capBps = Math.min(userMaxBps, Math.round(st.capBps * (below && !nearTrouble ? 1.5 : nearTrouble ? 1.1 : 1.25)));
        next.cleanSince = s.now;
        return { state: next, reason: below ? "канал чистый — возвращаюсь к проверенной скорости" : "канал чистый" };
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
export function fallbackCodec(current: string, tried: string[], available?: string[]): string | null {
    // (1.23.11) сначала H.265: кодируется и декодируется на видеокартах, как H.264,
    // а программный VP9 (libvpx) на 1080p60 не тянул процессор — реальный лог: после
    // сбоя H.264 картинка скатилась до 720p@45. VP9/VP8 — дальше, если H.265 нет.
    const chain = ["h265", "vp9", "vp8", "h264"].filter(c => !available || available.includes(c));
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
    // ступени ВЫШЕ 60 (144/120/90); снижение до 45/30 — в лестнице качества (buildLadder)
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

/**
 * ЛЕСТНИЦА КАЧЕСТВА (v1.18): разрешение и FPS выбираются вместе — самая
 * качественная ступень, на которую хватает битрейта. Раньше это решали два
 * независимых правила с разными порогами, и можно было получить «480p при
 * 240 FPS» или «1440p, но мыло». Ступени: родное@высокий FPS → родное@60 →
 * 1440p@60 → 1080p@60 → 900p@60 → 720p@60. Ниже 60 FPS и ниже 720p не уходим.
 */
export interface Rung { height: number; fps: number; }

/** бит на пиксель на кадр для «отличной» картинки: при 60 FPS и для FPS выше 60 */
export const BPP_60 = 0.08;
export const BPP_HIGH = 0.16;

/**
 * Порядок ступеней (v1.20, по требованию пользователя): FPS не опускается ниже
 * 45 (если в настройках не выставлено меньше) — жертвуем FPS (60 → 45) при том
 * же разрешении, и только если не помогло — снижаем разрешение и сразу
 * возвращаем FPS на новом разрешении (1080@60 → 45 → 900@60 …). Ступень 30
 * убрана: «минимум 45» — правило эфира.
 */
export function buildLadder(srcHeight: number, userFps: number): Rung[] {
    const high = fpsSteps(userFps).filter(f => f > MIN_FPS);          // 144/120/90 — только на родном
    const lowFps = [MIN_FPS, 45].filter(f => f <= userFps);
    const fpsAtHeight = lowFps.length ? lowFps : [userFps];            // выбор < 45 — как просил пользователь
    const top = Math.max(1, Math.round(srcHeight));
    const heights = [...new Set([top, 1440, 1080, 900, 720].filter(h => h <= top && (h >= 720 || h === top)))].sort((a, b) => b - a);
    const ladder: Rung[] = [];
    for (const f of high) ladder.push({ height: top, fps: f });
    for (const h of heights) for (const f of fpsAtHeight) ladder.push({ height: h, fps: f });
    return ladder;
}

export function rungNeedBps(r: Rung, aspect: number): number {
    const w = Math.round(r.height * aspect);
    return w * r.height * r.fps * (r.fps > 60 ? BPP_HIGH : BPP_60);
}

/**
 * Выбор ступени. Подниматься — только с запасом 15% (против дёрганья туда-сюда,
 * каждое переключение разрешения = ключевой кадр). cpuSteps — на сколько ступеней
 * опуститься из-за нехватки процессора (меньше пикселей — меньше нагрузка; FPS
 * при этом остаётся ≥ 60).
 */
export function pickRung(ladder: Rung[], capBps: number, aspect: number, prevIdx: number, cpuSteps = 0): number {
    let idx = ladder.length - 1;
    for (let i = 0; i < ladder.length; i++) {
        // гистерезис в обе стороны: вверх — с запасом 15%, удержать текущую — до 85% нужного
        // (1.23.16: спуск без запаса — на колеблющемся канале лестница скакала вверх-вниз,
        // каждая смена разрешения = тяжёлый ключевой кадр и провал)
        const need = rungNeedBps(ladder[i], aspect) * (prevIdx >= 0 && i < prevIdx ? 1.15 : prevIdx >= 0 && i === prevIdx ? 0.85 : 1);
        if (need <= capBps) { idx = i; break; }
    }
    return Math.min(ladder.length - 1, idx + Math.max(0, cpuSteps));
}

/**
 * Процессор: энкодер упирается в CPU и не дотягивает до FPS ступени (×3 замера) —
 * опускаемся на ступень; 30 с без нехватки и ≥ 60 с после спуска — пробуем вверх.
 */
export interface CpuState {
    steps: number; strain: number; easySince: number; lastDown: number;
    /** из steps — сколько ступеней снято НЕ из-за процессора (энкодер выкидывал кадры,
     *  укладываясь в битрейт): их возвращаем по мере роста канала, а не по таймеру */
    bwSteps?: number;
    /** битрейт (бит/с) в момент последнего такого снижения */
    bwAtDown?: number;
}

export function initCpuState(now: number): CpuState {
    return { steps: 0, strain: 0, easySince: now, lastDown: 0, bwSteps: 0, bwAtDown: 0 };
}

/** Во сколько раз должен вырасти битрейт, чтобы вернуть ступень, снятую из-за битрейта */
export const BW_STEP_RECOVER = 1.35;

/**
 * «Энкодер не тянет ступень»: захват подаёт кадры (srcFps ≥ 90% FPS ступени), а
 * энкодер выпускает < 85% — из-за процессора ИЛИ потому что при «сохранять
 * разрешение» он выкидывает кадры, чтобы уложиться в битрейт. Обычный провал —
 * ступень вниз после 3 замеров подряд; сильный (< 50%) — сразу.
 */
export function nextCpuSteps(st: CpuState, s: { encFps: number; targetFps: number; cpuLimited: boolean; srcFps?: number; now: number; capBps?: number; }, maxSteps: number): { state: CpuState; reason: string | null; } {
    const next: CpuState = { ...st };
    // (1.23.9) Ступени, снятые из-за нехватки битрейта, возвращаем, как только канал
    // вырос на 35% с момента снижения (не чаще раза в 4 с). Раньше они возвращались
    // только по таймеру «30 с спокойно и 60 с после спуска»: на старте, пока оценка
    // канала разгоняется, энкодер выкидывал кадры — плагин уходил на 360p и сидел
    // там минуту, хотя канал уже давно позволял 1080p.
    const bwSteps = st.bwSteps ?? 0;
    if (bwSteps > 0 && !s.cpuLimited && s.capBps && st.bwAtDown && s.capBps >= st.bwAtDown * BW_STEP_RECOVER && s.now - st.lastDown >= 4000) {
        next.steps = Math.max(0, st.steps - 1);
        next.bwSteps = bwSteps - 1;
        next.bwAtDown = s.capBps;
        next.strain = 0;
        next.easySince = s.now;
        next.lastDown = s.now; // следующий возврат/спуск — не раньше чем через 4 с
        return { state: next, reason: `канал вырос до ${(s.capBps / 1e6).toFixed(1)} Мбит/с — ступень выше` };
    }
    // ожидаем столько, сколько реально подаёт захват (игра на 30 FPS не «провал» ступени 60);
    // при захвате < 20 FPS (статичный экран) провалы не считаем
    const src = s.srcFps ?? 0;
    const target = src > 0 ? Math.min(s.targetFps, src) : s.targetFps;
    const fed = s.cpuLimited || src >= 20;
    if (fed && s.encFps < target * 0.85) {
        next.strain = st.strain + 1;
        next.easySince = s.now;
        const severe = s.encFps < target * 0.5;
        if ((next.strain >= 3 || severe) && next.steps < maxSteps) {
            next.steps++;
            next.strain = 0;
            next.lastDown = s.now;
            if (!s.cpuLimited) {
                next.bwSteps = bwSteps + 1;
                next.bwAtDown = s.capBps ?? 0;
            }
            const who = s.cpuLimited ? "процессор не успевает" : "энкодер выкидывает кадры";
            return { state: next, reason: `${who} (${Math.round(s.encFps)} из ${s.targetFps} FPS) — ступень ниже` };
        }
        return { state: next, reason: null };
    }
    next.strain = 0;
    if (s.cpuLimited) { next.easySince = s.now; return { state: next, reason: null }; }
    if (next.steps > 0 && s.now - next.easySince >= 30_000 && s.now - st.lastDown >= 60_000) {
        next.steps--;
        if ((next.bwSteps ?? 0) > next.steps) next.bwSteps = next.steps;
        next.easySince = s.now;
        return { state: next, reason: "энкодер справляется — пробую ступень выше" };
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
 * после 6 с спокойствия — −50 мс каждые 6 с до минимума пользователя.
 * (1.23.14: было −25 мс раз в 20 с — от 300 мс до нуля уходило 4 минуты, и после
 * одной заморозки картинка ещё долго отставала.)
 */
export function nextJitterTarget(st: RecvState, s: RecvSample, userMinMs: number): RecvState {
    const rough = s.freezes > 0 || s.jitterMs > 30;
    if (rough) {
        const want = Math.max(st.targetMs + 50, Math.min(MAX_JITTER_TARGET_MS, Math.round(s.jitterMs * 3)));
        return { targetMs: Math.min(MAX_JITTER_TARGET_MS, want), calmSince: s.now };
    }
    if (s.now - st.calmSince >= 6_000 && st.targetMs > userMinMs) {
        return { targetMs: Math.max(userMinMs, st.targetMs - 50), calmSince: s.now };
    }
    return st;
}

/**
 * Стартовый битрейт сеанса (x-google-start-bitrate). Как просил пользователь: сначала
 * пробуем то, что задал стример (не больше 50 Мбит/с — дальше старт ничего не даёт),
 * не тянет — оценка WebRTC за ~секунду падает до реально пропущенного (×0.85 от
 * подтверждённого), дальше растёт сама. Идущий сеанс (перезапуск ICE, смена
 * кодека) — с текущей скорости, без нового скачка.
 * Раньше старт был ~0.3 Мбит/с и рост ~8%/с: полминуты «мыла».
 */
export const MAX_START_BPS = 50_000_000;

export function startBitrateBps(currentBps: number | null | undefined, userMaxBps: number): number {
    const base = currentBps && currentBps > 0 ? currentBps : Math.min(userMaxBps, MAX_START_BPS);
    return Math.round(Math.max(2_500_000, Math.min(userMaxBps, base)));
}

/** Стартовый битрейт для видео в SDP: x-google-start-bitrate (кбит/с) в fmtp каждого
 *  видеокодека. Ставится в answer зрителя на стороне стримера перед
 *  setRemoteDescription — WebRTC отправителя берёт параметры из удалённого описания. */
export function withStartBitrate(sdp: string, startKbps: number): string {
    const lines = sdp.split("\r\n");
    const out: string[] = [];
    let inVideo = false;
    const rtxLike = new Set<string>();
    const hasFmtp = new Set<string>();
    // первый проход: какие payload-ы служебные и у каких уже есть fmtp
    let video = false;
    for (const l of lines) {
        if (l.startsWith("m=")) video = l.startsWith("m=video");
        if (!video) continue;
        const rm = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(l);
        if (rm && /^(rtx|red|ulpfec|flexfec)/i.test(rm[2])) rtxLike.add(rm[1]);
        const fm = /^a=fmtp:(\d+) /.exec(l);
        if (fm) hasFmtp.add(fm[1]);
    }
    for (const l of lines) {
        if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
        if (inVideo) {
            const fm = /^a=fmtp:(\d+) (.*)$/.exec(l);
            if (fm && !rtxLike.has(fm[1])) {
                out.push(`a=fmtp:${fm[1]} ${fm[2].replace(/;?x-google-start-bitrate=\d+/g, "")};x-google-start-bitrate=${startKbps}`);
                continue;
            }
            const rm = /^a=rtpmap:(\d+) /.exec(l);
            if (rm && !rtxLike.has(rm[1]) && !hasFmtp.has(rm[1])) {
                out.push(l, `a=fmtp:${rm[1]} x-google-start-bitrate=${startKbps}`);
                continue;
            }
        }
        out.push(l);
    }
    return out.join("\r\n");
}

/**
 * Порядок видеокодеков в ответе зрителя — как в оффере стримера. Реальный случай
 * 1.23.9: в «Авто» стример предлагал H.264 первым, а ответ Chrome 148 у зрителя
 * ставил первым AV1 — отправка шла программным libaom (0.6 Мбит/с, мыло, 60 FPS
 * не тянет). Кодек для отправки берётся первым из ответа, поэтому стример
 * переставляет payload-ы ответа в порядке своего оффера (работает с любой версией
 * у зрителя; набор кодеков не меняется — только порядок).
 */
export function reorderAnswerCodecs(answerSdp: string, offerSdp: string): string {
    const offerM = /^m=video \S+ \S+ (.+)$/m.exec(offerSdp);
    if (!offerM) return answerSdp;
    const rank = new Map(offerM[1].trim().split(/\s+/).map((pt, i) => [pt, i] as const));
    return answerSdp.replace(/^(m=video \S+ \S+ )(.+)$/m, (_all, head: string, pts: string) => {
        const list = pts.trim().split(/\s+/);
        const sorted = [...list].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
        return head + sorted.join(" ");
    });
}

/** Адрес из частной/VPN-сети: LAN, CGNAT/Tailscale (100.64/10), Hamachi (25/8), Radmin (26/8) */
export function isPrivateOrVpnIPv4(ip: string): boolean {
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
    if (!m) return false;
    const a = Number(m[1]), b = Number(m[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127) || a === 25 || a === 26;
}

/** Разбор строки кандидата (с «a=» или без): приоритет, адрес, тип */
function parseCandidate(line: string): { prio: number; ip: string; typ: string } | null {
    const m = /candidate:\S+ \d+ \S+ (\d+) (\S+) \d+ typ (\S+)/.exec(line);
    return m ? { prio: Number(m[1]), ip: m[2], typ: m[3] } : null;
}

/** Публичные адреса (srflx) из SDP или списка строк кандидатов */
export function srflxIps(lines: string[]): Set<string> {
    const out = new Set<string>();
    for (const l of lines) {
        const c = parseCandidate(l);
        if (c && c.typ === "srflx") out.add(c.ip);
    }
    return out;
}

/** Пир в другой сети: оба публичных адреса известны и не совпадают */
export function peerIsRemote(ourSrflx: Set<string>, peerSrflx: Set<string>): boolean {
    if (!ourSrflx.size || !peerSrflx.size) return false;
    for (const ip of peerSrflx) if (ourSrflx.has(ip)) return false;
    return true;
}

/**
 * Понизить приоритет host-кандидата пира с адресом из частной/VPN-сети, если пир
 * в ДРУГОЙ сети (разные публичные адреса). Реальный случай 1.23.9: у обоих стоял
 * VPN (10.111.234.x), ICE выбрал его как «локальную сеть» (host ↔ host, RTT 101 мс)
 * вместо прямого пути через интернет, и оценка канала упиралась в ~6 Мбит/с.
 * Тип-предпочтение 50: ниже srflx (100) — прямой путь в приоритете, но выше
 * relay (0) — VPN остаётся запасным, если прямой путь не пробивается.
 */
export function demoteVpnCandidate(line: string): string {
    const c = parseCandidate(line);
    if (!c || c.typ !== "host" || !isPrivateOrVpnIPv4(c.ip)) return line;
    const demoted = 50 * 2 ** 24 + (c.prio % 2 ** 24);
    if (demoted >= c.prio) return line;
    return line.replace(/(candidate:\S+ \d+ \S+ )\d+/, `$1${demoted}`);
}

export function demoteVpnInSdp(sdp: string): string {
    return sdp.split("\r\n").map(l => (l.startsWith("a=candidate:") ? demoteVpnCandidate(l) : l)).join("\r\n");
}

/** host-кандидат из частной/VPN-сети (строка с «a=» или без) */
export function isVpnHostCandidate(line: string): boolean {
    const m = /candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host/.exec(line);
    return !!m && isPrivateOrVpnIPv4(m[1]);
}

/** Убрать из SDP host-кандидатов частной/VPN-сети (режим «только прямой путь») */
export function removeVpnInSdp(sdp: string): string {
    return sdp.split("\r\n").filter(l => !(l.startsWith("a=candidate:") && isVpnHostCandidate(l))).join("\r\n");
}

/** Сводка по парам ICE из getStats: какая выбрана и пробился ли прямой путь */
export interface PairInfo { local: string; remote: string; localType: string; remoteType: string; state: string; selected: boolean; rttMs: number; }

export function directPathVerdict(pairs: PairInfo[]): { selectedPrivate: boolean; directOk: boolean } {
    const sel = pairs.find(p => p.selected);
    const selectedPrivate = !!sel && isPrivateOrVpnIPv4(sel.local) && isPrivateOrVpnIPv4(sel.remote);
    // прямой путь = успешная пара на ПУБЛИЧНЫЙ адрес пира, ушедшая не с интерфейса
    // выбранной VPN-пары (локальный адрес за NAT — частный 192.168.x, это нормально)
    const directOk = pairs.some(p => p.state === "succeeded" && !isPrivateOrVpnIPv4(p.remote)
        && (!sel || p.local !== sel.local) && p.localType !== "relay" && p.remoteType !== "relay");
    return { selectedPrivate, directOk };
}

/**
 * Декодер ЗРИТЕЛЯ не успевает (из локальной доработки 1.21.1, перенесено в 1.23.12).
 * Хост не видит, сколько кадров зритель реально показал — зритель раз в 2 с
 * присылает по каналу обратной связи: получено/декодировано/выброшено кадров.
 * Реальный лог 1.23.11: стример отдаёт 1080p58 / 31 Мбит/с, а у зрителя 9 FPS и
 * 5 заморозок — стример этого не знал и держал ту же ступень.
 *  - программный декодер AV1 не успевает → сразу сменить кодек;
 *  - иначе 2 замера подряд → ступень лестницы ниже; 45 с без проблем → назад.
 */
export interface ViewerRx { recvFps: number; decFps: number; dropFps: number; hw: boolean; }
export interface ViewerDecodeState { strain: number; steps: number; calmSince: number; lastAct: number; }

export function initViewerDecode(now: number): ViewerDecodeState {
    return { strain: 0, steps: 0, calmSince: now, lastAct: 0 };
}

export function nextViewerDecode(st: ViewerDecodeState, rx: ViewerRx, codec: string, now: number, maxSteps: number): { state: ViewerDecodeState; action: "codec" | "down" | "up" | null; reason: string | null; } {
    const next = { ...st };
    // dropFps бывает больше decFps (Chrome считает выброшенные до декодера) — не ниже 0
    const shown = Math.max(0, Math.min(rx.decFps, rx.decFps - rx.dropFps));
    const behind = rx.recvFps >= 20 && (shown < rx.recvFps * 0.85 || (shown < 28 && rx.recvFps >= 30));
    if (behind) {
        next.strain = st.strain + 1;
        next.calmSince = now;
        const why = `зритель показывает ${Math.round(shown)} из ${Math.round(rx.recvFps)} FPS (${rx.hw ? "аппаратный" : "программный"} декодер)`;
        if (now - st.lastAct < 6000) return { state: next, action: null, reason: null };
        if (!rx.hw && codec === "av1") {
            next.strain = 0;
            next.lastAct = now;
            return { state: next, action: "codec", reason: why };
        }
        if (next.strain >= 2 && next.steps < maxSteps) {
            next.strain = 0;
            next.steps++;
            next.lastAct = now;
            return { state: next, action: "down", reason: `${why} — ступень ниже` };
        }
        return { state: next, action: null, reason: null };
    }
    next.strain = 0;
    if (next.steps > 0 && now - st.calmSince >= 45_000 && now - st.lastAct >= 45_000) {
        next.steps--;
        next.lastAct = now;
        next.calmSince = now;
        return { state: next, action: "up", reason: "зритель успевает — пробую ступень выше" };
    }
    return { state: next, action: null, reason: null };
}

/**
 * Зритель «голодает»: собирает < 70% отправленных кадров (остальные приходят
 * с дырками и ждут повторной пересылки) или за интервал были заморозки.
 * Статичный экран (энкодер выдаёт < 20 FPS) — не голод.
 */
export function viewerStarved(rx: { recvFps: number; fz?: number }, encFps: number): boolean {
    // (1.23.15) заморозки — только на движущейся картинке: на статике кадры идут раз в
    // секунду, и Chrome считает «заморозкой» каждую паузу — потолок рушился до 1.5 Мбит/с
    if (encFps < 20) return false;
    return rx.recvFps < encFps * 0.7 || ((rx.fz ?? 0) >= 1 && rx.recvFps >= 15);
}

/**
 * Потолок канала (1.23.18) — «проверить → не тянет → перепроверить ниже → держаться у
 * предела». Реальный лог 1.23.17: старт с 40 Мбит/с, VPN не выдержал — оценка WebRTC
 * рухнула до ~5 и 40 с ползла обратно до 36; ещё через ~40 с снова упёрлась в предел
 * VPN и за 2 с рухнула 40 → 6.7. Так по кругу: «откаты и лесенки».
 *  - обвал (оценка упала > 2 раз; или сразу после старта ниже половины стартовой) →
 *    потолок = 80% скорости, которую канал не выдержал;
 *  - канал 4 с чистый, а оценка < 60% потолка → «перезапуск» оценки на потолке
 *    (пересогласование со стартовым битрейтом = потолок: оценка прыгает сразу, не
 *    растёт 8%/с — проверено на стенде: 11.5 → 25.9 Мбит/с за 2 с), не чаще раза в 15 с;
 *  - 10 с без проблем при загрузке ≥ 80% потолка → потолок +5% (пробуем выше).
 */
export interface CeilState { ceiling: number; prevBwe: number; cleanSince: number; lastKick: number; lastTrouble: number; }

export function initCeil(now: number): CeilState {
    return { ceiling: 0, prevBwe: 0, cleanSince: now, lastKick: 0, lastTrouble: 0 };
}

export function nextCeiling(st: CeilState, s: { bwe: number | null; sent: number; clean: boolean; startBps?: number; now: number; }, userMaxBps: number): { state: CeilState; kickBps: number | null; reason: string | null; } {
    const next: CeilState = { ...st };
    const bwe = s.bwe && s.bwe > 0 ? s.bwe : 0;
    let reason: string | null = null;
    let trouble = 0;
    if (bwe && st.prevBwe > 8e6 && bwe < st.prevBwe * 0.5) trouble = st.prevBwe;
    else if (bwe && !st.prevBwe && s.startBps && s.startBps > 8e6 && bwe < s.startBps * 0.5) trouble = s.startBps;
    if (trouble) {
        const c = Math.max(2 * MIN_CAP_BPS, Math.min(userMaxBps, Math.round(trouble * 0.8)));
        next.ceiling = st.ceiling ? Math.min(st.ceiling, c) : c;
        next.lastTrouble = s.now;
        next.cleanSince = s.now;
        reason = `канал не выдержал ${(trouble / 1e6).toFixed(1)} Мбит/с — держусь до ${(next.ceiling / 1e6).toFixed(1)}`;
    }
    if (!s.clean) next.cleanSince = s.now;
    let kickBps: number | null = null;
    if (!trouble && next.ceiling && bwe && bwe < next.ceiling * 0.6 && s.now - next.cleanSince >= 4000 && (!st.lastKick || s.now - st.lastKick >= 15_000)) {
        kickBps = next.ceiling;
        next.lastKick = s.now;
        reason = `канал чистый — сразу возвращаюсь на ${(next.ceiling / 1e6).toFixed(1)} Мбит/с (оценка была ${(bwe / 1e6).toFixed(1)})`;
    }
    if (!trouble && !kickBps && next.ceiling && next.ceiling < userMaxBps && s.clean && s.now - next.lastTrouble >= 10_000 && s.now - next.cleanSince >= 10_000 && s.sent >= next.ceiling * 0.8) {
        next.ceiling = Math.min(userMaxBps, Math.round(next.ceiling * 1.05));
        next.lastTrouble = s.now;
        reason = `10 с стабильно у потолка — пробую ${(next.ceiling / 1e6).toFixed(1)} Мбит/с`;
    }
    if (bwe) next.prevBwe = bwe;
    return { state: next, kickBps, reason };
}
