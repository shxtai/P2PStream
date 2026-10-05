/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Мини-плеер: компактная перетаскиваемая панель просмотра поверх Discord.
 * Сворачивается в узкую полоску (только заголовок), разворачивается в полное
 * окно просмотра, поддерживает PiP. Закрытие модалки НЕ останавливает просмотр —
 * сессия живёт в мини-плеере, пока его не закроют крестиком.
 */

import { createRoot, React } from "@webpack/common";

import { cl } from "../css";
import { manager, type WatchSession } from "../engine";
import { toast } from "../utils";

type MiniEntry = {
    root: { unmount(): void };
    el: HTMLDivElement;
};

const miniRoots = new Map<string, MiniEntry>();
/** позиция сохраняется между открытиями внутри сессии Discord */
let savedPos: { x: number; y: number } | null = null;

function defaultCorner(): { x: number; y: number } {
    return {
        x: Math.max(12, window.innerWidth - 404),
        y: Math.max(12, window.innerHeight - 342)
    };
}

export function openMiniPlayer(session: WatchSession): void {
    const key = session.host.streamId;
    if (miniRoots.has(key)) return;
    const el = document.createElement("div");
    el.className = cl("mini-host");
    document.body.appendChild(el);
    const root = createRoot(el);
    miniRoots.set(key, { root, el });
    root.render(<MiniPlayer session={session} />);
}

export function closeMiniPlayer(streamId: string): void {
    const entry = miniRoots.get(streamId);
    if (!entry) return;
    miniRoots.delete(streamId);
    try { entry.root.unmount(); } catch { /* ignore */ }
    try { entry.el.remove(); } catch { /* ignore */ }
}

/** Остановить просмотр и убрать мини-плеер (крестик) */
function stopWatch(session: WatchSession): void {
    try {
        session.stop(true);
        manager.watches.delete(session.host.streamId);
        manager.bump();
    } catch { /* ignore */ }
    closeMiniPlayer(session.host.streamId);
    toast("Просмотр остановлен");
}

function MiniPlayer({ session }: { session: WatchSession }) {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => manager.subscribe(force), []);

    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const [collapsed, setCollapsed] = React.useState(false);
    const [muted, setMuted] = React.useState(false);
    const [volume, setVolume] = React.useState(1);
    const [pos, setPos] = React.useState(() => savedPos ?? defaultCorner());
    const dragRef = React.useRef<{ px: number; py: number; x: number; y: number } | null>(null);
    const wrapRef = React.useRef<HTMLDivElement | null>(null);

    const { state } = session;
    const { host } = session;

    // подключение потока
    React.useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = session.stream;
        v.volume = volume;
        v.muted = muted;
        v.play?.().catch(() => { /* автоплей до жеста может быть отклонён */ });
    });

    React.useEffect(() => {
        const v = videoRef.current;
        if (v) {
            v.volume = volume;
            v.muted = muted;
        }
    }, [volume, muted]);

    // авто-закрытие при завершении/потере эфира
    React.useEffect(() => {
        if (state === "ended" || state === "failed") {
            const t = setTimeout(() => closeMiniPlayer(session.host.streamId), 1800);
            return () => clearTimeout(t);
        }
    }, [state]);

    const clamp = (p: { x: number; y: number }) => ({
        x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - 120)),
        y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - 44))
    });

    const onHeaderDown = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest("button")) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        dragRef.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
    };
    const onHeaderMove = (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        setPos(clamp({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
    };
    const onHeaderUp = () => {
        dragRef.current = null;
        setPos(p => (savedPos = p));
    };

    const expand = () => {
        const sid = session.host.streamId;
        closeMiniPlayer(sid);
        // полный плеер импортируем лениво через manager (избегаем цикла импортов)
        void import("./ViewerModal").then(m => m.openViewerModal(session)).catch(() => { /* ignore */ });
    };

    const togglePip = () => {
        const v = videoRef.current;
        if (!v) return;
        if (document.pictureInPictureElement) void document.exitPictureInPicture?.();
        else v.requestPictureInPicture?.().catch(() => toast("Картинка-в-картинке недоступна", "critical"));
    };

    const toggleFullscreen = () => {
        const el = wrapRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el.requestFullscreen?.();
    };

    return (
        <div
            className={`${cl("mini")} ${collapsed ? cl("collapsed") : ""}`}
            style={{ left: pos.x, top: pos.y }}
            onDoubleClick={e => {
                // двойной клик по шапке — свернуть/развернуть
                if ((e.target as HTMLElement).closest("button")) return;
                setCollapsed(c => !c);
            }}
        >
            <div
                className={cl("mini-header")}
                onPointerDown={onHeaderDown}
                onPointerMove={onHeaderMove}
                onPointerUp={onHeaderUp}
                title="Потяните, чтобы переместить · двойной клик — свернуть"
            >
                <span className={cl("live-dot", { off: state !== "live" && state !== "reconnecting" })} />
                <span className={cl("mini-name")}>{host.name}{state === "live" ? " · LIVE" : ""}</span>
                <button className={cl("mini-btn")} onClick={() => setCollapsed(c => !c)} title={collapsed ? "Развернуть" : "Свернуть"}>
                    {collapsed ? "▢" : "—"}
                </button>
                <button className={cl("mini-btn")} onClick={expand} title="Полное окно">⤢</button>
                <button className={`${cl("mini-btn")} ${cl("danger")}`} onClick={() => stopWatch(session)} title="Отключиться">✕</button>
            </div>

            {!collapsed && (
                <>
                    <div ref={wrapRef} className={cl("mini-video-wrap")}>
                        <video ref={videoRef} className={cl("mini-video")} autoPlay playsInline />
                        {(state === "connecting" || state === "reconnecting") && (
                            <div className={cl("mini-overlay")}>
                                <div className={cl("spinner")} />
                                <div>{state === "connecting" ? "Подключение…" : "Восстановление…"}</div>
                            </div>
                        )}
                    </div>
                    <div className={cl("mini-controls")}>
                        <button className={cl("mini-btn")} onClick={() => setMuted(m => !m)} title="Звук">
                            {muted || volume === 0 ? "🔇" : "🔊"}
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
                        <button className={cl("mini-btn")} onClick={togglePip} title="Картинка-в-картинке">PiP</button>
                        <button className={cl("mini-btn")} onClick={toggleFullscreen} title="Во весь экран">⛶</button>
                    </div>
                </>
            )}
        </div>
    );
}
