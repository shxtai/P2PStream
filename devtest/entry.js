// Участник стенда: НАСТОЯЩИЙ движок плагина (engine/signaling/broker) + заглушка Discord.
import { manager, probeNat } from "@p2p/engine";
import { settings } from "@p2p/settings";

import { fluxHandlers, ME } from "./stubs/common.js";

const role = new URLSearchParams(location.search).get("role");
settings.store.audioMode = "off"; // нативного хелпера в браузере нет

fluxHandlers.push(manager.onMessageCreate);
manager.start();

function status(text) { parent.postMessage({ kind: "status", from: ME, text }, "*"); }

if (role === "host") {
    // «экран» хоста — анимированный canvas
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext("2d");
    let f = 0;
    setInterval(() => {
        ctx.fillStyle = `hsl(${(f++ * 7) % 360},70%,50%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#fff"; ctx.font = "48px sans-serif"; ctx.fillText(String(f), 40, 100);
    }, 33);
    void manager.startShareWithCapture(canvas.captureStream(30), null).then(() => status("host started"));
} else {
    void probeNat().then(r => status(`NAT: ${r}`));
    const t0 = Date.now();
    const video = Object.assign(document.createElement("video"), { muted: true, autoplay: true });
    const tick = setInterval(() => {
        const host = [...manager.liveHosts.values()][0];
        if (host && !manager.watches.size) manager.watch(host.streamId);
        const w = [...manager.watches.values()][0];
        if (w) {
            if (video.srcObject !== w.stream && w.stream.getTracks().length) {
                video.srcObject = w.stream;
                void video.play().catch(() => { });
            }
            if (w.state === "live" && video.videoWidth > 0 && video.currentTime > 1) {
                clearInterval(tick);
                status(`OK: видео ${video.videoWidth}x${video.videoHeight} через ${((Date.now() - t0) / 1000).toFixed(1)} с`);
                return;
            }
        }
        if (Date.now() - t0 > 100_000) {
            clearInterval(tick);
            status(`FAIL: state=${w?.state} pc=${w?.pc?.connectionState}`);
        }
    }, 500);
}
