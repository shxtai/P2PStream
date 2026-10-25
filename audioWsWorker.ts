/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * (1.23.23) Worker рендерера: принимает PCM из main-процесса по локальному
 * WebSocket (см. audioWs.ts) и сразу пересылает в AudioWorklet через
 * MessagePort — мимо главного потока окна Discord. Сообщения наружу:
 * { open } / { closed } / { beat: n } (раз в ~0.5 с — для вотчдога тишины).
 * Код строкой (Worker из blob:), поэтому внутри без обратных кавычек.
 */
export const AUDIO_WS_WORKER_SRC = `
let ws = null, port = null, url = "", stopped = false, n = 0, lastBeat = 0;
function connect() {
    if (stopped) return;
    try { ws = new WebSocket(url); } catch (e) { postMessage({ err: String(e) }); setTimeout(connect, 2000); return; }
    ws.binaryType = "arraybuffer";
    ws.onopen = function () { postMessage({ open: 1 }); };
    ws.onmessage = function (ev) {
        const b = ev.data;
        if (!(b instanceof ArrayBuffer) || b.byteLength < 8) return;
        const f = new Float32Array(b, 0, b.byteLength >> 2);
        port.postMessage(f, [b]);
        n++;
        const now = Date.now();
        if (now - lastBeat > 500) { lastBeat = now; postMessage({ beat: n }); }
    };
    ws.onclose = function () { ws = null; postMessage({ closed: 1 }); if (!stopped) setTimeout(connect, 1000); };
    ws.onerror = function () { };
}
onmessage = function (e) {
    const d = e.data || {};
    if (d.url) { url = d.url; port = d.port; connect(); }
    if (d.stop) { stopped = true; try { if (ws) ws.close(); } catch (er) { } }
};
`;
