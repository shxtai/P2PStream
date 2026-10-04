/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { cl } from "../css";
import { buildDisplayConstraints, manager } from "../engine";
import { toast } from "../utils";

export function AboutCard() {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => manager.subscribe(force), []);

    const testCapture = async () => {
        const gdm = navigator.mediaDevices?.getDisplayMedia;
        if (!gdm) {
            toast("getDisplayMedia недоступен в этом клиенте", "critical");
            return;
        }
        try {
            const stream = await gdm.call(navigator.mediaDevices, buildDisplayConstraints());
            const v = stream.getVideoTracks()[0];
            const s = v?.getSettings() ?? {};
            toast(
                `Захват OK: ${s.width ?? "?"}×${s.height ?? "?"} @ ${Math.round(s.frameRate ?? 0)} FPS, аудио: ${stream.getAudioTracks().length}`,
                "success"
            );
            stream.getTracks().forEach(t => t.stop());
        } catch (e: any) {
            if (e?.name === "NotAllowedError") return;
            toast(`Тест захвата не удался: ${e?.name ?? e}`, "critical");
        }
    };

    return (
        <div className={cl("about")}>
            <div className={cl("about-row")}>
                <button className={cl("pill-btn")} onClick={() => void manager.startShare()}>
                    Начать P2P-стрим
                </button>
                <button
                    className={`${cl("pill-btn")} ${cl("danger")}`}
                    onClick={() => manager.stopShare()}
                    disabled={!manager.host}
                >
                    Остановить
                </button>
                <button className={cl("pill-btn")} onClick={() => void testCapture()}>
                    Тест захвата
                </button>
            </div>

            <div className={cl("about-status")}>
                {manager.host
                    ? `Эфир активен · зрителей: ${manager.host.peers.size}`
                    : manager.watches.size > 0
                        ? `Вы смотрите ${manager.watches.size} эфир(ов)`
                        : "Не в эфире"}
            </div>

            <div className={cl("about-hint")}>
                <b>Быстрый старт:</b> оба участника ставят этот плагин → заходят в один голосовой канал →
                стример нажимает кнопку демонстрации экрана (или /p2p-start) → у зрителей внизу появится
                красная пилюля «Смотреть». Служебные сообщения соединения самоуничтожаются за ~2.5 сек —
                чат остаётся чистым. Медиа идёт напрямую P2P (E2E DTLS-SRTP), серверы Discord не участвуют.
                <br />
                <b>Режим кнопки Discord</b> выбирается настройкой выше: P2P / Go Live + буст / обычный.
                <br />
                <b>Если не подключается:</b> у одного из вас симметричный NAT — укажите TURN-сервер в настройках ниже.
            </div>
        </div>
    );
}
