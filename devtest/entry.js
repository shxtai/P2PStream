// Участник стенда: НАСТОЯЩИЙ движок плагина (engine/signaling/broker) + заглушка Discord.
import { manager, mediaReport, probeNat } from "@p2p/engine";
import { settings } from "@p2p/settings";

import { fluxHandlers, ME } from "./stubs/common.js";

const q = new URLSearchParams(location.search);
const role = q.get("role");
const relay = q.get("relay");
settings.store.audioMode = "off"; // нативного хелпера в браузере нет
if (q.get("bitrate")) settings.store.videoBitrate = Number(q.get("bitrate")); // Мбит/с, как в настройках
if (q.get("codec")) settings.store.codec = q.get("codec");
if (relay) {
    if (role === "host") {
        // TURN есть только у хоста — зритель должен получить его в оффере
        settings.store.turnUrl = relay;
        settings.store.turnUser = "devtest";
        settings.store.turnPassword = "devtest";
    } else {
        settings.store.relayOnly = true; // прямые пути запрещены
    }
}

// доступ к (фейковой) камере — Chrome тогда показывает имена энкодера/декодера в getStats
void navigator.mediaDevices?.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => { });
fluxHandlers.push(manager.onMessageCreate);
manager.start();

function status(text) { parent.postMessage({ kind: "status", from: ME, text }, "*"); }
function report(dir, line) { parent.postMessage({ kind: "log", text: `[report ${dir}] ${line}` }, "*"); }

/** тип выбранной пары кандидатов: host / srflx / relay */
async function pathOf(pc) {
    try {
        const r = await pc.getStats();
        let pair = null;
        r.forEach(s => { if (s.type === "transport" && s.selectedCandidatePairId) pair = r.get(s.selectedCandidatePairId); });
        return pair ? `${r.get(pair.localCandidateId)?.candidateType}↔${r.get(pair.remoteCandidateId)?.candidateType}` : "?";
    } catch { return "?"; }
}

if (role === "host") {
    // «экран» хоста — анимированный canvas
    // ?heavy — 1280x720 с шумом: «тяжёлый» контент как игра, энкодер просит много битрейта
    const heavy = q.has("heavy");
    const W = heavy ? 1280 : 640, H = heavy ? 720 : 360;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const noise = heavy ? ctx.createImageData(W, H) : null;
    let f = 0;
    setInterval(() => {
        if (noise) {
            const d = noise.data;
            for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = v; d[i + 1] = (v + f) % 255; d[i + 2] = 255 - v; d[i + 3] = 255; }
            ctx.putImageData(noise, 0, 0);
        } else {
            ctx.fillStyle = `hsl(${(f * 7) % 360},70%,50%)`;
            ctx.fillRect(0, 0, W, H);
        }
        f++;
        ctx.fillStyle = "#fff"; ctx.font = "48px sans-serif"; ctx.fillText(String(f), 40, 100);
    }, 33);
    void manager.startShareWithCapture(canvas.captureStream(30), null).then(() => status("host started"));
    // отчёт /p2p-doctor хоста через 4 с после соединения со зрителем
    let reported = false;
    const watchPeers = setInterval(() => {
        const peer = manager.host?.peers.values().next().value;
        if (!peer || peer.pc.connectionState !== "connected" || reported) return;
        reported = true;
        clearInterval(watchPeers);
        setTimeout(async () => { for (const l of await mediaReport(peer.pc, "out")) report("OUT", l); }, 4000);
        // ?switch — проверка смены кодека на лету (как при сбое декодирования у зрителя)
        if (q.has("switch")) setTimeout(() => report("OUT", `switchCodec: ${peer.switchCodec("тест стенда")}`), 6000);
    }, 500);
} else {
    void probeNat().then(r => status(`NAT: ${r}`));
    let t0 = Date.now(); // сбрасывается в момент watch(): меряем подключение, а не ожидание анонса
    const video = Object.assign(document.createElement("video"), { muted: true, autoplay: true });
    const tick = setInterval(() => {
        const host = [...manager.liveHosts.values()][0];
        if (host && !manager.watches.size) { t0 = Date.now(); manager.watch(host.streamId); }
        const w = [...manager.watches.values()][0];
        if (w) {
            if (video.srcObject !== w.stream && w.stream.getTracks().length) {
                video.srcObject = w.stream;
                void video.play().catch(() => { });
            }
            if (w.state === "live" && video.videoWidth > 0 && video.currentTime > 1) {
                clearInterval(tick);
                const secs = ((Date.now() - t0) / 1000).toFixed(1);
                void (async () => {
                    // отчёт /p2p-doctor зрителя (VERBOSE=1 — виден в выводе)
                    // через 15 с — когда оценка канала (BWE) уже разогналась
                    await new Promise(r => setTimeout(r, q.has("heavy") ? 15000 : 0));
                    for (const l of await mediaReport(w.pc, "in")) report("IN ", l);
                    status(`OK: видео ${video.videoWidth}x${video.videoHeight} через ${secs} с, путь ${await pathOf(w.pc)}`);
                })();
                return;
            }
        }
        if (Date.now() - t0 > 100_000) {
            clearInterval(tick);
            status(`FAIL: state=${w?.state} pc=${w?.pc?.connectionState}`);
        }
    }, 500);
}
