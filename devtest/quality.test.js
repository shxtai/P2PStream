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
const { initSendState, nextCap, scaleFor, nextJitterTarget, MIN_CAP_BPS, nextDecodeTrouble, nextEncoderStall, fallbackCodec, DECODE_TROUBLE_LIMIT } = mod.exports;

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
    r = nextCap(r.state, { loss: 0.06, pli: 0, rttMs: 100, now: 4000 }, MAX);
    check("повторные потери режут", r.state.capBps < MAX, `${(r.state.capBps / 1e6).toFixed(1)} Мбит/с`);
}
// 3. шторм PLI: с потерями — перегрузка (режем); без потерь — это декодер (НЕ режем)
{
    const r = nextCap(initSendState(MAX, 0), { loss: 0.02, pli: 3, rttMs: 100, now: 2000 }, MAX);
    check("PLI + потери: снижение", r.state.capBps < MAX, r.reason ?? "");
    let st = initSendState(MAX, 0);
    for (let i = 1; i <= 20; i++) st = nextCap(st, { loss: 0, pli: 6, rttMs: 100, now: i * 2000 }, MAX).state;
    check("PLI без потерь (реальный лог: ×6 каждые 2 с) — битрейт НЕ режется", st.capBps === MAX, `${(st.capBps / 1e6).toFixed(1)} Мбит/с`);
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
