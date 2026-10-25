#!/usr/bin/env node
/*
 * Модель нативного звука под нагрузкой игры: node audio.test.js [git-ревизия для сравнения]
 * Хелпер выдаёт 10 мс звука каждые 10 мс; рендерер забирает по таймеру, но под
 * нагрузкой опаздывает (0–4 мс обычно, 20–60 мс часто, 100–180 мс изредка);
 * аудиопоток играет блоки по 128 кадров строго по часам. Сравниваем провалы.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function workletFrom(src) {
    const code = src.split("const WORKLET_SRC = `")[1].split("`;")[0];
    let Cls;
    const g = { AudioWorkletProcessor: class { constructor() { this.reported = []; this.port = { postMessage: v => this.reported.push(v) }; } }, registerProcessor: (_n, c) => { Cls = c; } };
    new Function("AudioWorkletProcessor", "registerProcessor", code)(g.AudioWorkletProcessor, g.registerProcessor);
    const pull = Number(/const PULL_INTERVAL_MS = (\d+)/.exec(src)?.[1] ?? 20);
    return { Cls, pull };
}

/** детерминированный ГПСЧ — одинаковые задержки для старого и нового варианта */
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function simulate({ Cls, pull }, seed, seconds = 60, light = false) {
    const rand = rng(seed);
    const w = new Cls();
    let mainQueue = 0;            // кадров в очереди main-процесса
    let pushed = 0, played = 0, silentBlocks = 0, dropouts = 0, started = false, wasPlaying = false;
    let nextPull = 0, lagSum = 0, lagN = 0;
    const blockMs = 128 / 48;     // 2.667 мс
    let nextBlock = 0;
    for (let t = 0; t <= seconds * 1000; t += 0.5) {
        if (t % 10 === 0) mainQueue += 480;                 // хелпер: 10 мс звука
        if (t >= nextPull) {                                 // рендерер забирает (с опозданием под нагрузкой)
            const r = rand();
            // light — без игры: рывки редкие и короткие
            const stall = light ? (r < 0.98 ? rand() * 4 : 15 + rand() * 20) : r < 0.85 ? rand() * 4 : r < 0.97 ? 20 + rand() * 40 : 100 + rand() * 80;
            const deliverAt = t + stall;
            const frames = mainQueue; mainQueue = 0;
            if (frames) {
                pending.push({ at: deliverAt + 1, frames });
                pushed += frames;
            }
            nextPull = Math.max(t + pull, deliverAt);       // без нахлёста
        }
        while (pending.length && pending[0].at <= t) {
            const p = pending.shift();
            w.port.onmessage({ data: new Float32Array(p.frames * 2).fill(0.5) });
        }
        if (t >= nextBlock) {
            nextBlock += blockMs;
            const L = new Float32Array(128), R = new Float32Array(128);
            w.process([], [[L, R]]);
            const playing = L[0] !== 0 || L[127] !== 0;
            const n = L.reduce((a, v) => a + (v !== 0 ? 1 : 0), 0);
            played += n;
            if (playing) started = true;
            if (started) {
                if (n < 128) silentBlocks++;
                if (wasPlaying && n < 128) dropouts++;
            }
            wasPlaying = n === 128;
            lagSum += w.count / 2 / 48; lagN++;
        }
    }
    const dropped = pushed - played - w.count / 2 - pending.reduce((a, p) => a + p.frames, 0);
    // 1.23.7: ворклет сообщает уровень буфера (по нему зритель сдвигает видео под звук)
    const rep = (w.reported ?? []).filter(v => typeof v === "number");
    const reportedMs = rep.length ? Math.round(rep.slice(-50).reduce((a, v) => a + v, 0) / Math.min(50, rep.length)) : -1;
    return { reportedMs, reports: rep.length, dropouts, silentMs: Math.round(silentBlocks * blockMs), droppedMs: Math.round(Math.max(0, dropped) / 48), lagMs: Math.round(lagSum / lagN) };
}
let pending = [];

const cur = workletFrom(fs.readFileSync(path.join(__dirname, "..", "nativeAudio.ts"), "utf8"));
const rev = process.argv[2] || "6213930";
const old = workletFrom(execSync(`git show ${rev}:nativeAudio.ts`, { cwd: path.join(__dirname, ".."), encoding: "utf8" }));

let failed = 0;
const sum = (o, k) => o.reduce((a, r) => a + r[k], 0);
const runs = (impl) => [1, 2, 3, 4, 5].map(seed => { pending = []; return simulate(impl, seed); });
const a = runs(old), b = runs(cur);
for (const [name, r, impl] of [[`было (${rev}, забор ${old.pull} мс)`, a, old], [`стало (забор ${cur.pull} мс)`, b, cur]]) {
    console.log(`${name}: провалов ${sum(r, "dropouts")}, тишины ${sum(r, "silentMs")} мс, выброшено ${sum(r, "droppedMs")} мс за 5×60 с, задержка ~${Math.round(sum(r, "lagMs") / r.length)} мс`);
}
const ok = sum(b, "dropouts") <= sum(a, "dropouts") / 3 && sum(b, "droppedMs") <= sum(a, "droppedMs");
console.log(`${ok ? "✔" : "✘"} провалов звука под нагрузкой стало минимум втрое меньше и ничего лишнего не выбрасывается`);
const lagOk = Math.round(sum(b, "lagMs") / b.length) <= 250;
console.log(`${lagOk ? "✔" : "✘"} добавленная задержка звука в разумных пределах (≤ 250 мс)`);
// уровень, который ворклет сообщает наружу, совпадает с реальной задержкой (±40 мс):
// по нему зритель задерживает видео — неверное значение дало бы рассинхрон
const repMs = Math.round(b.reduce((a, r) => a + r.reportedMs, 0) / b.length);
const realMs = Math.round(sum(b, "lagMs") / b.length);
const repOk = b.every(r => r.reports > 100) && Math.abs(repMs - realMs) <= 40;
console.log(`${repOk ? "✔" : "✘"} ворклет сообщает уровень буфера: ${repMs} мс (реально ~${realMs} мс)`);
// без игры (рабочий стол, видео): адаптивный запас держит малую задержку без провалов
const lightRuns = [1, 2, 3, 4, 5].map(seed => { pending = []; return simulate(cur, seed, 60, true); });
const lightLag = Math.round(sum(lightRuns, "lagMs") / lightRuns.length);
const lightOk = lightLag <= 120 && sum(lightRuns, "dropouts") <= 5;
console.log(`без игры: провалов ${sum(lightRuns, "dropouts")}, задержка ~${lightLag} мс`);
console.log(`${lightOk ? "✔" : "✘"} без нагрузки задержка звука ≤ 120 мс и почти без провалов`);
process.exit(ok && lagOk && repOk && lightOk ? 0 : 1);
