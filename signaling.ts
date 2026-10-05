/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { MessageActions } from "@webpack/common";

export type SignalType = "announce" | "bye" | "join" | "offer" | "answer" | "ice" | "leave" | "query";

export interface Signal {
    v: 1;
    t: SignalType;
    /** streamId (для query — "*") */
    s: string;
    /** userId отправителя */
    from: string;
    /** userId адресата (для адресных сообщений) */
    to?: string;
    /** данные */
    d?: any;
}

const logger = new Logger("P2PStream:Signaling");

const MARKER = "```vcp2p\n";
const TAIL = "\n```";
/** максимальная длина полезной нагрузки в одном сообщении (лимит Discord 2000 с запасом) */
const MAX_CHUNK = 1700;
/** время жизни собственных служебных сообщений, мс */
export const SELF_DESTRUCT_MS = 2500;

// region base64url
function bytesToB64url(bytes: Uint8Array): string {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str: string): Uint8Array {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4 !== 0) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
// endregion

// region compress
async function deflate(text: string): Promise<Uint8Array> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<string> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
}
// endregion

export function isSignalContent(content: string | null | undefined): boolean {
    return !!content && content.startsWith(MARKER) && content.endsWith(TAIL);
}

function payloadOf(content: string): string {
    return content.slice(MARKER.length, content.length - TAIL.length);
}

// region фрагментация
const fragBufs = new Map<string, { parts: (string | null)[]; total: number; ts: number }>();

function collectFragment(body: string): string | null {
    // F|sid|idx|total|chunk
    const sep1 = body.indexOf("|");
    const sep2 = body.indexOf("|", sep1 + 1);
    const sep3 = body.indexOf("|", sep2 + 1);
    if (sep1 < 0 || sep2 < 0 || sep3 < 0) return null;
    const sid = body.slice(sep1 + 1, sep2);
    const idx = parseInt(body.slice(sep2 + 1, sep3), 10);
    const rest = body.slice(sep3 + 1);
    const sep4 = rest.indexOf("|");
    if (sep4 < 0) return null;
    const total = parseInt(rest.slice(0, sep4), 10);
    const chunk = rest.slice(sep4 + 1);
    if (!sid || !Number.isFinite(idx) || !Number.isFinite(total) || total < 1 || total > 32) return null;

    let buf = fragBufs.get(sid);
    if (!buf) {
        buf = { parts: new Array<string | null>(total).fill(null), total, ts: Date.now() };
        fragBufs.set(sid, buf);
    }
    if (idx >= 0 && idx < total) buf.parts[idx] = chunk;
    buf.ts = Date.now();

    if (buf.parts.some(p => p === null)) return null;

    const joined = buf.parts.join("");
    fragBufs.delete(sid);
    return joined;
}

/** периодическая чистка недособранных фрагментов */
export function pruneFragments(): void {
    const now = Date.now();
    for (const [sid, buf] of fragBufs) {
        if (now - buf.ts > 10_000) fragBufs.delete(sid);
    }
}
// endregion

async function decodeBody(body: string): Promise<Signal | null> {
    try {
        const json = await inflate(b64urlToBytes(body));
        const sig = JSON.parse(json) as Signal;
        if (sig && sig.v === 1 && typeof sig.t === "string" && typeof sig.s === "string" && typeof sig.from === "string") {
            return sig;
        }
        return null;
    } catch (e) {
        logger.debug("Не удалось разобрать сигнал:", e);
        return null;
    }
}

/** Разобрать содержимое сообщения в 0..1 сигналов (фрагменты собираются автоматически) */
export async function parseSignals(content: string): Promise<Signal[]> {
    if (!isSignalContent(content)) return [];
    const body = payloadOf(content);
    let payload: string | null;
    if (body.startsWith("F|")) {
        payload = collectFragment(body);
        if (payload === null) return [];
    } else {
        payload = body;
    }
    const sig = await decodeBody(payload);
    return sig ? [sig] : [];
}

/** Закодировать сигнал в 1..N содержимых сообщений */
export async function encodeSignal(sig: Signal): Promise<string[]> {
    const bytes = await deflate(JSON.stringify(sig));
    const body = bytesToB64url(bytes);
    if (body.length <= MAX_CHUNK) {
        return [MARKER + body + TAIL];
    }
    const total = Math.ceil(body.length / MAX_CHUNK);
    const sid = `${sig.s}-${sig.t}-${Math.random().toString(36).slice(2, 8)}`;
    const out: string[] = [];
    for (let i = 0; i < total; i++) {
        out.push(MARKER + `F|${sid}|${i}|${total}|` + body.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK) + TAIL);
    }
    return out;
}

