#!/usr/bin/env node
/*
 * Сквозной тест P2PStream без Discord: настоящий код движка (engine/signaling/
 * broker) в двух iframe headless-Chrome, Discord заменён пересыльщиком сообщений
 * с задержкой и потерями. Проверяет всю цепочку: анонс -> join -> offer ->
 * answer -> ICE -> видео идёт у зрителя.
 *
 *   cd devtest && npm i && npm test               # стандартные сценарии
 *   node run.js "delay=800&loss=0.5"              # свой сценарий
 *   CHROME="C:/путь/chrome.exe" npm test          # если Chrome не найден
 *
 * Нужны Node 22+ (встроенный WebSocket) и Chrome/Edge.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
/** «relay» в сценарии: поднимается локальный TURN, зритель ходит ТОЛЬКО через него */
const SCENARIOS = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["delay=300", "delay=800&loss=0.3", "delay=1000&loss=0.5", "delay=300&relay"];

function lanIp() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
    }
    return null;
}

/** Локальный TURN (node-turn) для сценариев с relay */
function startTurn(ip) {
    const Turn = require("node-turn");
    const server = new Turn({
        authMech: "long-term",
        credentials: { devtest: "devtest" },
        listeningIps: [ip],
        relayIps: [ip],
        listeningPort: 3479,
        debugLevel: "OFF"
    });
    server.start();
    return server;
}
const VERBOSE = !!process.env.VERBOSE;

function findChrome() {
    const cands = [
        process.env.CHROME,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ].filter(Boolean);
    return cands.find(p => fs.existsSync(p));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runScenario(chromePath, query, port) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "p2pstream-devtest-"));
    // эмуляция плохого канала средствами самого WebRTC: link=кбит/с, plr=% потерь, qdelay=мс
    const qp = new URLSearchParams(query);
    const net = [];
    if (qp.get("link")) net.push(`link_capacity_kbps:${qp.get("link")}`);
    if (qp.get("plr")) net.push(`loss_percent:${qp.get("plr")}`);
    if (qp.get("qdelay")) net.push(`queue_delay_ms:${qp.get("qdelay")}`);
    const extra = net.length ? [`--force-fieldtrials=WebRTC-FakeNetworkSendConfig/${net.join(",")}/`] : [];
    const chrome = spawn(chromePath, [
        "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
        "--no-first-run", "--autoplay-policy=no-user-gesture-required", ...extra, "about:blank"
    ], { stdio: "ignore" });
    try {
        let wsUrl;
        for (let i = 0; i < 75 && !wsUrl; i++) {
            await sleep(200);
            try {
                const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
                wsUrl = list.find(t => t.type === "page")?.webSocketDebuggerUrl;
            } catch { /* ещё стартует */ }
        }
        if (!wsUrl) return "FAIL: Chrome не запустился";
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.onmessage = e => {
            const m = JSON.parse(e.data);
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
            if (VERBOSE && m.method === "Runtime.consoleAPICalled") {
                console.log("   ", m.params.args.map(a => a.value ?? a.description).join(" "));
            }
        };
        await new Promise(r => { ws.onopen = r; });
        const call = (method, params = {}) => new Promise(r => {
            const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
        });
        await call("Runtime.enable");
        const url = "file:///" + path.join(__dirname, "index.html").replace(/\\/g, "/") + "?" + query;
        await call("Page.navigate", { url });
        const t0 = Date.now();
        while (Date.now() - t0 < 240_000) { // анонс при потерях может идти до ~80 с + подключение
            await sleep(1000);
            const r = await call("Runtime.evaluate", { expression: "window.__result || null", returnByValue: true });
            if (r?.result?.value) { ws.close(); return r.result.value; }
        }
        ws.close();
        return "FAIL: нет результата за 240 с";
    } finally {
        chrome.kill();
        await sleep(300);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* профиль занят — не страшно */ }
    }
}

(async () => {
    const chromePath = findChrome();
    if (!chromePath) {
        console.error("Chrome/Edge не найден — укажите путь в переменной CHROME");
        process.exit(2);
    }
    const stub = p => path.join(__dirname, "stubs", p);
    await esbuild.build({
        entryPoints: [path.join(__dirname, "entry.js")],
        bundle: true,
        format: "iife",
        target: "chrome120",
        outfile: path.join(__dirname, "bundle.js"),
        logLevel: "warning",
        alias: {
            "@webpack/common": stub("common.js"),
            "@utils/Logger": stub("misc.js"),
            "@utils/types": stub("misc.js"),
            "@api/Settings": stub("misc.js"),
            "@p2p": ROOT
        }
    });
    let failed = 0;
    let port = 9400;
    for (const scenario of SCENARIOS) {
        let q = scenario;
        let turn = null;
        if (/(^|&)relay(&|$)/.test(q)) {
            const ip = lanIp();
            if (!ip) { console.log(`✘ [${scenario}] нет LAN-адреса для TURN`); failed++; continue; }
            turn = startTurn(ip);
            q = q.replace(/(^|&)relay(?=&|$)/, `$1relay=${encodeURIComponent(`turn:${ip}:3479`)}`);
        }
        const res = await runScenario(chromePath, q, port++);
        turn?.stop();
        // в relay-сценарии успех засчитывается, только если путь реально через TURN
        const ok = res.startsWith("OK") && (!turn || /relay/.test(res));
        if (!ok) failed++;
        console.log(`${ok ? "✔" : "✘"} [${scenario}] ${res}`);
    }
    process.exit(failed ? 1 : 0);
})();
