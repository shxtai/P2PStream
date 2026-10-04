/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByProps } from "@webpack";
import { UserStore } from "@webpack/common";

import { manager } from "./engine";
import { settings } from "./settings";
import { openSharePicker } from "./ui/SharePicker";
import { toast } from "./utils";

const logger = new Logger("P2PStream:Hooks");

let installed = false;
const originals: Array<[any, string, any]> = [];

function makeInterceptor(key: string, orig: (...args: any[]) => any): (...args: any[]) => any {
    const wrapped = function (this: any, ...args: any[]) {
        try {
            const mode = String(settings.store.goliveMode);
            if (mode === "p2p") {
                if (manager.hasDiscordStream(UserStore.getCurrentUser()?.id ?? "")) {
                    toast("Сначала остановите Discord-стрим", "critical");
                    return;
                }
                if (manager.host) {
                    toast("P2P-эфир уже идёт — панель остановки внизу экрана", "critical");
                    return;
                }
                // Свой пикер в стиле Discord: P2P или обычный стрим — на выбор
                void openSharePicker({ startDefault: () => orig.apply(this, args) });
                return;
            }
        } catch (e) {
            logger.error("Interceptor error:", e);
        }
        return orig.apply(this, args);
    };
    (wrapped as any).__vcP2PWrapped = true;
    return wrapped;
}

/** Попытаться обернуть точки входа Go Live. Возвращает true, если хоть что-то обёрнуто. */
export function tryInstallHooks(): boolean {
    if (installed) return true;

    const candidateProps: string[][] = [
        ["openShareModal"],
        ["setGoLiveSource", "stopStream"],
        ["startStream", "stopStream"]
    ];

    let count = 0;
    for (const props of candidateProps) {
        let mod: any;
        try {
            mod = findByProps(...props) as any;
        } catch {
            mod = null;
        }
        if (!mod) continue;
        for (const key of props) {
            const orig = mod[key];
            if (typeof orig !== "function" || orig.__vcP2PWrapped) continue;
            mod[key] = makeInterceptor(key, orig);
            originals.push([mod, key, orig]);
            count++;
        }
        if (count > 0) break; // одной точки входа достаточно
    }

    if (count > 0) {
        installed = true;
        logger.info(`Перехват кнопки демонстрации экрана установлен (${count} ф.)`);
    }
    return installed;
}

export function uninstallHooks(): void {
    for (const [mod, key, orig] of originals) {
        try { mod[key] = orig; } catch { /* ignore */ }
    }
    originals.length = 0;
    installed = false;
}
