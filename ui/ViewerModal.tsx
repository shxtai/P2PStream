/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Modal, openModal,React } from "@webpack/common";

import { cl } from "../css";
import { createStatsTracker, manager, type StreamStats, type WatchSession } from "../engine";
import { settings } from "../settings";
import { toast } from "../utils";
import { openMiniPlayer } from "./MiniPlayer";

const readStats = createStatsTracker("in");

export function openViewerModal(session: WatchSession): void {
    if (openSessions.has(session.host.streamId)) return;
    openSessions.add(session.host.streamId);
    openModal(
        props => <ViewerModal modalProps={props} session={session} />,
        {
            onCloseCallback: () => {
                openSessions.delete(session.host.streamId);
                // закрытие модалки НЕ останавливает просмотр — эфир продолжает
                // играть в компактном мини-плеере («панелька где-то сбоку»)
                if (manager.watches.get(session.host.streamId) === session
                    && session.state !== "ended" && session.state !== "failed") {
                    openMiniPlayer(session);
                }
            }
        }
    );
}

const openSessions = new Set<string>();

function useForceRender() {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => manager.subscribe(force), []);
}

function useStats(pc: RTCPeerConnection | undefined, active: boolean): StreamStats | null {
    const [stats, setStats] = React.useState<StreamStats | null>(null);
    React.useEffect(() => {
        if (!pc || !active) return;
        let alive = true;
        const tick = () => {
            void readStats(pc).then(s => { if (alive) setStats(s); });
        };
        tick();
        const timer = setInterval(tick, 1000);
        return () => { alive = false; clearInterval(timer); };
    }, [pc, active]);
    return stats;
}

function Chip({ children }: { children: React.ReactNode }) {
    return <span className={cl("chip")}>{children}</span>;
}

