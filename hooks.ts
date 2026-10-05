/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { UserStore } from "@webpack/common";

import { manager } from "./engine";
import { settings } from "./settings";
import { openSharePicker } from "./ui/SharePicker";
import { toast } from "./utils";

const logger = new Logger("P2PStream:Hooks");

/**
 * Оригинальный getDisplayMedia, снятый в момент загрузки модуля — до того,
 * как кто-либо (WebScreenShare, Vesktop и т.д.) успел его подменить.
 * Через него идут «обычные» стримы Discord — так пользователь видит ровно
 * тот пикер, к которому привык (Vesktop-пикер / браузерный).
 */
const realGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

function notAllowedError(): Error {
    const e = new Error("P2PStream: cancelled");
    e.name = "NotAllowedError";
    return e;
}

let installed = false;
let reassertTimer: NodeJS.Timeout | undefined;
let ourWrapper: ((opts: DisplayMediaStreamOptions) => Promise<MediaStream>) | null = null;

function makeWrapper(): (opts: DisplayMediaStreamOptions) => Promise<MediaStream> {
    return async function (opts: DisplayMediaStreamOptions) {
        if (String(settings.store.goliveMode) !== "p2p") {
            return realGetDisplayMedia(opts);
        }
        try {
            const me = UserStore.getCurrentUser()?.id ?? "";
            if (manager.host) {
                toast("P2P-эфир уже идёт — панель остановки внизу экрана", "critical");
                throw notAllowedError();
            }
            if (manager.hasDiscordStream(me)) {
                toast("Сначала остановите Discord-стрим", "critical");
                throw notAllowedError();
            }
            // Свой пикер: резолвится потоком для «обычного стрима» (только когда
            // gdm вызвал сам Discord), кидает NotAllowedError при отмене и после старта P2P.
            const stream = await openSharePicker({
                discordOptions: opts,
                gdm: realGetDisplayMedia,
                fromDiscord: !manager.internalGdmCall
            });
            return stream;
        } catch (e) {
            // Пользователь отменил / выбрал P2P — для Discord это «отмена захвата».
            if ((e as any)?.name === "NotAllowedError") throw e;
            logger.error("Ошибка пикера:", e);
            throw notAllowedError();
        }
    };
}

/** Установить/переподтвердить нашу подмену getDisplayMedia (устойчиво к чужим подменам). */
function assertWrapper(): void {
    if (!ourWrapper) ourWrapper = makeWrapper();
    const current = navigator.mediaDevices.getDisplayMedia;
    if (current !== ourWrapper) {
        navigator.mediaDevices.getDisplayMedia = ourWrapper as any;
        logger.info("getDisplayMedia перехвачен: кнопка стрима открывает пикер P2PStream");
    }
}

export function installShareHook(): void {
    assertWrapper();
    if (!reassertTimer) {
        // если другой плагин (например, WebScreenShare) подменяет getDisplayMedia
        // после нас — тихо перекрываем обратно
        reassertTimer = setInterval(assertWrapper, 3000);
    }
    installed = true;
}

export function uninstallShareHook(): void {
    if (reassertTimer) {
        clearInterval(reassertTimer);
        reassertTimer = undefined;
    }
    if (installed && ourWrapper && navigator.mediaDevices.getDisplayMedia === ourWrapper) {
        navigator.mediaDevices.getDisplayMedia = realGetDisplayMedia as any;
    }
    installed = false;
    logger.info("Перехват getDisplayMedia снят");
}

export function isShareHookInstalled(): boolean {
    return installed;
}
