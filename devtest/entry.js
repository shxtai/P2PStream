// Участник стенда: НАСТОЯЩИЙ движок плагина (engine/signaling/broker) + заглушка Discord.
import { manager, mediaReport, probeNat } from "@p2p/engine";
import { settings } from "@p2p/settings";

import { fluxHandlers, ME } from "./stubs/common.js";

const q = new URLSearchParams(location.search);
const role = q.get("role");
const relay = q.get("relay");
settings.store.audioMode = "off"; // нативного хелпера в браузере нет
// ?nobroker — только Discord-транспорт (брокеры недоступны/заблокированы); ?loss=1 — наоборот, только брокер
if (q.has("nobroker")) settings.store.brokerEnabled = false;
// ?split — стример и зритель на РАЗНЫХ брокерах (реальный случай 1.23.7: hivemq / emqx)
if (q.has("split") && role === "host") settings.store.brokerUrl = "wss://broker.hivemq.com:8884/mqtt";
if (q.get("bitrate")) settings.store.videoBitrate = Number(q.get("bitrate")); // Мбит/с, как в настройках
if (q.get("codec")) settings.store.codec = q.get("codec");
if (q.get("fps")) settings.store.fps = String(q.get("fps"));
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
    const heavy = q.has("heavy") || q.has("big");
    // ?big — 1920x1080 с шумом (тест разгона качества)
    const W = q.has("big") ? 1920 : heavy ? 1280 : 640, H = q.has("big") ? 1080 : heavy ? 720 : 360;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const big = q.has("big");
    // big: шум 320x180, растянутый на 1080p без сглаживания — для энкодера тяжело,
    // а генерация дешёвая (полноразмерный шум на JS сам упирался в процессор)
    const small = big ? Object.assign(document.createElement("canvas"), { width: 320, height: 180 }) : null;
    const sctx = small?.getContext("2d");
    const noise = big ? sctx.createImageData(320, 180) : heavy ? ctx.createImageData(W, H) : null;
    let f = 0;
    setInterval(() => {
        if (big) {
            const d = noise.data;
            for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = v; d[i + 1] = (v + f) % 255; d[i + 2] = 255 - v; d[i + 3] = 255; }
            sctx.putImageData(noise, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(small, 0, 0, W, H);
        } else if (noise) {
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
    void manager.startShareWithCapture(canvas.captureStream(30), null).then(() => {
        // ?ad=N — имитация буфера нативного звука стримера (N мс): зритель должен
        // задержать видео на N (в браузере стенда нативного хелпера нет)
        if (q.get("ad") && manager.host) manager.host.nativeAudio = { track: null, stats: () => ({ levelMs: Number(q.get("ad")) }), stop() { } };
        status("host started");
    });
    // отчёт /p2p-doctor хоста через 4 с после соединения со зрителем
    let reported = false;
    const watchPeers = setInterval(() => {
        const peer = manager.host?.peers.values().next().value;
        if (!peer || peer.pc.connectionState !== "connected" || reported) return;
        reported = true;
        clearInterval(watchPeers);
        // ?directfallback — принудительно «только прямой путь», когда прямого нет
        // (в стенде все адреса частные): стример должен сам вернуть прежний путь
        if (q.has("directfallback")) {
            setTimeout(() => {
                peer.peerRemote = true;
                peer.directChecked = true;
                peer.directOnly = true;
                report("OUT", "стенд: включаю «только прямой путь» без прямого пути");
                void peer.negotiate(true);
                setTimeout(() => {
                    if (peer.pc.connectionState !== "connected") peer.fallbackFromDirect("стенд: 12 с");
                }, 12_000);
                setTimeout(async () => { const ps = (await peer.pc.getStats()); let sel = null; ps.forEach(r => { if (r.type === "transport" && r.selectedCandidatePairId) sel = ps.get(r.selectedCandidatePairId); }); const l = sel && ps.get(sel.localCandidateId), rc = sel && ps.get(sel.remoteCandidateId); report("OUT", `стенд: через 30 с directOnly=${peer.directOnly}, conn=${peer.pc.connectionState}, пара ${l?.candidateType} ${l?.address} ↔ ${rc?.candidateType} ${rc?.address}`); }, 30_000);
            }, 2000);
        }
        // ?kick — через 10 с пересогласовать с «стартом» 25 Мбит/с: оценка должна прыгнуть
        if (q.has("kick")) setTimeout(() => { peer.effSmooth = 25e6; report("OUT", "стенд: пересогласование со стартом 25 Мбит/с"); void peer.negotiate(false); }, 10_000);
        // ?ramp — разгон: каждые 2 с оценка канала, отправка, разрешение (30 с)
        if (q.has("ramp")) {
            const t0r = Date.now(); let prevBytes = 0, prevT = Date.now();
            const ramp = setInterval(async () => {
                const st = await peer.pc.getStats(); let bwe = 0, bytes = 0, h = 0, fps = 0;
                st.forEach(r => {
                    if (r.type === "candidate-pair" && r.nominated && r.availableOutgoingBitrate) bwe = r.availableOutgoingBitrate;
                    if (r.type === "outbound-rtp" && r.kind === "video") { bytes += r.bytesSent; h = r.frameHeight ?? h; fps = r.framesPerSecond ?? fps; }
                });
                const now = Date.now(); const mbps = ((bytes - prevBytes) * 8 / ((now - prevT) / 1000) / 1e6);
                prevBytes = bytes; prevT = now;
                report("OUT", `разгон t=${Math.round((now - t0r) / 1000)}с: оценка ${(bwe / 1e6).toFixed(1)} Мбит/с, шлём ${mbps.toFixed(1)} Мбит/с, ${h}p ${Math.round(fps)} FPS`);
                if (now - t0r > 30_000) clearInterval(ramp);
            }, 2000);
        }
        setTimeout(async () => { for (const l of await mediaReport(peer.pc, "out")) report("OUT", l); const rx = peer.viewerRx; report("OUT", `обратная связь зрителя: ${rx ? `получает ${rx.recvFps.toFixed(0)}, декодирует ${rx.decFps.toFixed(0)}, выбрасывает ${rx.dropFps.toFixed(0)} FPS, ${rx.impl}` : "НЕТ"}`); }, 6000);
        // ?switch — проверка смены кодека на лету (как при сбое декодирования у зрителя)
        if (q.has("switch")) setTimeout(() => report("OUT", `switchCodec: ${peer.switchCodec("тест стенда")}`), 6000);
    }, 500);
} else {
    // ?viewerav1 — Chrome зрителя сам ставит AV1 первым в ответе (как Chrome 148 в Discord):
    // стример должен всё равно слать свой первый кодек (H.264), а не программный AV1
    if (q.has("viewerav1")) {
        const orig = RTCPeerConnection.prototype.createAnswer;
        RTCPeerConnection.prototype.createAnswer = function (...a) {
            const caps = RTCRtpReceiver.getCapabilities("video").codecs;
            const av1 = caps.filter(c => /av1/i.test(c.mimeType)), rest = caps.filter(c => !/av1/i.test(c.mimeType));
            for (const t of this.getTransceivers()) if (t.receiver.track?.kind === "video") { try { t.setCodecPreferences([...av1, ...rest]); } catch { } }
            return orig.apply(this, a);
        };
    }
    // ?stall — зритель сообщает стримеру «собираю мало кадров, замираю» (как на VPN
    // с потерями): стример должен снизить битрейт
    if (q.has("stall")) {
        const origSend = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (data) {
            if (this.label === "p2p-fb") {
                try { const m = JSON.parse(data); if (m.t === "rx") data = JSON.stringify({ ...m, recv: 10, dec: 10, fz: 1 }); } catch { }
            }
            return origSend.call(this, data);
        };
    }
    void probeNat().then(r => status(`NAT: ${r}`));
    let t0 = Date.now(); // сбрасывается в момент watch(): меряем подключение, а не ожидание анонса
    const video = Object.assign(document.createElement("video"), { muted: true, autoplay: true });
    let droppedCodec = "";
    let busy = false;
    const tick = setInterval(async () => {
        if (busy) return;
        busy = true;
        try { await viewerTick(); } finally { busy = false; }
    }, 500);
    async function viewerTick() {
        const host = [...manager.liveHosts.values()][0];
        // ?stalevia — зритель «помнит» стримера по брокеру, хотя они уже на разных брокерах:
        // первый join уходит в никуда, должен выручить повтор через Discord
        if (host && q.has("stalevia")) host.via = "broker";
        if (host && !manager.watches.size) { t0 = Date.now(); manager.watch(host.streamId); }
        const w = [...manager.watches.values()][0];
        if (w) {
            if (video.srcObject !== w.stream && w.stream.getTracks().length) {
                video.srcObject = w.stream;
                void video.play().catch(() => { });
            }
            if (w.state === "live" && video.videoWidth > 0 && video.currentTime > 1) {
                // ?dropcodec — сторож чёрного экрана: объявляем текущий кодек «не
                // декодируется», ждём переподключения и видео уже другим кодеком
                if (q.has("dropcodec") && !droppedCodec && w.pc) {
                    const st = await w.pc.getStats();
                    let id = ""; st.forEach(r => { if (r.type === "inbound-rtp" && r.kind === "video") id = r.codecId; });
                    droppedCodec = String(st.get(id)?.mimeType ?? "").toLowerCase().replace("video/", "");
                    report("IN ", `сторож: объявляю ${droppedCodec} недекодируемым`);
                    w.dropCodec(droppedCodec);
                    video.srcObject = null;
                    return;
                }
                if (q.has("viewerav1")) {
                    const st = await w.pc.getStats();
                    let id = ""; st.forEach(r => { if (r.type === "inbound-rtp" && r.kind === "video") id = r.codecId; });
                    const mime = String(st.get(id)?.mimeType ?? "").toLowerCase();
                    if (mime.includes("av1")) { clearInterval(tick); status("FAIL: стример шлёт AV1 — порядок кодеков взят из ответа зрителя"); return; }
                    report("IN ", `кодек при AV1-первом зрителе: ${mime}`);
                }
                if (q.get("ad")) {
                    // анонс с ad приходит раз в 8 с — ждём, пока сдвиг применится
                    const vr = w.pc.getReceivers().find(r => r.track?.kind === "video");
                    const jb = vr?.jitterBufferTarget;
                    if (jb !== Number(q.get("ad"))) { if (Date.now() - t0 < 40_000) return; clearInterval(tick); status(`FAIL: видео не задержано под звук (jitterBufferTarget=${jb})`); return; }
                    report("IN ", `видео задержано под звук: jitterBufferTarget=${jb} мс`);
                }
                if (droppedCodec) {
                    const st = await w.pc.getStats();
                    let id = ""; st.forEach(r => { if (r.type === "inbound-rtp" && r.kind === "video") id = r.codecId; });
                    const now = String(st.get(id)?.mimeType ?? "").toLowerCase().replace("video/", "");
                    if (now === droppedCodec) { clearInterval(tick); status(`FAIL: после сторожа всё ещё ${now}`); return; }
                    report("IN ", `сторож: после переподключения кодек ${now}`);
                }
                clearInterval(tick);
                const secs = ((Date.now() - t0) / 1000).toFixed(1);
                void (async () => {
                    // отчёт /p2p-doctor зрителя (VERBOSE=1 — виден в выводе)
                    // через 15 с — когда оценка канала (BWE) уже разогналась
                    await new Promise(r => setTimeout(r, q.has("stall") ? 20000 : q.has("directfallback") ? 34000 : q.has("ramp") ? 32000 : q.has("heavy") ? 15000 : 0));
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
    }
}
