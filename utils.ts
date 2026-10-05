/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Toasts, UserStore } from "@webpack/common";

/** Версия плагина (видна в консоли, /p2p-doctor и анонсах) */
export const PLUGIN_VERSION = "1.7.0";

export function toast(message: string, variant: "default" | "success" | "critical" = "default"): void {
    try {
        Toasts.show({
            text: message,
            variant,
            duration: 3500
        });
    } catch {
        // тосты недоступны (ранняя загрузка) — молча игнорируем
    }
}

export function myId(): string {
    return UserStore.getCurrentUser()?.id ?? "";
}

export function myName(): string {
    const me = UserStore.getCurrentUser();
    return me ? (me.globalName ?? me.username) : "Я";
}

export function userName(userId: string): string {
    const u = UserStore.getUser?.(userId);
    if (!u) return userId;
    return (u.globalName ?? u.username) ?? userId;
}

export function randomId(len = 8): string {
    return Math.random().toString(36).slice(2, 2 + len);
}
