/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * (1.23.25) Постоянный FPS на статичном экране. Захват экрана отдаёт кадры только
 * при изменениях: на стоящей картинке ~2 кадр/с, у зрителя «2 FPS». Здесь кадры
 * захвата идут в Worker (MediaStreamTrackProcessor.readable → Worker →
 * MediaStreamTrackGenerator.writable; после передачи потоков Chromium гонит кадры
 * внутри Worker, мимо главного потока окна). Пока захват присылает кадры — они
 * проходят как есть; замолчал дольше 100 мс (стоящая картинка) — Worker повторяет последний
 * кадр с нужной частотой, пока не придёт новый. Код Worker — строкой (без `).
 */
export const FRAME_REPEAT_WORKER_SRC = `
let writer = null, last = null, lastRealAt = 0, lastTs = 0, period = 1000 / 60, repeated = 0, passed = 0, stopped = false, repeating = false;
function writeFrame(frame) {
    let f = frame;
    /* метки времени строго растут: повторы идут по часам, настоящий кадр мог прийти «из прошлого» */
    if (f.timestamp <= lastTs) { const g = new VideoFrame(f, { timestamp: lastTs + 1000 }); f.close(); f = g; }
    lastTs = f.timestamp;
    return writer.write(f).catch(function () { try { f.close(); } catch (e) { } });
}
function tick() {
    if (stopped) return;
    const now = performance.now();
    /* захват молчит > 100 мс (стоящая картинка) — повторяем последний кадр с полной
       частотой. Не раньше: видео 30 кадр/с на экране идёт как есть, без дублей
       (лишняя работа энкодеру и программному декодеру зрителя) */
    if (last && now - lastRealAt >= Math.max(period * 2, 100)) {
        if (!repeating) { repeating = true; postMessage({ rep: 1, passed: passed }); }
        const ts = lastTs + Math.round(period * 1000);
        writeFrame(new VideoFrame(last, { timestamp: ts }));
        repeated++;
    }
    setTimeout(tick, period);
}
onmessage = async function (e) {
    const d = e.data || {};
    if (d.stop) { stopped = true; return; }
    if (!d.readable) return;
    period = 1000 / Math.max(1, Math.min(240, d.fps || 60));
    writer = d.writable.getWriter();
    const reader = d.readable.getReader();
    setTimeout(tick, period);
    setInterval(function () { postMessage({ repeated: repeated, passed: passed, rep: repeating ? 1 : 0 }); }, 1000);
    for (;;) {
        let r;
        try { r = await reader.read(); } catch (er) { break; }
        if (r.done || stopped) break;
        if (last) last.close();
        last = r.value.clone();
        lastRealAt = performance.now();
        passed++;
        if (repeating) { repeating = false; postMessage({ rep: 0, passed: passed }); }
        writeFrame(r.value);
    }
    stopped = true;
    try { if (last) last.close(); } catch (er) { }
    try { await writer.close(); } catch (er) { }
    postMessage({ ended: 1 });
};
`;

export interface FrameRepeater {
    /** дорожка для энкодера (повторяет кадры на статике) */
    track: MediaStreamTrack;
    /** сейчас повторяем (захват молчит — картинка стоит) */
    readonly repeating: boolean;
    /** настоящих кадров от захвата с начала (без повторов) */
    readonly passed: number;
    stop(): void;
}

/**
 * Обернуть дорожку захвата: на выходе — дорожка с постоянным FPS. null — браузер не
 * умеет (нет MediaStreamTrackProcessor/Generator) — тогда используется исходная.
 */
export function createFrameRepeater(source: MediaStreamTrack, fps: number, onLog?: (msg: string) => void): FrameRepeater | null {
    const W = globalThis as any;
    if (typeof W.MediaStreamTrackProcessor !== "function" || typeof W.MediaStreamTrackGenerator !== "function") return null;
    let url = "";
    try {
        const proc = new W.MediaStreamTrackProcessor({ track: source });
        const gen: MediaStreamTrack & { writable: WritableStream } = new W.MediaStreamTrackGenerator({ kind: "video" });
        url = URL.createObjectURL(new Blob([FRAME_REPEAT_WORKER_SRC], { type: "text/javascript" }));
        const worker = new Worker(url);
        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            try { worker.postMessage({ stop: 1 }); } catch { /* ignore */ }
            setTimeout(() => { try { worker.terminate(); } catch { /* ignore */ } }, 500);
            try { gen.stop(); } catch { /* ignore */ }
            if (url) URL.revokeObjectURL(url);
        };
        worker.onerror = e => {
            onLog?.(`повтор кадров: Worker упал (${(e as ErrorEvent).message ?? e})`);
        };
        const state = { repeating: false, passed: 0 };
        worker.onmessage = e => {
            const d = e.data ?? {};
            if (d.ended) stop();
            if (typeof d.rep === "number") state.repeating = d.rep === 1;
            if (typeof d.passed === "number") state.passed = d.passed;
        };
        worker.postMessage({ readable: proc.readable, writable: gen.writable, fps }, [proc.readable, gen.writable]);
        // захват закончился (остановили в системе) — заканчиваем и выходную дорожку
        source.addEventListener("ended", stop);
        try { gen.contentHint = source.contentHint; } catch { /* ignore */ }
        return {
            track: gen,
            get repeating() { return state.repeating; },
            get passed() { return state.passed; },
            stop
        };
    } catch (e) {
        if (url) URL.revokeObjectURL(url);
        onLog?.(`повтор кадров недоступен: ${e}`);
        return null;
    }
}
