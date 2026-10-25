#!/usr/bin/env node
/*
 * (1.23.23) Прямая доставка звука под зависаниями главного потока окна.
 * Node = main-процесс (настоящий audioWs.ts, PCM 10 мс каждые 10 мс, как хелпер);
 * headless Chrome = рендерер с НАСТОЯЩИМ ворклетом (из nativeAudio.ts) и Worker
 * (audioWsWorker.ts). Главный поток страницы раз в 1.5 с виснет на 400 мс.
 *   режим poll   — как раньше: главный поток сам принимает PCM и шлёт в ворклет;
 *   режим direct — Worker → ворклет напрямую.
 * Ждём: у direct провалов доставки нет, у poll — есть.
 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function load(file, globalName) {
    const out = await esbuild.build({ entryPoints: [path.join(ROOT, file)], bundle: true, write: false, platform: "node", format: "cjs" });
    const m = { exports: {} };
    new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require);
    return m.exports;
}

(async () => {
    const { AudioWsServer } = await load("audioWs.ts");
    const src = fs.readFileSync(path.join(ROOT, "nativeAudio.ts"), "utf8");
    const WORKLET = src.split("const WORKLET_SRC = `")[1].split("`;")[0];
    const WORKER = fs.readFileSync(path.join(ROOT, "audioWsWorker.ts"), "utf8").split("AUDIO_WS_WORKER_SRC = `")[1].split("`;")[0];

    const srv = new AudioWsServer();
    const port = await srv.start();
    // «хелпер»: 10 мс стерео float32 каждые 10 мс (по часам, с догонкой)
    const t0 = Date.now(); let sent = 0;
    const helper = setInterval(() => {
        const due = Math.floor((Date.now() - t0) / 10);
        while (sent < due) { const b = Buffer.alloc(480 * 8); for (let i = 0; i < 960; i++) b.writeFloatLE(Math.sin(i / 10) * 0.2, i * 4); srv.send(b, 8); sent++; }
    }, 5);

    const page = String.raw`
    (async () => {
      const mode = "__MODE__";
      const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume();
      const wurl = URL.createObjectURL(new Blob([${JSON.stringify(WORKLET)}], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(wurl);
      const node = new AudioWorkletNode(ctx, "vc-p2p-ring", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(ctx.createMediaStreamDestination());
      const res = { stalls: 0, pauses: 0, gaps: [] };
      node.port.onmessage = e => { const d = e.data; if (d && d.u) { res.stalls++; res.gaps.push(d.ms); } if (d && d.p) res.pauses++; };
      const url = "ws://127.0.0.1:${port}/${srv.token}";
      if (mode === "direct") {
        const ch = new MessageChannel();
        node.port.postMessage({ port: ch.port2 }, [ch.port2]);
        const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: "text/javascript" })));
        w.postMessage({ url, port: ch.port1 }, [ch.port1]);
      } else {
        const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
        ws.onmessage = ev => { const f = new Float32Array(ev.data); node.port.postMessage(f, [ev.data]); };
      }
      await new Promise(r => setTimeout(r, 3000));      // разгон
      res.stalls = 0; res.pauses = 0; res.gaps = [];
      // 20 с: каждые 1.5 с главный поток виснет на 400 мс
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        await new Promise(r => setTimeout(r, 1100));
        const b = Date.now(); while (Date.now() - b < 400) { }
      }
      window.__result = mode + ": провалов доставки " + res.stalls + " (" + res.gaps.join(",") + " мс), пауз " + res.pauses;
      window.__stalls = res.stalls + res.pauses;
    })().catch(e => { window.__result = "ERR " + e; window.__stalls = -1; });`;

    const http = require("http");
    const web = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>t</title>"); });
    await new Promise(r => web.listen(0, "127.0.0.1", r));
    const pageUrl = "http://127.0.0.1:" + web.address().port + "/";
    const results = {};
    for (const mode of ["poll", "direct"]) {
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-direct-"));
        const cdp = 9450 + (mode === "direct" ? 1 : 0);
        const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, "--no-first-run", "--autoplay-policy=no-user-gesture-required", pageUrl], { stdio: "ignore" });
        try {
            let wsUrl;
            for (let i = 0; i < 75 && !wsUrl; i++) { await sleep(200); try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch { } }
            const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
            ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
            await new Promise(r => ws.onopen = r);
            const call = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
            await call("Page.navigate", { url: pageUrl });
            await sleep(1500);
            const ev = await call("Runtime.evaluate", { expression: page.replace("__MODE__", mode) });
            if (ev?.exceptionDetails) console.log("  eval:", JSON.stringify(ev.exceptionDetails).slice(0, 300));
            for (let t = 0; t < 60; t++) {
                await sleep(1000);
                const r = await call("Runtime.evaluate", { expression: "window.__result ? [window.__result, window.__stalls] : null", returnByValue: true });
                if (r?.result?.value) { console.log("  " + r.result.value[0]); results[mode] = r.result.value[1]; break; }
            }
            ws.close();
        } finally { chrome.kill(); await sleep(300); }
    }
    clearInterval(helper);
    srv.close();
    web.close();
    const ok = results.direct === 0 && results.poll > 0;
    console.log(`${ok ? "✔" : "✘"} прямая доставка переживает зависания главного потока: разрывов звука direct ${results.direct}, poll ${results.poll}`);
    process.exit(ok ? 0 : 1);
})();
