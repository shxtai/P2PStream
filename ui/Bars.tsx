/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createRoot,React, SelectedChannelStore } from "@webpack/common";

import { cl } from "../css";
import { createStatsTracker, type HostSession, type LiveHost, manager, type StreamMeta, type WatchSession } from "../engine";
import { applyProfile, settings } from "../settings";
import { toast } from "../utils";

const readOutStats = createStatsTracker("out");

export function mountBars(): () => void {
    const el = document.createElement("div");
    el.id = "vc-p2p-bars";
    document.body.appendChild(el);
    const root = createRoot(el);
    root.render(<BarsRoot />);
    return () => {
        root.unmount();
        el.remove();
    };
}

function useManager(): void {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => manager.subscribe(force), []);
}

function BarsRoot() {
    useManager();

    const voiceId = safeVoiceId();
    const meId = manager.host?.streamId ?? "";
    const hosts = [...manager.liveHosts.values()]
        .filter(h => h.channelId === voiceId)
        .sort((a, b) => a.name.localeCompare(b.name));

    return (
        <div className={cl("bars-root")}>
            {hosts.map(host => (
                <LivePill key={host.streamId} host={host} isMine={host.streamId === meId} />
            ))}
            {manager.host && <HostBar session={manager.host} />}
        </div>
    );
}

function safeVoiceId(): string | null {
    try {
        return SelectedChannelStore.getVoiceChannelId?.() ?? null;
    } catch {
        return null;
    }
}

function metaText(meta: StreamMeta): string {
    return [meta.res, meta.fps ? `${meta.fps} FPS` : "", meta.codec, meta.bitrate ? `${meta.bitrate} Мбит/с` : ""]
        .filter(Boolean)
        .join(" · ");
}

function LivePill({ host, isMine }: { host: LiveHost; isMine?: boolean }) {
    useManager();
    const watch: WatchSession | undefined = manager.watches.get(host.streamId);

    return (
        <div className={cl("pill")} data-state={watch?.state ?? "idle"}>
            <span className={cl("live-dot", { off: false })} />
            <div className={cl("pill-info")}>
                <div className={cl("pill-name")}>{host.name}</div>
                <div className={cl("pill-meta")}>{metaText(host.meta) || "P2P-эфир"}{isMine ? " · вы" : ""}</div>
            </div>
            {watch ? (
                <>
                    <span className={cl("pill-state")} data-state={watch.state}>
                        {watch.state === "live" ? "Смотрю"
                            : watch.state === "connecting" || watch.state === "reconnecting" ? "Подключение…"
                                : watch.state === "failed" ? "Ошибка" : "Завершён"}
                    </span>
                    <button
                        className={cl("pill-btn")}
                        onClick={() => manager.onWatchCreated?.(watch)}
                    >
                        Открыть
                    </button>
                    <button
                        className={`${cl("pill-btn")} ${cl("danger")}`}
                        onClick={() => manager.unwatch(host.streamId)}
                    >
                        Отключиться
                    </button>
                </>
            ) : (
                <button className={cl("pill-btn")} onClick={() => manager.watch(host.streamId)}>
                    Смотреть
                </button>
            )}
        </div>
    );
}

function HostBar({ session }: { session: HostSession }) {
    useManager();
    const [mbps, setMbps] = React.useState(0);
    const peer = session.peers.values().next().value as { pc: RTCPeerConnection } | undefined;
    const live = peer != null && session.peers.size > 0;

    React.useEffect(() => {
        if (!live) return;
        let alive = true;
        const tick = () => void readOutStats(peer!.pc).then(s => { if (alive && s) setMbps(s.mbps); });
        tick();
        const timer = setInterval(tick, 1000);
        return () => { alive = false; clearInterval(timer); };
    }, [live, peer]);

    const profile = String(settings.store.profile);

    const quickProfile = (p: "games" | "movies") => {
        applyProfile(p);
        settings.store.profile = p;
        session.applyLiveChanges();
        toast(p === "games" ? "Профиль «Игры» применён к эфиру" : "Профиль «Кино» применён к эфиру", "success");
    };

    return (
        <div className={cl("hostbar")}>
            <span className={cl("live-dot")} />
            <span className={cl("hostbar-label")}>P2P ЭФИР</span>
            <span className={cl("hostbar-meta")}>{metaText(session.meta)}</span>
            <span className={cl("hostbar-meta")}>{live ? `↑ ${mbps.toFixed(2)} Мбит/с` : "ожидание зрителей…"}</span>
            <span className={cl("hostbar-meta")}>Зрителей: {session.peers.size}</span>
            <div className={cl("spacer")} />
            <button
                className={cl("pill-btn", { active: profile === "games" })}
                onClick={() => quickProfile("games")}
                title="Пресет: минимальная задержка"
            >
                Игры
            </button>
            <button
                className={cl("pill-btn", { active: profile === "movies" })}
                onClick={() => quickProfile("movies")}
                title="Пресет: плавность"
            >
                Кино
            </button>
            <button
                className={`${cl("pill-btn")} ${cl("danger")}`}
                onClick={() => manager.stopShare()}
            >
                Стоп
            </button>
        </div>
    );
}