let cleanupEnabled = (): boolean => true;

/** Подключить настройку автоудаления (вызывается из engine, чтобы избежать цикла импортов) */
export function setCleanupEnabledGetter(fn: () => boolean): void {
    cleanupEnabled = fn;
}

/** Отправить сигнал в чат канала (фрагменты — строго последовательно, иначе соберутся не по порядку) */
export function sendSignals(channelId: string, sig: Signal, onSent?: (messageId: string) => void): void {
    void (async () => {
        try {
            const contents = await encodeSignal(sig);
            for (const content of contents) {
                const ok = await sendMessageSafe(channelId, content);
                if (!ok) break; // сигналинг лежит — не спамим остальными фрагментами
            }
        } catch (e) {
            logger.error("Ошибка отправки сигнала:", e);
        }
    })();
}

/** Здоровье сигналинга — движок по нему предупреждает, если эфир видят только мы */
export const signalingHealth = {
    sent: 0,
    failed: 0,
    consecutiveFailures: 0,
    lastError: null as string | null,
    lastSuccess: 0
};

/** Числовой nonce в духе Discord (произвольная строка, сервер возвращает её в эхе) */
function makeNonce(): string {
    let s = String(Date.now());
    while (s.length < 18) s += Math.floor(Math.random() * 10);
    return s;
}

/**
 * Отправка одного сообщения. Возвращает true, если Discord принял вызов без ошибки.
 *
 * ВАЖНО: в свежих сборках Discord сигнатура
 *   sendMessage(channelId, message, createLocally, options)
 * — nonce и allowedMentions живут в options (4-й аргумент). Вызов с двумя
 * аргументами падает с «TypeError: Cannot read properties of undefined
 * (reading 'nonce')» внутри Discord. Для совместимости со старыми сборками
 * дублируем nonce в message — лишние аргументы/поля старые версии игнорируют.
 */
async function sendMessageSafe(channelId: string, content: string): Promise<boolean> {
    try {
        const nonce = makeNonce();
        const res: unknown = (MessageActions as any).sendMessage(
            channelId,
            { content, tts: false, nonce },
            true,
            { nonce, allowedMentions: { parse: [] } }
        );
        if (res && typeof (res as Promise<unknown>).catch === "function") {
            await (res as Promise<unknown>);
        }
        signalingHealth.sent++;
        signalingHealth.consecutiveFailures = 0;
        signalingHealth.lastSuccess = Date.now();
        return true;
    } catch (e: any) {
        signalingHealth.failed++;
        signalingHealth.consecutiveFailures++;
        signalingHealth.lastError = e?.message ?? String(e);
        logger.error("sendMessage не удался:", e);
        return false;
    }
}

// region самоуничтожение собственных сигналов
/** nonce -> все известные id сообщения (локальное эхо + сообщение из шлюза) */
const ownEchoes = new Map<string, { channelId: string; ids: Set<string>; done: boolean }>();

/**
 * Учесть собственное служебное сообщение для удаления через SELF_DESTRUCT_MS.
 * Локальное эхо и сообщение из шлюза имеют разные id, но один nonce —
 * собираем оба и удаляем оба (иначе в чате остаётся «хвост»).
 */
export function handleOwnEcho(msg: { id?: string; channel_id?: string; nonce?: string }): void {
    if (!msg?.id || !msg.channel_id) return;
    const key = msg.nonce ? `n:${msg.nonce}` : `i:${msg.id}`;
    let entry = ownEchoes.get(key);
    if (!entry) {
        entry = { channelId: msg.channel_id, ids: new Set(), done: false };
        ownEchoes.set(key, entry);
        setTimeout(() => {
            entry!.done = true;
            flushEcho(entry!);
        }, SELF_DESTRUCT_MS + 400);
        setTimeout(() => ownEchoes.delete(key), 20_000);
    }
    entry.ids.add(msg.id);
    if (entry.done) flushEcho(entry); // позднее эхо — удаляем сразу
}

function flushEcho(entry: { channelId: string; ids: Set<string> }): void {
    for (const id of entry.ids) {
        deleteSignalMessage(entry.channelId, id);
    }
}
// endregion

/** Удалить сообщение (используется для самоуничтожения служебных сообщений) */
export function deleteSignalMessage(channelId: string, messageId: string): void {
    try {
        void MessageActions.deleteMessage(channelId, messageId);
    } catch (e) {
        // нет прав на удаление чужих сообщений — не страшно, отправитель удалит своё эхо сам
        logger.debug("Не удалось удалить сообщение:", e);
    }
}
