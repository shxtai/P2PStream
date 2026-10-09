/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Штатный плеер Discord для P2P-эфиров (v1.11).
 *
 * Идея: когда зритель нажимает «Смотреть» на нашей плитке, Discord открывает
 * СВОЙ штатный экран просмотра (тот же, что для обычных стримов — с фуллскрином,
 * поп-аутом, громкостью и кнопкой PiP). Внутри Discord подключается к своему
 * RTC и получает пустоту — мы же подменяем srcObject у видео-элемента, который
 * Discord создаёт, на наш P2P MediaStream. Пользователь видит P2P-эфир ВНУТРИ
 * штатного интерфейса: ничего не выбивается, все кнопки Discord работают.
 *
 * Страховка: если за 4.5 с наш стрим так и не заиграл в штатном плеере
 * (Discord закрыл модалку из-за ошибки RTC и т.п.) — открываем свой просмотрщик.
 */

import { Logger } from "@utils/Logger";

import { type WatchSession } from "./engine";
import { settings } from "./settings";
import { toast } from "./utils";

const logger = new Logger("P2PStream:NativePlayer");

const FALLBACK_MS = 4500;

/** Мини-интерфейс для закрытия штатного потока Discord (переходим из nativeTiles) */
export interface NativeWatchHooks {
    /** открыть штатную модалку просмотра Discord (оригинальный setActiveStream) */
    openNativeModal(): void;
    /** закрыть штатную модалку (оригинальный clearActiveStream), если была открыта */
    closeNativeModal(): void;
}

/** видео-элементы, к которым мы уже привязали поток */
const bound = new WeakSet<HTMLVideoElement>();
let activeWatchs = 0;

function isOurs(el: Element): boolean {
    // наши корни: панели/бары/мини-плеер/модалки плагина — префикс класса vc-p2p
    if (el.closest('[class*="vc-p2p"]')) return true;
    return false;
}

function tryBind(video: HTMLVideoElement, session: WatchSession): boolean {
    if (bound.has(video)) return false;
    if (isOurs(video)) return false;
    try {
        video.srcObject = session.stream;
        video.playsInline = true;
        const p = video.play();
        if (p) p.catch(() => { /* до жеста автоплей может быть отклонён — звук уже разрешён звонком */ });
        bound.add(video);
        logger.info("P2P-эфир подключён к штатному плееру Discord");
        return true;
    } catch (e) {
        logger.debug("bind failed:", e);
        return false;
    }
}

/**
 * Играть P2P-эфир в штатном плеере Discord. Открывает штатную модалку,
 * следит за появлением видео-элементов и подключает к ним поток.
 * Возвращает true, если штатный плеер реально заиграл.
 */
export function playInNativePlayer(session: WatchSession, hooks: NativeWatchHooks): boolean {
    if (settings.store.nativePlayer === false) return false;

    activeWatchs++;
    hooks.openNativeModal();
    logger.info("Открываю штатный плеер Discord для P2P-эфира");

    let boundAny = false;
    let settled = false;

    const observer = new MutationObserver(muts => {
        if (boundAny && settled) return;
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (!(n instanceof HTMLVideoElement)) {
                    // видео может приехать вглубь добавленного поддерева
                    if (n instanceof HTMLElement) {
                        n.querySelectorAll?.("video").forEach(v => {
                            if (!boundAny && tryBind(v, session)) boundAny = true;
                        });
                    }
                    continue;
                }
                if (!boundAny && tryBind(n, session)) boundAny = true;
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // на случай, если видео уже в DOM до старта наблюдателя
    document.querySelectorAll("video").forEach(v => {
        if (!boundAny && !isOurs(v) && !(v as any).srcObject) {
            if (tryBind(v, session)) boundAny = true;
        }
    });

    const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        activeWatchs = Math.max(0, activeWatchs - 1);
        if (ok) {
            // штатный плеер живёт своей жизнью; при завершении эфира закрываем его
            const un = () => {
                try { hooks.closeNativeModal(); } catch { /* ignore */ }
            };
            session.onEnded = un;
        } else {
            logger.info("Штатный плеер не завёлся — открываю свой просмотрщик");
            try { hooks.closeNativeModal(); } catch { /* ignore */ }
            toast("Штатный плеер не открылся — включаю просмотрщик P2PStream");
            void import("./ui/ViewerModal").then(m => m.openViewerModal(session)).catch(() => { /* ignore */ });
        }
    };

    // проверка через 4.5 с: наш стрим реально играет в штатном плеере?
    setTimeout(() => {
        if (settled) return;
        const v = [...document.querySelectorAll("video")].find(el =>
            bound.has(el) && el.srcObject === session.stream && el.videoWidth > 0
        );
        if (boundAny && v) {
            finish(true);
        } else {
            finish(false);
        }
    }, FALLBACK_MS);

    return true;
}

/** Вызывается при остановке просмотра, чтобы не держать счётчик */
export function noteNativeWatchClosed(): void {
    activeWatchs = Math.max(0, activeWatchs - 1);
}
