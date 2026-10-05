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

/** свой счётчик на каждое соединение — дельты байтов не смешиваются между зрителями */
const outTrackers = new WeakMap<RTCPeerConnection, ReturnType<typeof createStatsTracker>>();
function readOutStats(pc: RTCPeerConnection) {
    let t = outTrackers.get(pc);
    if (!t) outTrackers.set(pc, t = createStatsTracker("out"));
    return t(pc);
}

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
            {watch && watch.state !== "ended" && watch.state !== "failed" ? (
                <>
                    <span className={cl("pill-state")} data-state={watch.state}>
                        {watch.state === "live" ? "Смотрю" : "Подключение…"}
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
                    {watch?.state === "failed" ? "Повторить" : "Смотреть"}
                </button>
            )}
        </div>
    );
}

function HostBar({ session }: { session: HostSession }) {
    useManager();
    const [mbps, setMbps] = React.useState(0);
    const live = session.peers.size > 0;

    // суммарная отдача по ВСЕМ зрителям (раньше — только первый, и общий счётчик)
    React.useEffect(() => {
        if (!live) { setMbps(0); return; }
        let alive = true;
        const tick = () => {
            const pcs = [...session.peers.values()].map(p => p.pc);
            void Promise.all(pcs.map(readOutStats)).then(list => {
                if (alive) setMbps(list.reduce((a, s) => a + (s?.mbps ?? 0), 0));
            });
        };
        tick();
        const timer = setInterval(tick, 2000); // getStats по всем зрителям — не чаще раза в 2 с
        return () => { alive = false; clearInterval(timer); };
    }, [live, session]);

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
