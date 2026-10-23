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

import { createRoot, React, RestAPI, SelectedChannelStore } from "@webpack/common";
import { Logger } from "@utils/Logger";

import { cl } from "../css";
import { type LiveHost, manager, type WatchSession } from "../engine";
import { settings } from "../settings";
import { PLUGIN_VERSION, toast } from "../utils";

const logger = new Logger("P2PStream:Bars");

/** Кнопка «🔗 Пригласить» — embed с брокером+секретом в текущий текстовый канал.
 *  Тикет для зрителя: тот жмёт на ссылку (p2ps://connect…) и подключается
 *  без настройки брокера вручную (хот-свап, v1.23). */
export async function sendInvite(): Promise<void> {
    const brokerUrl = String(settings.store.brokerUrl ?? "").trim();
    const secret = String(settings.store.brokerSecret ?? "").trim();
    if (!brokerUrl) {
        toast("Не задан брокер (brokerUrl) — пришлите адрес вручную", "critical");
        return;
    }
    const voiceId = safeVoiceId();
    if (!voiceId) {
        toast("Зайдите в голосовой канал, чтобы отправить приглашение", "critical");
        return;
    }
    const channelId = (() => { try { return SelectedChannelStore.getChannelId?.() ?? null; } catch { return null; } })();
    if (!channelId) {
        toast("Откройте текстовый канал, куда отправить приглашение", "critical");
        return;
    }
    const link = `p2ps://connect?broker=${encodeURIComponent(brokerUrl)}&secret=${encodeURIComponent(secret)}`;
    try {
        await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                content: "🎬 **P2P-эфир** — нажмите, чтобы подключиться (без перезагрузки)",
                embeds: [{
                    title: "P2P-стрим: открыть",
                    description: `\n${link}`,
                    color: 0x5865F2,
                    fields: [
                        { name: "📡 Брокер", value: brokerUrl },
                        { name: "🔑 Секрет", value: secret ? "✅ в ссылке" : "❌ не задан" },
                        { name: "🎙 Канал", value: "<#" + voiceId + ">" }
                    ],
                    footer: { text: "P2PStream v" + PLUGIN_VERSION }
                }]
            }
        });
        toast("Приглашение отправлено в канал", "success");
    } catch (e) {
        logger.error("sendInvite:", e);
        toast("Не удалось отправить приглашение (нет прав?)", "critical");
    }
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

    // Раньше с нативными плитками пилюли прятались целиком. Но плитки держатся на
    // подмене внутренних сторов Discord и ломаются с его обновлениями (1.23: эфир
    // виден движку, а плитки нет) — чужие эфиры показываем всегда, свой — только
    // без плиток (у стримера есть штатная красная кнопка).
    const native = !!settings.store.nativeTiles;
    const voiceId = safeVoiceId();
    const hosts = [...manager.liveHosts.values()]
        .filter(h => h.channelId === voiceId)
        .filter(h => !native || h.streamId !== manager.host?.streamId)
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!hosts.length) return null;

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
            ) : isMine ? (
                <button className={cl("pill-btn")} onClick={() => sendInvite()}>
                    🔗 Пригласить
                </button>
            ) : (
                <button className={cl("pill-btn")} onClick={() => manager.watch(host.streamId)}>
                    {watch?.state === "failed" ? "Повторить" : "Смотреть"}
                </button>
            )}
        </div>
    );
}
