/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Плавающие пилюли эфиров. С v1.21 НИКАКОЙ постоянной панели «эфир идёт»:
 * свой эфир виден штатно — плиткой в звонке (nativeTiles) и красной кнопкой
 * «Остановить трансляцию» в панели голоса (Discord рисует её сам, видя наш
 * фейк как свой активный стрим). Эти пилюли остались ТОЛЬКО запасным UI на
 * случай выключенных нативных плиток: чужие эфиры с кнопкой «Смотреть».
 */

import { createRoot, React, SelectedChannelStore } from "@webpack/common";

import { cl } from "../css";
import { type LiveHost, manager, type WatchSession } from "../engine";
import { settings } from "../settings";

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

    // С нативными плитками UI звонка сам показывает эфиры — плавающие пилюли не нужны.
    if (settings.store.nativeTiles) return null;

    const voiceId = safeVoiceId();
    const hosts = [...manager.liveHosts.values()]
        .filter(h => h.channelId === voiceId)
        .sort((a, b) => a.name.localeCompare(b.name));

    return (
        <div className={cl("bars-root")}>
            {hosts.map(host => (
                <LivePill key={host.streamId} host={host} isMine={host.streamId === manager.host?.streamId} />
            ))}
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

function metaText(meta: { res?: string; fps?: number; bitrate?: number; codec?: string }): string {
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
