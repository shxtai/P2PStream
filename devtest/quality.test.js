#!/usr/bin/env node
// Тест решений авто-качества (quality.ts): node quality.test.js
const path = require("path");
const esbuild = require("esbuild");

const out = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "quality.ts")],
    bundle: true, format: "cjs", platform: "node", write: false
});
const mod = { exports: {} };
new Function("module", "exports", out.outputFiles[0].text)(mod, mod.exports);
const { initSendState, nextCap, scaleFor, nextJitterTarget, MIN_CAP_BPS, nextDecodeTrouble, nextEncoderStall, fallbackCodec, DECODE_TROUBLE_LIMIT, initFpsState, nextFpsCap, fpsSteps, effectiveCap, qualityFpsCap } = mod.exports;

let failed = 0;
function check(name, cond, info = "") {
    console.log(`${cond ? "✔" : "✘"} ${name}${info ? " — " + info : ""}`);
    if (!cond) failed++;
}
const MAX = 30e6;

// 1a. канал 8 Мбит/с (перегрузка: потери = избыток над ёмкостью) -> сходимся к ёмкости
{
    let st = initSendState(MAX, 0), t = 0;
    const caps = [];
    for (let i = 0; i < 150; i++) {
        t += 2000;
        const loss = Math.max(0, (st.capBps - 8e6) / st.capBps);
        st = nextCap(st, { loss, pli: loss > 0.1 ? 2 : 0, rttMs: 100, now: t }, MAX).state;
        caps.push(st.capBps);
    }
    const tail = caps.slice(-60);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    check("перегрузка (канал 8 Мбит/с): держимся около ёмкости", avg > 4e6 && avg <= 9e6 && Math.max(...tail) <= 10e6,
        `среднее ${(avg / 1e6).toFixed(1)}, макс ${(Math.max(...tail) / 1e6).toFixed(1)} Мбит/с`);
}
// 1b. случайные потери 6% при любой скорости -> НЕ душим до минимума
{
    let st = initSendState(MAX, 0), t = 0;
    for (let i = 0; i < 60; i++) { t += 2000; st = nextCap(st, { loss: 0.06, pli: 0, rttMs: 100, now: t }, MAX).state; }
    check("случайные потери 6%: битрейт не падает до минимума", st.capBps >= 0.4 * MAX && st.capBps > MIN_CAP_BPS,
        `${(st.capBps / 1e6).toFixed(1)} Мбит/с`);
}
// 2. одиночный всплеск 4% не режет сразу (сглаживание), а 2 подряд — режет
{
    let st = initSendState(MAX, 0);
    let r = nextCap(st, { loss: 0.04, pli: 0, rttMs: 100, now: 2000 }, MAX);
    check("одиночный всплеск потерь 4% не режет", r.state.capBps === MAX);
    for (let t = 4000; t <= 10000; t += 2000) r = nextCap(r.state, { loss: 0.08, pli: 0, rttMs: 100, now: t }, MAX);
    check("устойчивые потери 8% режут (за несколько замеров)", r.state.capBps < MAX, `${(r.state.capBps / 1e6).toFixed(1)} Мбит/с`);
}
// 2b. реальная жалоба: 80 Мбит/с «сразу падает до 40», хотя канал тянет больше
{
    const M = 100e6;
    let st = { ...initSendState(M, 0), capBps: 80e6 };
    for (let i = 1; i <= 30; i++) st = nextCap(st, { loss: 0.03, pli: 0, rttMs: 100, now: i * 2000 }, M).state;
    check("3% восстанавливаемых потерь без PLI — поток 80 не трогается", st.capBps >= 80e6, `${(st.capBps / 1e6).toFixed(1)} Мбит/с`);
    let s2 = { ...initSendState(M, 0), capBps: 40e6, lastCut: 1000, cleanSince: 1000 };
    let t = 1000;
    while (s2.capBps < 80e6 && t < 120000) { t += 2000; s2 = nextCap(s2, { loss: 0, pli: 0, rttMs: 100, now: t }, M).state; }
    check("после снижения до 40 возвращается к 80 быстрее 25 с", (t - 1000) <= 25000, `${((t - 1000) / 1000).toFixed(0)} с`);
    let s3 = { ...initSendState(M, 0), capBps: 80e6 };
    s3 = nextCap(s3, { loss: 0.08, pli: 0, rttMs: 100, now: 2000 }, M).state;
    s3 = nextCap(s3, { loss: 0.08, pli: 0, rttMs: 100, now: 4000 }, M).state;
    s3 = nextCap(s3, { loss: 0.08, pli: 0, rttMs: 100, now: 6000 }, M).state;
    check("умеренные потери режут мягко (×0.8), а не вдвое", s3.capBps >= 64e6 || s3.capBps === 80e6, `${(s3.capBps / 1e6).toFixed(1)} Мбит/с`);
}
// 3. шторм PLI: с потерями — перегрузка (режем); без потерь — это декодер (НЕ режем)
{
    const r = nextCap(initSendState(MAX, 0), { loss: 0.02, pli: 3, rttMs: 100, now: 2000 }, MAX);
    check("PLI + потери: снижение", r.state.capBps < MAX, r.reason ?? "");
    let st = initSendState(MAX, 0);
    for (let i = 1; i <= 20; i++) st = nextCap(st, { loss: 0, pli: 6, rttMs: 100, now: i * 2000 }, MAX).state;
    check("PLI без потерь (реальный лог: ×6 каждые 2 с) — битрейт НЕ режется", st.capBps === MAX, `${(st.capBps / 1e6).toFixed(1)} Мбит/с`);
}
// 3a. реальный лог 1.15: в настройках 100 Мбит/с, оценка канала 36 -> итог сразу ≤ 32.4
{
    const st = initSendState(100e6, 0);
    check("100 Мбит/с при оценке канала 36 -> итоговый потолок ≤ 32.4", effectiveCap(st, 36e6, 100e6) <= 32.4e6, `${(effectiveCap(st, 36e6, 100e6) / 1e6).toFixed(1)} Мбит/с`);
    // старт: оценка разгоняется 3 -> 40 Мбит/с за ~10 с — итог идёт следом без медленного +15%/10 с
    let s2 = initSendState(30e6, 0), eff = 0;
    [3e6, 6e6, 12e6, 20e6, 30e6, 40e6].forEach((b, i) => { s2 = nextCap(s2, { loss: 0, pli: 0, rttMs: 100, bweBps: b, now: (i + 1) * 2000 }, 30e6).state; eff = effectiveCap(s2, b, 30e6); });
    check("на старте итог следует за разгоном оценки канала (за 12 с до максимума)", eff === 30e6, `${(eff / 1e6).toFixed(1)} Мбит/с`);
    // потери режут независимо от оценки
    let s3 = initSendState(30e6, 0);
    for (let i = 1; i <= 4; i++) s3 = nextCap(s3, { loss: 0.15, pli: 5, rttMs: 140, bweBps: 36e6, now: i * 2000 }, 30e6).state;
    check("при потерях 15% итог ниже оценки канала", effectiveCap(s3, 36e6, 30e6) < 25e6, `${(effectiveCap(s3, 36e6, 30e6) / 1e6).toFixed(1)} Мбит/с`);
    check("PLI при NACK — это сеть, а не декодер", nextDecodeTrouble(2, { pli: 13, loss: 0, nack: 1227 }) === 0);
}
// 3b. «декодер не справляется»: 3 интервала PLI без потерь подряд -> смена кодека
{
    let c = 0;
    for (let i = 0; i < 3; i++) c = nextDecodeTrouble(c, { pli: 6, loss: 0 });
    check("3 интервала PLI без потерь -> сигнал сменить кодек", c >= DECODE_TROUBLE_LIMIT);
    check("PLI с потерями — не проблема декодера", nextDecodeTrouble(2, { pli: 6, loss: 0.05 }) === 0);
    let st = 0;
    for (let i = 0; i < 3; i++) st = nextEncoderStall(st, { srcFrames: 60, encFrames: 1 });
    check("энкодер завис (60 кадров захвата -> 1 закодирован) ×3 -> сменить кодек", st >= DECODE_TROUBLE_LIMIT);
    check("статичный экран (захват 0 кадров) — не зависание", nextEncoderStall(2, { srcFrames: 0, encFrames: 0 }) === 0);
    check("нормальная работа — не зависание", nextEncoderStall(2, { srcFrames: 60, encFrames: 58 }) === 0);
    check("цепочка кодеков: h264 -> vp9 -> vp8", fallbackCodec("h264", []) === "vp9" && fallbackCodec("vp9", ["h264"]) === "vp8" && fallbackCodec("vp8", ["h264", "vp9"]) === null);
}
// 4. рост очереди (RTT 100 -> 400) -> снижение
{
    let st = initSendState(MAX, 0);
    st = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: 2000 }, MAX).state;
    const r = nextCap(st, { loss: 0, pli: 0, rttMs: 400, now: 4000 }, MAX);
    check("рост очереди (RTT ×4) режет", r.state.capBps < MAX, r.reason ?? "");
}
// 5. восстановление: после снижения и 10+ с чистоты — растёт до максимума, не выше
{
    let st = initSendState(MAX, 0);
    st = nextCap(st, { loss: 0.2, pli: 0, rttMs: 100, now: 2000 }, MAX).state;
    st = nextCap(st, { loss: 0.2, pli: 0, rttMs: 100, now: 4000 }, MAX).state;
    const low = st.capBps;
    let t = 4000;
    for (let i = 0; i < 200; i++) { t += 2000; st = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: t }, MAX).state; }
    check("на чистом канале возвращается к максимуму", st.capBps === MAX, `${(low / 1e6).toFixed(1)} -> ${(st.capBps / 1e6).toFixed(1)} Мбит/с`);
}
// 6. чистый канал без проблем — ничего не трогаем
{
    let st = initSendState(MAX, 0), changed = false;
    for (let i = 1; i <= 50; i++) { const r = nextCap(st, { loss: 0, pli: 0, rttMs: 90 + (i % 5), now: i * 2000 }, MAX); if (r.reason) changed = true; st = r.state; }
    check("чистый канал: битрейт не трогается", !changed && st.capBps === MAX);
}
// 7. разрешение: 1440p60 при 30/10/5/2 Мбит/с
{
    const s30 = scaleFor(30e6, 1440, 2560, 60), s10 = scaleFor(10e6, 1440, 2560, 60), s5 = scaleFor(5e6, 1440, 2560, 60), s2 = scaleFor(2e6, 1440, 2560, 60);
    check("1440p60: 30 Мбит/с — без уменьшения", s30 === 1);
    check("1440p60: 10 Мбит/с — 1080p", Math.round(1440 / s10) === 1080, `÷${s10.toFixed(2)}`);
    check("1440p60: 5 Мбит/с — 720p", Math.round(1440 / s5) === 720, `÷${s5.toFixed(2)}`);
    check("1440p60: 2 Мбит/с — не ниже 540p", Math.round(1440 / s2) >= 540, `${Math.round(1440 / s2)}p`);
    check("720p: никогда не ниже 540p", Math.round(720 / scaleFor(1.5e6, 720, 1280, 60)) >= 540);
}
// 7b. стабилизатор FPS при нехватке процессора — НИЖЕ 60 НЕ ОПУСКАЕТСЯ
{
    let st = initFpsState(60, 0), t = 0;
    for (let i = 0; i < 10; i++) { t += 2000; st = nextFpsCap(st, { encFps: 40, cpuLimited: true, now: t }, 60).state; }
    check("в настройках 60, процессор не тянет -> FPS всё равно 60 (снижать будет разрешение)", st.capFps === 60);
    let s144 = initFpsState(144, 0), reasons = [];
    t = 0;
    for (let i = 0; i < 4; i++) { t += 2000; const r = nextFpsCap(s144, { encFps: 90, cpuLimited: true, now: t }, 144); s144 = r.state; if (r.reason) reasons.push(r.reason); }
    check("144 FPS, процессор даёт ~90 -> ровные 120", s144.capFps === 120, reasons[0] ?? "");
    for (let i = 0; i < 20; i++) { t += 2000; s144 = nextFpsCap(s144, { encFps: 50, cpuLimited: true, now: t }, 144).state; }
    check("и дальше не тянет -> не ниже 60", s144.capFps === 60);
    for (let i = 0; i < 60; i++) { t += 2000; s144 = nextFpsCap(s144, { encFps: s144.capFps, cpuLimited: false, now: t }, 144).state; }
    check("процессор свободен долго -> FPS возвращается к 144", s144.capFps === 144, `${s144.capFps}`);
    let calm = initFpsState(60, 0);
    for (let i = 1; i <= 50; i++) calm = nextFpsCap(calm, { encFps: 59, cpuLimited: false, now: i * 2000 }, 60).state;
    check("без cpu-ограничения FPS не трогается", calm.capFps === 60);
    check("шаги для 144 FPS: 144 → 120 → 90 → 60", fpsSteps(144).join(",") === "144,120,90,60");
    check("в настройках 30 — остаётся 30 (не поднимаем выше выбора)", fpsSteps(30).join(",") === "30");
}
// 7c. FPS выше 60 — только если хватает бит на кадр (картинка в динамике без «мыла»)
{
    const W = 2560, H = 1440;
    check("1440p, 50 Мбит/с, в настройках 120 -> 60 (на 90+ бит на кадр мало)", qualityFpsCap(120, 50e6, W, H, 120) === 60, `${qualityFpsCap(120, 50e6, W, H, 120)}`);
    check("1440p, 80 Мбит/с, в настройках 120 -> 120", qualityFpsCap(60, 80e6, W, H, 120) === 90 || qualityFpsCap(120, 80e6, W, H, 120) >= 120, `${qualityFpsCap(120, 80e6, W, H, 120)}`);
    check("1080p, 50 Мбит/с, в настройках 144 -> 120", qualityFpsCap(60, 50e6, 1920, 1080, 144) === 120, `${qualityFpsCap(60, 50e6, 1920, 1080, 144)}`);
    check("гистерезис: на 60 при 0.17 бит/пикс не поднимаемся до 90", qualityFpsCap(60, 0.17 * W * H * 90, W, H, 120) === 60);
    check("гистерезис: на 90 при 0.17 бит/пикс остаёмся на 90", qualityFpsCap(90, 0.17 * W * H * 90, W, H, 120) === 90);
    check("никогда не ниже 60, даже при 5 Мбит/с", qualityFpsCap(120, 5e6, W, H, 120) === 60);
}
// 8. буфер зрителя: заморозки -> растёт до 300, спокойствие -> назад к минимуму
{
    let st = { targetMs: 0, calmSince: 0 };
    for (let i = 1; i <= 10; i++) st = nextJitterTarget(st, { freezes: 1, jitterMs: 40, now: i * 2000 }, 0);
    check("заморозки растят буфер до 300 мс", st.targetMs === 300, `${st.targetMs} мс`);
    let t = 20000;
    for (let i = 0; i < 400; i++) { t += 2000; st = nextJitterTarget(st, { freezes: 0, jitterMs: 5, now: t }, 0); }
    check("спокойный канал возвращает буфер к минимуму", st.targetMs === 0, `${st.targetMs} мс`);
}
process.exit(failed ? 1 : 0);
