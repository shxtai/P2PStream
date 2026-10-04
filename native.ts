/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Main-process часть плагина (Vesktop). Импортировать сюда модули рендерера
 * (@webpack, @api и т.д.) ЗАПРЕЩЕНО — файл бандлится в main-процесс,
 * и импорты рендерера ломают сборку (см. историю бага «Cannot find module ~plugins»).
 */

import { desktopCapturer } from "electron";

export interface P2PSourceInfo {
    /** Electron source id, например "screen:0:0" или "window:131076:0" */
    id: string;
    name: string;
    /** dataURL превью (png) или null, если кадр пустой */
    thumb: string | null;
    isScreen: boolean;
}

/** Список источников захвата (экраны вперёд, затем окна) с превью для собственного пикера. */
export async function getSources(width = 384, height = 216): Promise<P2PSourceInfo[]> {
    const sources = await desktopCapturer.getSources({
        types: ["window", "screen"],
        thumbnailSize: { width, height }
    });

    const list: P2PSourceInfo[] = sources.map(s => ({
        id: s.id,
        name: s.name || (s.id.startsWith("screen:") ? "Экран" : "Окно"),
        thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        isScreen: s.id.startsWith("screen:")
    }));

    list.sort((a, b) => Number(b.isScreen) - Number(a.isScreen) || a.name.localeCompare(b.name));
    return list;
}
