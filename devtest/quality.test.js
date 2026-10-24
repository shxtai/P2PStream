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
const { initSendState, nextCap, scaleFor, nextJitterTarget, MIN_CAP_BPS, nextDecodeTrouble, nextEncoderStall, fallbackCodec, DECODE_TROUBLE_LIMIT, initFpsState, nextFpsCap, fpsSteps, effectiveCap, qualityFpsCap, buildLadder, pickRung, rungNeedBps, initCpuState, nextCpuSteps, sendCap, startBitrateBps, withStartBitrate, BW_STEP_RECOVER, reorderAnswerCodecs, demoteVpnCandidate, demoteVpnInSdp, isPrivateOrVpnIPv4, srflxIps, peerIsRemote, directPathVerdict, isVpnHostCandidate, removeVpnInSdp } = mod.exports;

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
process.exit(failed ? 1 : 0);
