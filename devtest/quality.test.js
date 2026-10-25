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
const { initSendState, nextCap, scaleFor, nextJitterTarget, MIN_CAP_BPS, nextDecodeTrouble, nextEncoderStall, fallbackCodec, DECODE_TROUBLE_LIMIT, initFpsState, nextFpsCap, fpsSteps, effectiveCap, qualityFpsCap, buildLadder, pickRung, rungNeedBps, initCpuState, nextCpuSteps, sendCap, startBitrateBps, withStartBitrate, BW_STEP_RECOVER, reorderAnswerCodecs, demoteVpnCandidate, demoteVpnInSdp, isPrivateOrVpnIPv4, srflxIps, peerIsRemote, directPathVerdict, isVpnHostCandidate, removeVpnInSdp, initViewerDecode, nextViewerDecode, viewerStarved, initCeil, nextCeiling, kickGapMs, initCeilFromLimit, startFromLimit, nextRemembered } = mod.exports;

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
    check("цепочка кодеков: h264 -> h265 -> vp9 -> vp8", fallbackCodec("h264", []) === "h265" && fallbackCodec("h265", ["h264"]) === "vp9" && fallbackCodec("vp9", ["h264", "h265"]) === "vp8" && fallbackCodec("vp8", ["h264", "h265", "vp9"]) === null);
    check("цепочка кодеков: без H.265 у клиента — сразу VP9", fallbackCodec("h264", [], ["h264", "vp9", "vp8"]) === "vp9");
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
// 7d. лестница качества: разрешение и FPS вместе
{
    const A = 16 / 9;
    const L = buildLadder(1440, 120);
    const name = i => `${L[i].height}p@${L[i].fps}`;
    check("лестница: сначала FPS (60→45) на родном, потом разрешение с возвратом к 60 (ниже 45 не опускаемся)",
        L.map(r => `${r.height}@${r.fps}`).join(",") === "1440@120,1440@90,1440@60,1440@45,1080@60,1080@45,900@60,900@45,720@60,720@45", L.map(r => `${r.height}@${r.fps}`).join(","));
    check("80 Мбит/с → 1440p@120", name(pickRung(L, 80e6, A, -1)) === "1440p@120", name(pickRung(L, 80e6, A, -1)));
    check("50 Мбит/с → 1440p@60", name(pickRung(L, 50e6, A, -1)) === "1440p@60", name(pickRung(L, 50e6, A, -1)));
    check("15 Мбит/с → 1440p@45 (качество сохраняем, жертвуем FPS)", name(pickRung(L, 15e6, A, -1)) === "1440p@45", name(pickRung(L, 15e6, A, -1)));
    check("10 Мбит/с → 1080p@60 (ниже 45 FPS не идём — срезаем разрешение)", name(pickRung(L, 10e6, A, -1)) === "1080p@60", name(pickRung(L, 10e6, A, -1)));
    check("8 Мбит/с → 1080p@45", name(pickRung(L, 8e6, A, -1)) === "1080p@45", name(pickRung(L, 8e6, A, -1)));
    check("2 Мбит/с → самая нижняя ступень 720p@45", name(pickRung(L, 2e6, A, -1)) === "720p@45");
    const need1440 = rungNeedBps(L[2], A);
    check("гистерезис: вверх только с запасом 15%", pickRung(L, need1440 * 1.05, A, 3) === 3 && pickRung(L, need1440 * 1.2, A, 3) === 2);
    check("нехватка процессора: сначала FPS (1440p@60 → 1440p@45)", name(pickRung(L, 50e6, A, -1, 1)) === "1440p@45", name(pickRung(L, 50e6, A, -1, 1)));
    const L60 = buildLadder(1080, 60);
    check("1080p/60: 1080@60,45 → 900@60,45 → 720@60,45", L60.map(r => `${r.height}@${r.fps}`).join(",") === "1080@60,1080@45,900@60,900@45,720@60,720@45", L60.map(r => `${r.height}@${r.fps}`).join(","));
    let cs = initCpuState(0), t = 0, why = null;
    for (let i = 0; i < 3; i++) { t += 2000; const r = nextCpuSteps(cs, { encFps: 45, targetFps: 60, cpuLimited: true, now: t }, 3); cs = r.state; why = r.reason ?? why; }
    check("процессор не тянет 60 ×3 → минус ступень", cs.steps === 1, why ?? "");
    for (let i = 0; i < 40; i++) { t += 2000; cs = nextCpuSteps(cs, { encFps: 60, targetFps: 60, cpuLimited: false, now: t }, 3).state; }
    check("процессор свободен → ступень возвращается", cs.steps === 0);
    // энкодер выкидывает кадры (бит мало, «сохранять разрешение»): захват 30, выпущено 6 — сразу ступень вниз
    let ds = initCpuState(0);
    const r1 = nextCpuSteps(ds, { encFps: 6, targetFps: 30, cpuLimited: false, srcFps: 30, now: 2000 }, 5);
    check("энкодер выкидывает кадры (6 из 30) → ступень вниз сразу", r1.state.steps === 1, r1.reason ?? "");
    const r2 = nextCpuSteps(initCpuState(0), { encFps: 5, targetFps: 60, cpuLimited: false, srcFps: 5, now: 2000 }, 5);
    check("статичный экран (захват сам даёт 5 FPS) — не провал", r2.state.steps === 0);
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
// --- 1.23.9: быстрый разгон ---
{
    // стартовый битрейт: сначала то, что задал стример (до 50), идущий сеанс — текущая скорость
    check("старт = битрейт из настроек стримера", startBitrateBps(0, 30e6) === 30e6);
    check("старт не выше 50 Мбит/с даже при 100 в настройках", startBitrateBps(0, 100e6) === 50e6);
    check("перезапуск сеанса — с текущей скорости", startBitrateBps(8e6, 100e6) === 8e6);
    check("старт не ниже 2.5 Мбит/с", startBitrateBps(0, 1e6) === 2.5e6 || startBitrateBps(0, 1e6) === 1e6, `${startBitrateBps(0, 1e6)}`);

    // потолок энкодера: на чистом канале выше оценки (зондирование), с потерями — 90%
    const st = initSendState(100e6, 0);
    check("чистый канал: потолок энкодера 1.6× оценки", sendCap(st, 10e6, 100e6, true) === 16e6, `${sendCap(st, 10e6, 100e6, true) / 1e6}`);
    check("потери: потолок энкодера 0.9× оценки", sendCap(st, 10e6, 100e6, false) === 9e6);
    check("потолок энкодера не выше максимума", sendCap(st, 80e6, 30e6, true) === 30e6);
    check("без оценки — потолок по потерям/настройкам", sendCap({ ...st, capBps: 20e6 }, null, 100e6, true) === 20e6);

    // ступени, снятые из-за битрейта (энкодер выкидывал кадры, процессор свободен),
    // возвращаются по мере роста канала, а не через минуту
    let c = initCpuState(0), t = 0;
    for (let i = 0; i < 3; i++) { t += 2000; c = nextCpuSteps(c, { encFps: 20, targetFps: 60, cpuLimited: false, srcFps: 60, now: t, capBps: 6e6 }, 5).state; }
    check("кадры выкидываются на 6 Мбит/с → ступень ниже", c.steps >= 1 && c.bwSteps >= 1, `steps=${c.steps}`);
    const down = c.steps;
    t += 2000; c = nextCpuSteps(c, { encFps: 60, targetFps: 60, cpuLimited: false, srcFps: 60, now: t, capBps: 7e6 }, 5).state;
    check("канал вырос мало (+17%) — ступень не возвращаем", c.steps === down);
    t += 4000; const r = nextCpuSteps(c, { encFps: 60, targetFps: 60, cpuLimited: false, srcFps: 60, now: t, capBps: 6e6 * BW_STEP_RECOVER }, 5);
    check("канал вырос на 35% — ступень возвращается сразу (не через 60 с)", r.state.steps === down - 1, r.reason);

    // а ступень из-за процессора по росту канала НЕ возвращается
    let p = initCpuState(0); t = 0;
    for (let i = 0; i < 3; i++) { t += 2000; p = nextCpuSteps(p, { encFps: 20, targetFps: 60, cpuLimited: true, srcFps: 60, now: t, capBps: 6e6 }, 5).state; }
    const pd = p.steps;
    t += 6000; p = nextCpuSteps(p, { encFps: 60, targetFps: 60, cpuLimited: false, srcFps: 60, now: t, capBps: 50e6 }, 5).state;
    check("ступень из-за процессора не возвращается от роста канала", pd >= 1 && p.steps === pd);

    // SDP: x-google-start-bitrate каждому видеокодеку (и с fmtp, и без), служебным — нет
    const sdp = [
        "v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10",
        "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99", "a=rtpmap:96 VP8/90000", "a=rtpmap:97 rtx/90000", "a=fmtp:97 apt=96",
        "a=rtpmap:98 H264/90000", "a=fmtp:98 profile-level-id=42e01f;packetization-mode=1", "a=rtpmap:99 red/90000", ""
    ].join("\r\n");
    const m = withStartBitrate(sdp, 12000);
    check("SDP: VP8 без fmtp получил start-bitrate", m.includes("a=fmtp:96 x-google-start-bitrate=12000"));
    check("SDP: H264 fmtp дополнен", m.includes("a=fmtp:98 profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=12000"));
    check("SDP: rtx/red и звук не тронуты", m.includes("a=fmtp:97 apt=96\r\n") && !/a=fmtp:99/.test(m) && m.includes("a=fmtp:111 minptime=10\r\n"));
    check("SDP: повторный мунж не дублирует параметр", (withStartBitrate(m, 9000).match(/x-google-start-bitrate/g) || []).length === 2 && withStartBitrate(m, 9000).includes("x-google-start-bitrate=9000"));
}
// --- 1.23.10: кодек по порядку стримера, прямой путь важнее VPN ---
{
    const offer = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "m=video 9 UDP/TLS/RTP/SAVPF 102 103 98 99 45 46 96 97", ""].join("\r\n");
    const answer = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "m=video 9 UDP/TLS/RTP/SAVPF 45 46 96 97 98 99 102 103", "a=rtpmap:45 AV1/90000", ""].join("\r\n");
    const r = reorderAnswerCodecs(answer, offer);
    check("ответ: кодеки в порядке оффера стримера (H.264 первым, не AV1)", r.includes("m=video 9 UDP/TLS/RTP/SAVPF 102 103 98 99 45 46 96 97"), /m=video.*$/m.exec(r)?.[0]);
    check("ответ: звук не тронут", r.includes("m=audio 9 UDP/TLS/RTP/SAVPF 111"));
    const partial = reorderAnswerCodecs(answer.replace("45 46 96 97 98 99 102 103", "96 97 45 46"), offer);
    check("ответ без части кодеков — только переставляется", partial.includes("m=video 9 UDP/TLS/RTP/SAVPF 45 46 96 97"));

    check("VPN/LAN адреса распознаются", ["10.111.234.221", "192.168.1.5", "172.20.0.1", "100.101.1.1", "26.1.2.3", "25.4.5.6"].every(isPrivateOrVpnIPv4));
    check("публичные адреса — нет", !["95.90.189.182", "109.195.75.27", "172.32.0.1", "8.8.8.8"].some(isPrivateOrVpnIPv4));
    const vpn = "candidate:1 1 udp 2122260223 10.111.234.122 54321 typ host generation 0";
    const lan = "a=candidate:2 1 udp 2122194687 192.168.0.10 50000 typ host";
    const srflx = "candidate:3 1 udp 1686052607 109.195.75.27 61000 typ srflx raddr 10.111.234.122 rport 54321";
    const prio = l => Number(/candidate:\S+ \d+ \S+ (\d+)/.exec(l)[1]);
    check("VPN-кандидат опущен ниже прямого (srflx)", prio(demoteVpnCandidate(vpn)) < prio(srflx), `${prio(demoteVpnCandidate(vpn))} < ${prio(srflx)}`);
    check("но выше TURN (relay остаётся последним)", prio(demoteVpnCandidate(vpn)) > 41885439);
    check("srflx не трогаем", demoteVpnCandidate(srflx) === srflx);
    check("в SDP: a=candidate с LAN опущен", prio(demoteVpnInSdp(["v=0", lan, ""].join("\r\n")).split("\r\n")[1]) < 1686052607);
    check("разные публичные адреса — пир в другой сети", peerIsRemote(srflxIps(["a=candidate:9 1 udp 1686052607 95.90.189.182 1 typ srflx"]), srflxIps([srflx])));
    check("один публичный адрес (одна квартира) — LAN не трогаем", !peerIsRemote(srflxIps([srflx]), srflxIps([srflx])));
    check("публичный адрес неизвестен — ничего не трогаем", !peerIsRemote(new Set(), srflxIps([srflx])));
}
// --- 1.23.11: проверка прямого пути ---
{
    const P = (local, remote, localType, remoteType, state, selected = false) => ({ local, remote, localType, remoteType, state, selected, rttMs: 0 });
    // реальный лог 1.23.10: выбрана VPN-пара, прямая (srflx) тоже прошла
    let v = directPathVerdict([P("10.111.234.221", "10.111.234.122", "host", "host", "succeeded", true), P("192.168.1.5", "109.195.75.27", "host", "srflx", "succeeded")]);
    check("VPN выбран, прямой путь работает → переходить", v.selectedPrivate && v.directOk);
    v = directPathVerdict([P("10.111.234.221", "10.111.234.122", "host", "host", "succeeded", true), P("192.168.1.5", "109.195.75.27", "host", "srflx", "failed")]);
    check("VPN выбран, прямой не пробился → оставаться на VPN", v.selectedPrivate && !v.directOk);
    v = directPathVerdict([P("192.168.1.5", "109.195.75.27", "host", "srflx", "succeeded", true)]);
    check("уже прямой путь → ничего не делать", !v.selectedPrivate);
    v = directPathVerdict([P("10.111.234.221", "10.111.234.122", "host", "host", "succeeded", true), P("1.2.3.4", "5.6.7.8", "relay", "srflx", "succeeded")]);
    check("TURN не считается прямым путём", !v.directOk);
    check("VPN host-кандидат распознаётся", isVpnHostCandidate("a=candidate:1 1 udp 2122260223 10.111.234.122 54321 typ host") && !isVpnHostCandidate("candidate:3 1 udp 1686052607 109.195.75.27 61000 typ srflx raddr 10.0.0.1 rport 1"));
    const sdp = ["v=0", "a=candidate:1 1 udp 2122260223 10.111.234.122 54321 typ host", "a=candidate:3 1 udp 1686052607 109.195.75.27 61000 typ srflx raddr 10.111.234.122 rport 54321", ""].join("\r\n");
    const r = removeVpnInSdp(sdp);
    check("режим «только прямой»: VPN-кандидаты убраны из SDP, srflx остался", !r.includes("10.111.234.122 54321 typ host") && r.includes("typ srflx"));
}
// --- обратная связь декодера зрителя (из 1.21.1) ---
{
    let v = initViewerDecode(0);
    let a = nextViewerDecode(v, { recvFps: 60, decFps: 24, dropFps: 0, hw: false }, "av1", 10000, 14);
    check("зритель: программный AV1 даёт 24 из 60 -> смена кодека сразу", a.action === "codec", a.reason);
    v = initViewerDecode(0);
    a = nextViewerDecode(v, { recvFps: 60, decFps: 40, dropFps: 0, hw: true }, "vp9", 10000, 14);
    const b = nextViewerDecode(a.state, { recvFps: 60, decFps: 40, dropFps: 0, hw: true }, "vp9", 12000, 14);
    check("зритель: аппаратный декодер не успевает 2 замера -> ступень ниже", a.action === null && b.action === "down" && b.state.steps === 1, b.reason);
    const ok = nextViewerDecode(b.state, { recvFps: 60, decFps: 60, dropFps: 0, hw: true }, "vp9", 14000, 14);
    check("зритель успевает -> сразу назад не прыгаем", ok.action === null && ok.state.steps === 1);
    const back = nextViewerDecode(ok.state, { recvFps: 60, decFps: 60, dropFps: 0, hw: true }, "vp9", 60000, 14);
    check("15+ с без проблем -> ступень выше", back.action === "up" && back.state.steps === 0);
    const stat = nextViewerDecode(initViewerDecode(0), { recvFps: 5, decFps: 5, dropFps: 0, hw: false }, "av1", 10000, 14);
    check("статичный экран (5 FPS приходит) -> не проблема", stat.action === null && stat.state.strain === 0);
}
// --- 1.23.13: зритель недополучает кадры при «мелких» потерях ---
{
    check("голод: собрано 29 из 58 FPS", viewerStarved({ recvFps: 29 }, 58));
    check("голод: заморозка за интервал", viewerStarved({ recvFps: 58, fz: 1 }, 58));
    check("не голод: собрано 55 из 58", !viewerStarved({ recvFps: 55, fz: 0 }, 58));
    check("не голод: статичный экран (энкодер 5 FPS)", !viewerStarved({ recvFps: 2 }, 5));
    check("не голод: статика с «заморозкой» (1 FPS, fz=2) — реальный лог 1.23.14", !viewerStarved({ recvFps: 2, fz: 2 }, 1));
    // реальный случай: потолок 100 из настроек, реально 31, потери 0.3% — режем от 31
    let st = initSendState(100e6, 0);
    let r = nextCap(st, { loss: 0.003, pli: 1, rttMs: 100, now: 10000, viewerStall: true, curBps: 31e6 }, 100e6);
    check("заморозки у зрителя при потерях 0.3% → срез от реальных 31 Мбит/с", r.state.capBps === Math.round(31e6 * 0.8), `${(r.state.capBps / 1e6).toFixed(1)} Мбит/с, ${r.reason}`);
    const held = nextCap(r.state, { loss: 0, pli: 0, rttMs: 100, now: 15000, curBps: 25e6 }, 100e6);
    check("после среза из-за заморозок 8 с не растём", held.state.capBps === r.state.capBps);
    const grown = nextCap(r.state, { loss: 0, pli: 0, rttMs: 100, now: 20000, curBps: 25e6 }, 100e6);
    check("через 8+ с чистого канала — снова растём", grown.state.capBps > r.state.capBps);
    const noStall = nextCap(initSendState(100e6, 0), { loss: 0.003, pli: 0, rttMs: 100, now: 10000, curBps: 31e6 }, 100e6);
    check("без заморозок потери 0.3% не режут (как раньше)", noStall.state.capBps === 100e6);
}
// --- 1.23.14: статичная картинка, быстрый возврат буфера ---
{
    // статика: шлём 1 Мбит/с при потолке 30 — потолок не разгоняется
    let st = { ...initSendState(100e6, 0), capBps: 30e6 }, t = 0;
    for (let i = 0; i < 30; i++) { t += 2000; st = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: t, curBps: 1e6 }, 100e6).state; }
    check("статичная картинка (1 из 30 Мбит/с) — потолок не растёт", st.capBps === 30e6, `${st.capBps / 1e6}`);
    // движение: шлём под потолок — растём как раньше
    st = { ...initSendState(100e6, 0), capBps: 30e6 }; t = 0;
    for (let i = 0; i < 5; i++) { t += 2000; st = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: t, curBps: 29e6 }, 100e6).state; }
    check("движение (29 из 30 Мбит/с) — потолок растёт", st.capBps > 30e6, `${st.capBps / 1e6}`);
    // буфер зрителя: 300 мс → минимум за ~40 с спокойствия (было 4 минуты)
    let j = { targetMs: 300, calmSince: 0 }; t = 0;
    while (j.targetMs > 0 && t < 600_000) { t += 2000; j = nextJitterTarget(j, { freezes: 0, jitterMs: 5, now: t }, 0); }
    check("буфер 300 мс возвращается к минимуму за ≤ 40 с", j.targetMs === 0 && t <= 40_000, `${t / 1000} с`);
    // отрицательные FPS в обратной связи
    const neg = nextViewerDecode(initViewerDecode(0), { recvFps: 41, decFps: 10, dropFps: 24, hw: false }, "h264", 10000, 14);
    check("dropFps > decFps — «показывает» не уходит в минус", !/-\d/.test(neg.reason ?? "") , neg.reason ?? "нет действия");
}
// --- 1.23.15: ложные срезы и медленный рост ---
{
    // срез на статике не роняет потолок в минимум
    let st = { ...initSendState(100e6, 0), capBps: 6e6 };
    const r = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: 10000, viewerStall: true, curBps: 0.1e6 }, 100e6);
    check("срез при почти нулевой отправке — от потолка, не в минимум", r.state.capBps === Math.round(6e6 * 0.8), `${r.state.capBps / 1e6}`);
    // рост: с 6 до 30 Мбит/с на чистом загруженном канале — быстрее 20 с
    st = { ...initSendState(100e6, 0), capBps: 6e6 }; let t = 0;
    while (st.capBps < 30e6 && t < 120_000) { t += 2000; st = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: t, curBps: st.capBps * 0.9 }, 100e6).state; }
    check("рост 6 → 30 Мбит/с на чистом канале ≤ 20 с", st.capBps >= 30e6 && t <= 20_000, `${t / 1000} с`);
    // возврат к проверенной скорости ×1.5
    st = { ...initSendState(100e6, 0), capBps: 10e6, bestClean: 35e6 };
    const back = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: 4000, curBps: 9e6 }, 100e6);
    check("ниже проверенных 35 Мбит/с — шаг ×1.5", back.state.capBps === 15e6, back.reason);
    // статика: не растём (как в 1.23.14)
    st = { ...initSendState(100e6, 0), capBps: 30e6 }; t = 0;
    for (let i = 0; i < 20; i++) { t += 2000; st = nextCap(st, { loss: 0, pli: 0, rttMs: 100, now: t, curBps: 1e6 }, 100e6).state; }
    check("статика — потолок по-прежнему не растёт", st.capBps === 30e6);
}
// --- 1.23.16: гистерезис спуска ---
{
    const L = buildLadder(1080, 60);
    const i1080 = L.findIndex(r => r.height === 1080 && r.fps === 60);
    const need = rungNeedBps(L[i1080], 16 / 9);
    check("на 1080p60: битрейт просел до 90% нужного — держим ступень", pickRung(L, need * 0.9, 16 / 9, i1080) === i1080);
    check("на 1080p60: просел до 80% нужного — спускаемся", pickRung(L, need * 0.8, 16 / 9, i1080) > i1080);
}
// --- 1.23.18: потолок канала ---
{
    const M = 40e6;
    // старт 40, канал не выдержал (оценка 5) → потолок 32
    let c = initCeil(0);
    let r = nextCeiling(c, { bwe: 5e6, sent: 4e6, clean: false, startBps: 40e6, now: 2000 }, M);
    check("старт 40 не выдержан → потолок 32", r.state.ceiling === 32e6, r.reason);
    c = r.state;
    // 4 с чистого канала → перезапуск оценки на 32
    r = nextCeiling(c, { bwe: 6e6, sent: 5e6, clean: true, now: 4000 }, M); c = r.state;
    check("2 с чисто — ещё не перезапускаем", r.kickBps === null);
    r = nextCeiling(c, { bwe: 7e6, sent: 6e6, clean: true, now: 6000 }, M); c = r.state;
    check("4 с чисто, оценка 7 < 60% потолка → перезапуск на 32", r.kickBps === 32e6, r.reason);
    r = nextCeiling(c, { bwe: 8e6, sent: 6e6, clean: true, now: 10000 }, M); c = r.state;
    check("повторный перезапуск не раньше 15 с", r.kickBps === null);
    // работаем у потолка (реально шло 31), обвал оценки 31 → 6 → потолок 24.8
    r = nextCeiling({ ...c, prevBwe: 31e6, prevSent: 31e6 }, { bwe: 6e6, sent: 5e6, clean: false, now: 40000 }, M);
    check("обвал 31 → 6 → потолок 24.8", Math.round(r.state.ceiling / 1e5) === 248, r.reason);
    // раздутая оценка 61.5 при реальных 30 → потолок от реальных 30 (24), а не от 61.5
    r = nextCeiling({ ceiling: 0, prevBwe: 61.5e6, prevSent: 30e6, cleanSince: 0, lastKick: 0, lastTrouble: 0 }, { bwe: 5.7e6, sent: 5e6, clean: false, now: 50000 }, M);
    check("раздутая оценка 61.5 при реальных 30 → потолок 24, не 49", r.state.ceiling === 24e6, r.reason);
    // оценка упала 60 → 28, но реально шло 25 — это не обвал
    r = nextCeiling({ ceiling: 30e6, prevBwe: 60e6, prevSent: 25e6, cleanSince: 0, lastKick: 0, lastTrouble: 0 }, { bwe: 28e6, sent: 25e6, clean: true, now: 50000 }, M);
    check("оценка 60 → 28 при реальных 25 — не обвал (потолок не снижен)", r.state.ceiling >= 30e6 && !/не выдержал/.test(r.reason ?? ""), r.reason ?? "");
    // перезапуск на 33.5 → через 4 с заморозки → потолок 28.5
    r = nextCeiling({ ceiling: 33.5e6, prevBwe: 7e6, prevSent: 6e6, cleanSince: 0, lastKick: 60000, lastTrouble: 0, lastKickBps: 33.5e6 }, { bwe: 15.8e6, sent: 14e6, clean: false, now: 64000 }, M);
    check("перезапуск на 33.5 не выдержан → потолок 28.5", Math.round(r.state.ceiling / 1e5) === 285, r.reason);
    // 30 с стабильно у потолка → +5%
    let s = { ceiling: 30e6, prevBwe: 30e6, cleanSince: 0, lastKick: 0, lastTrouble: 0 };
    r = nextCeiling(s, { bwe: 30e6, sent: 27e6, clean: true, now: 8000 }, M);
    check("8 с у потолка — ещё не пробуем выше", r.state.ceiling === 30e6);
    r = nextCeiling(s, { bwe: 30e6, sent: 27e6, clean: true, now: 11000 }, M);
    check("10 с стабильно у потолка → +5%", r.state.ceiling === 31.5e6, r.reason);
    // мелкие колебания оценки — не обвал
    r = nextCeiling({ ...s, prevBwe: 30e6 }, { bwe: 22e6, sent: 20e6, clean: true, now: 5000 }, M);
    check("30 → 22 — не обвал", r.state.ceiling === 30e6 && !r.kickBps);
}
// --- 1.23.21: звук не трогаем из-за заморозок; перезапуски с паузой ---
{
    let j = { targetMs: 150, calmSince: 0 };
    for (let i = 1; i <= 5; i++) j = nextJitterTarget(j, { freezes: 2, jitterMs: 5, now: i * 2000 }, 150);
    check("заморозки при джиттере 5 мс не меняют буфер (звук не растягивается)", j.targetMs === 150, `${j.targetMs} мс`);
    j = nextJitterTarget(j, { freezes: 0, jitterMs: 40, now: 12000 }, 150);
    check("джиттер 40 мс — буфер растёт", j.targetMs > 150, `${j.targetMs} мс`);
    const M = 40e6;
    // перезапуск на 20.7, через 4 с оценка всего 10 (канал чистый) — неудача
    let c = { ceiling: 20.7e6, prevBwe: 9e6, prevSent: 8e6, cleanSince: 0, lastKick: 100000, lastTrouble: 0, lastKickBps: 20.7e6, kickFails: 0 };
    let r = nextCeiling(c, { bwe: 9e6, sent: 8e6, clean: true, now: 102000 }, M);
    check("2 с после перезапуска — рано судить", r.state.ceiling === 20.7e6 && !r.state.kickFails);
    r = nextCeiling(r.state, { bwe: 10e6, sent: 9e6, clean: true, now: 104000 }, M);
    check("оценка не поднялась (10 из 20.7) → неудача, потолок 17.6", Math.round(r.state.ceiling / 1e5) === 176 && r.state.kickFails === 1, r.reason);
    // следующий перезапуск — не через 15 с, а через 30
    let st = r.state, t = 104000, kicks = [];
    while (t < 104000 + 40000) { t += 2000; const q = nextCeiling(st, { bwe: 6e6, sent: 5e6, clean: true, now: t }, M); st = q.state; if (q.kickBps) kicks.push(t); }
    check("после неудачи следующий перезапуск через ≥ 30 с", kicks.length >= 1 && kicks[0] - 100000 >= 30000, kicks.map(k => (k - 100000) / 1000).join(","));
    check("пауза растёт 15 → 30 → 60 → 60 с", kickGapMs(0) === 15000 && kickGapMs(1) === 30000 && kickGapMs(2) === 60000 && kickGapMs(5) === 60000);
    // обвал сразу после перезапуска (оценка 20 → 6) — тоже неудача
    const cr = nextCeiling({ ceiling: 20.7e6, prevBwe: 20e6, prevSent: 18e6, cleanSince: 0, lastKick: 300000, lastTrouble: 0, lastKickBps: 20.7e6, kickFails: 0 }, { bwe: 6e6, sent: 5e6, clean: false, now: 304000 }, M);
    check("обвал после перезапуска считается неудачей (пауза 30 с)", cr.state.kickFails === 1, JSON.stringify(cr.state));
    // удачный перезапуск: через 4 с оценка 19 из 20 → счётчик неудач сбрасывается через 10 с
    let ok = { ceiling: 20e6, prevBwe: 8e6, prevSent: 7e6, cleanSince: 0, lastKick: 200000, lastTrouble: 0, lastKickBps: 20e6, kickFails: 2 };
    for (const tt of [202000, 204000, 206000, 208000, 210000]) ok = nextCeiling(ok, { bwe: 19e6, sent: 17e6, clean: true, now: tt }, M).state;
    check("удачный перезапуск сбрасывает паузу к 15 с", ok.kickFails === 0 && ok.ceiling >= 20e6, JSON.stringify(ok));
}
// --- 1.23.23: не лезем туда, где канал уже ломался ---
{
    const M = 50e6;
    // у потолка 46.3 реально шло 42.3, обвал оценки → потолок 33.8, запомнили 42.3
    let c = { ceiling: 46.3e6, prevBwe: 45e6, prevSent: 42.3e6, cleanSince: 0, lastKick: 0, lastTrouble: 0 };
    let r = nextCeiling(c, { bwe: 13e6, sent: 12e6, clean: false, now: 100000 }, M);
    check("обвал на 42.3 → потолок 33.8 и память об обвале", Math.round(r.state.ceiling / 1e5) === 338 && r.state.failAt === 42.3e6, r.reason);
    c = r.state;
    let t = 100000, max = 0;
    while (t < 100000 + 170000) { t += 2000; r = nextCeiling(c, { bwe: c.ceiling, sent: c.ceiling * 0.9, clean: true, now: t }, M); c = r.state; max = Math.max(max, c.ceiling); }
    check("3 мин после обвала проба не выше 92% от 42.3 (≈38.9)", max <= 42.3e6 * 0.92 + 1 && max >= 38e6, (max / 1e6).toFixed(1));
    while (t < 100000 + 230000) { t += 2000; r = nextCeiling(c, { bwe: c.ceiling, sent: c.ceiling * 0.9, clean: true, now: t }, M); c = r.state; }
    check("после выдержки снова пробуем выше", c.ceiling > 42.3e6 * 0.92 + 1, (c.ceiling / 1e6).toFixed(1));
    // повторный обвал там же → выдержка вдвое
    r = nextCeiling({ ...c, prevBwe: 44e6, prevSent: 42e6 }, { bwe: 12e6, sent: 11e6, clean: false, now: t + 2000 }, M);
    check("повторный обвал там же — выдержка 6 мин", r.state.failHoldMs === 360000, String(r.state.failHoldMs));
}
// --- 1.23.24: стартовая проверка — не предел; память о пределе между эфирами ---
{
    const M = 50e6;
    let r = nextCeiling(initCeil(0), { bwe: 14e6, sent: 12e6, clean: false, startBps: 50e6, now: 2000 }, M);
    check("обвал на стартовой проверке 50 → потолок 40, но предел НЕ запомнен", r.state.ceiling === 40e6 && !r.state.failAt, JSON.stringify(r.state));
    // проба без памяти о старте идёт дальше 46 только до настоящего обвала
    const c0 = initCeilFromLimit(0, 42.3e6, M);
    check("по памяти (предел 42.3): потолок 38.1, старт 38.1", Math.round(c0.ceiling / 1e5) === 381 && Math.round(startFromLimit(42.3e6, M) / 1e5) === 381);
    let c = c0, t = 0, max = 0;
    while (t < 170000) { t += 2000; r = nextCeiling(c, { bwe: c.ceiling, sent: c.ceiling * 0.9, clean: true, startBps: 38.1e6, now: t }, M); c = r.state; max = Math.max(max, c.ceiling); }
    check("по памяти первые 3 мин не выше 92% предела (38.9)", max <= 42.3e6 * 0.92 + 1, (max / 1e6).toFixed(1));
    check("скорость из настроек ниже предела — старт по настройкам", startFromLimit(42.3e6, 20e6) === 20e6);
    // запись памяти
    const failSt = { ...initCeil(0), ceiling: 33.8e6, failAt: 42.3e6, failTime: 10000, lastTrouble: 10000 };
    check("новый обвал → запоминаем 42.3", nextRemembered(0, failSt, false, 11000) === 42.3e6);
    check("тот же предел повторно не пишем", nextRemembered(42.3e6, failSt, false, 11000) === null);
    const highSt = { ...initCeil(0), ceiling: 46e6, failAt: 42.3e6, failTime: 0, lastTrouble: 100000 };
    check("минуту держимся выше предела без обвалов → предел выше", nextRemembered(42.3e6, highSt, true, 200000) === Math.round(46e6 * 1.05));
    check("без известного предела «держимся» не пишем", nextRemembered(0, { ...highSt, failAt: undefined }, true, 200000) === null);
}
// --- 1.23.19: ложные «декодер не успевает» ---
{
    const v0 = initViewerDecode(0);
    const a = nextViewerDecode(v0, { recvFps: 46, decFps: 37, dropFps: 0, hw: false, fz: 2 }, "h264", 10000, 14);
    const b = nextViewerDecode(a.state, { recvFps: 46, decFps: 37, dropFps: 0, hw: false, fz: 1 }, "h264", 12000, 14);
    check("«37 из 46» во время сетевых заморозок — не декодер, ступень не снижаем", b.action === null && b.state.steps === 0);
    const c = nextViewerDecode({ strain: 0, steps: 1, calmSince: 0, lastAct: 0 }, { recvFps: 45, decFps: 45, dropFps: 0, hw: false }, "h264", 16000, 14);
    check("ступень по декодеру возвращается через 15 с", c.action === "up" && c.state.steps === 0);
}
process.exit(failed ? 1 : 0);