function ViewerModal({
    modalProps,
    session
}: {
    modalProps: { transitionState: number; onClose(): void; [k: string]: any };
    session: WatchSession;
}) {
    useForceRender();
    const [zoom, setZoom] = React.useState({ s: 1, x: 0, y: 0 });
    const [volume, setVolume] = React.useState(1);
    const [muted, setMuted] = React.useState(false);
    const [showStats, setShowStats] = React.useState<boolean>(!!settings.store.showStats);
    const [zoomBadge, setZoomBadge] = React.useState(0);
    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const wrapRef = React.useRef<HTMLDivElement | null>(null);
    const dragRef = React.useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);

    const { state } = session;
    const { pc } = session;
    const stats = useStats(pc, state === "live" && showStats);

    const close = () => {
        modalProps.onClose();
    };

    // Подключение потока к <video>
    React.useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = session.stream;
        v.volume = volume;
        v.muted = muted;
        const p = v.play();
        if (p) p.catch(() => { /* автоплей может быть отклонён до жеста */ });
    }, []);

    React.useEffect(() => {
        const v = videoRef.current;
        if (v) {
            v.volume = volume;
            v.muted = muted;
        }
    }, [volume, muted]);

    // Автозакрытие при завершении эфира
    React.useEffect(() => {
        if (state !== "ended" && state !== "failed") return;
        const t = setTimeout(close, 2500);
        return () => clearTimeout(t);
    }, [state]);

    // Зум колесом (не-пассивный слушатель)
    React.useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey && zoomRef.current.s <= 1) return;
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const factor = Math.exp(-e.deltaY * 0.002);
            applyZoom(factor, cx, cy, rect.width, rect.height);
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);

    const zoomRef = React.useRef(zoom);
    zoomRef.current = zoom;

    function clampOffset(s: number, x: number, y: number, w: number, h: number): { x: number; y: number } {
        const minX = Math.min(0, w - s * w);
        const minY = Math.min(0, h - s * h);
        return {
            x: Math.max(minX, Math.min(0, x)),
            y: Math.max(minY, Math.min(0, y))
        };
    }

    function applyZoom(factor: number, cx: number, cy: number, w: number, h: number): void {
        setZoom(z => {
            const s = Math.max(1, Math.min(8, z.s * factor));
            if (s === 1) return { s: 1, x: 0, y: 0 };
            // точка под курсором должна остаться на месте
            const px = (cx - z.x) / z.s;
            const py = (cy - z.y) / z.s;
            const raw = { x: cx - px * s, y: cy - py * s };
            const cl = clampOffset(s, raw.x, raw.y, w, h);
            return { s, x: cl.x, y: cl.y };
        });
    }

    // показ значка зума
    React.useEffect(() => {
        if (zoom.s <= 1) {
            setZoomBadge(0);
            return;
        }
        setZoomBadge(zoom.s);
        const t = setTimeout(() => setZoomBadge(0), 1200);
        return () => clearTimeout(t);
    }, [zoom]);

    const onPointerDown = (e: React.PointerEvent) => {
        if (zoom.s <= 1) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: zoom.x, oy: zoom.y };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const drag = dragRef.current;
        const el = wrapRef.current;
        if (!drag || !el || drag.id !== e.pointerId) return;
        const rect = el.getBoundingClientRect();
        const cl = clampOffset(zoom.s, drag.ox + (e.clientX - drag.x), drag.oy + (e.clientY - drag.y), rect.width, rect.height);
        setZoom(z => ({ ...z, x: cl.x, y: cl.y }));
    };
    const onPointerUp = () => { dragRef.current = null; };

    const minimize = () => {
        // сессия продолжается — мини-плеер откроется в onCloseCallback
        modalProps.onClose();
    };

    const disconnect = () => {
        try {
            session.stop(true);
            manager.watches.delete(session.host.streamId);
            manager.bump();
        } catch { /* ignore */ }
        modalProps.onClose();
    };

    const toggleFullscreen = () => {
        const el = wrapRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el.requestFullscreen?.();
    };

    const togglePip = () => {
        const v = videoRef.current;
        if (!v) return;
        if (document.pictureInPictureElement) {
            void document.exitPictureInPicture?.();
        } else {
            v.requestPictureInPicture?.().catch(() => toastSafe("Картинка-в-картинке недоступна"));
        }
    };

    // Горячие клавиши: F — фуллскрин, M — звук, R — сброс зума
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "f" || e.key === "F" || e.key === "а" || e.key === "А") toggleFullscreen();
            else if (e.key === "m" || e.key === "M" || e.key === "ь" || e.key === "Ь") setMuted(m => !m);
            else if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") setZoom({ s: 1, x: 0, y: 0 });
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const { host } = session;
    const { meta } = host;

    const title = (
        <div className={cl("viewer-title")}>
            <span className={cl("live-dot", { off: state !== "live" && state !== "reconnecting" })} />
            <span className={cl("viewer-name")}>{host.name}</span>
            {state === "live" && <span className={cl("live-label")}>LIVE</span>}
            <span className={cl("viewer-meta")}>
                {[meta.res, meta.fps ? `${meta.fps} FPS` : "", meta.codec, meta.bitrate ? `${meta.bitrate} Мбит/с` : ""]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
        </div>
    );

    return (
        <Modal
            {...modalProps}
            size="xl"
            title={title}
        >
            <div className={cl("viewer-body")}>
                <div
                    ref={wrapRef}
                    className={cl("video-wrap", { zoomed: zoom.s > 1, fs: true })}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onDoubleClick={() => setZoom({ s: 1, x: 0, y: 0 })}
                >
                    <video
                        ref={videoRef}
                        className={cl("video")}
                        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` }}
                        autoPlay
                        playsInline
                    />

                    {state === "connecting" && (
                        <div className={cl("overlay")}>
                            <div className={cl("spinner")} />
                            <div>Подключение к P2P-эфиру…</div>
                            <div className={cl("overlay-sub")}>Прямое соединение с {host.name}</div>
                        </div>
                    )}
                    {state === "reconnecting" && (
                        <div className={cl("overlay")}>
                            <div className={cl("spinner")} />
                            <div>Восстановление соединения…</div>
                        </div>
                    )}
                    {(state === "ended" || state === "failed") && (
                        <div className={cl("overlay")}>
                            <div>{state === "failed" ? "Соединение потеряно" : "Эфир завершён"}</div>
                            <div className={cl("overlay-sub")}>Окно закроется автоматически</div>
                        </div>
                    )}

                    {zoomBadge > 0 && (
                        <div className={cl("zoom-badge")}>{Math.round(zoom.s * 100)}%</div>
                    )}

                    {showStats && stats && state === "live" && (
                        <div className={cl("stats")}>
                            <div>{stats.codec || "?"} · {stats.w}×{stats.h} · {stats.fps} FPS</div>
                            <div>{stats.mbps.toFixed(2)} Мбит/с · RTT {stats.rttMs} мс</div>
                            <div>Потери {stats.lossPct}% · Джиттер {stats.jitterMs} мс</div>
                        </div>
                    )}
                </div>

                <div className={cl("controls")}>
                    <button className={cl("ctrl-btn")} onClick={() => setMuted(m => !m)} title="Звук (M)">
                        {muted ? "Выкл. звук" : "Звук вкл."}
                    </button>
                    <input
                        className={cl("volume")}
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={muted ? 0 : volume}
                        onChange={e => { setVolume(Number(e.target.value)); setMuted(false); }}
                        title="Громкость"
                    />
                    <div className={cl("spacer")} />
                    <Chip>{zoom.s > 1 ? `Зум ${Math.round(zoom.s * 100)}%` : "Ctrl+колесо — зум"}</Chip>
                    <button className={cl("ctrl-btn")} onClick={() => setZoom({ s: 1, x: 0, y: 0 })} title="Сбросить зум (R)">Сброс</button>
                    <button className={cl("ctrl-btn")} onClick={() => setShowStats(v => !v)} title="Статистика">{showStats ? "Скрыть статы" : "Статы"}</button>
                    <button className={cl("ctrl-btn")} onClick={togglePip} title="Мини-окно поверх всего (поверх игры)">PiP</button>
                    <button className={cl("ctrl-btn")} onClick={toggleFullscreen} title="Во весь экран (F)">Фуллскрин</button>
                    <button className={cl("ctrl-btn")} onClick={minimize} title="Свернуть в компактную панель — просмотр продолжится">Мини</button>
                    <button className={`${cl("ctrl-btn")} ${cl("danger")}`} onClick={disconnect} title="Остановить просмотр">Отключиться</button>
                </div>
            </div>
        </Modal>
    );
}

function toastSafe(msg: string): void {
    toast(msg, "critical");
}
