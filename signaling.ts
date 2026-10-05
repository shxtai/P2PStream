/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Кодирование/отправка сигналов. С v1.7 сигналы по умолчанию идут через
 * публичный MQTT-брокер (см. broker.ts) — в чате Discord кодов НЕТ.
 * Чат остаётся аварийным фолбэком (settings.chatFallback): коды отправляются
 * и удаляются отправителем с защитой от 404/429.
 */

import { Logger } from "@utils/Logger";
import { MessageActions } from "@webpack/common";

import {
    brokerChannelTopic,
    brokerIsConnected,
    brokerPublicKey,
    brokerPublish,
    brokerSeal,
    brokerStatus,
    brokerWaitConnected,
    TOPIC_PREFIX
} from "./broker";
import { settings } from "./settings";

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
    /** ПУБЛИЧНЫЙ КЛЮЧ АДРЕСАТА (base64url P-256) — нужен для шифрования
     *  offer/answer/ice; в брокерном конверте уходит и наш публичный ключ. */
    pk?: string;
    /** Принудительная маршрутизация (внутреннее поле движка):
     *  "broker" — только брокер; "chat" — только чат (пир старой версии);
     *  "both" — в оба канала (возможности пира неизвестны). */
    _route?: "broker" | "chat" | "both";
}

const logger = new Logger("P2PStream:Signaling");

const MARKER = "```vcp2p\n";
const TAIL = "\n```";
/** максимальная длина полезной нагрузки в одном сообщении (лимит Discord 2000 с запасом) */
const MAX_CHUNK = 1700;
/** время жизни собственных служебных сообщений (фолбэк), мс */
export const SELF_DESTRUCT_MS = 1500;

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

// region транспорт через брокер (основной путь, в чат ничего не попадает)
/** Конверт брокера: { v:1, k, from, to?, s?, ch?, pk?, d? | e? } */
async function tryBrokerSend(channelId: string, sig: Signal): Promise<boolean> {
    switch (sig.t) {
        case "announce":
        case "query":
        case "bye":
            // широковещательные — в топик голосового канала
            return brokerPublish(brokerChannelTopic(channelId), {
                v: 1, k: sig.t, s: sig.s, from: sig.from, ch: channelId, d: sig.d ?? null
            });
        case "join":
        case "leave": {
            if (!sig.to) return false;
            // join несёт только намерение смотреть — секретов нет;
            // наш публичный ключ нужен хосту, чтобы шифровать offer/ice нам
            const pk = sig.t === "join" ? await brokerPublicKey() : undefined;
            return brokerPublish(`${TOPIC_PREFIX}/u/${sig.to}`, {
                v: 1, k: sig.t, s: sig.s, from: sig.from, ch: channelId, pk
            });
        }
        case "offer":
        case "answer":
        case "ice": {
            if (!sig.to || !sig.pk) return false;
            // SDP и ICE содержат IP — шифруем ECDH+AES-GCM ключом адресата
            const [sealed, myPk] = await Promise.all([brokerSeal(sig.pk, sig.d ?? null), brokerPublicKey()]);
            return brokerPublish(`${TOPIC_PREFIX}/u/${sig.to}`, {
                v: 1, k: sig.t, s: sig.s, from: sig.from, ch: channelId, pk: myPk, e: sealed
            });
        }
        default:
            return false;
    }
}
// endregion

/** Отправить сигнал. Маршрут: _route="chat"/"both" (совместимость со старыми
 *  версиями пира) или брокер-первым (по умолчанию). В чате при брокере НИЧЕГО
 *  не появляется, кроме случая "chat"/"both" для старых версий пиров. */
export function sendSignals(channelId: string, sig: Signal): void {
    void (async () => {
        try {
            const route = sig._route;
            if (route !== "chat") {
                // если брокер сейчас подключается — даём ему шанс (первый announce уходит сразу после старта эфира)
                if (brokerStatus() === "connecting") await brokerWaitConnected(1200);
                const okBroker = await tryBrokerSend(channelId, sig);
                if (okBroker && route !== "both") return;
            }
            if (route === "broker") return;
            if (settings.store.chatFallback === false) {
                if (route !== "both") logger.warn("Брокер недоступен, чат-фолбэк выключен — сигнал не отправлен:", sig.t);
                return;
            }
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
 * Отправка одного сообщения в чат (только фолбэк). Возвращает true, если Discord принял вызов без ошибки.
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
        recentNonces.add(nonce);
        setTimeout(() => recentNonces.delete(nonce), 30_000);
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

// region самоуничтожение собственных сигналов (фолбэк)
/** nonce -> все известные id сообщения. Удаляем ТОЛЬКО реальный id из шлюза:
 *  optimistic-id серверу не знаком — попытка удалить его даёт 404,
 *  а Discord сам подменяет optimistic-сообщение на реальное по nonce. */
const ownEchoes = new Map<string, { channelId: string; realId: string | null; nonce: string }>();

/** недавние свои nonce — по ним отличаем optimistic-эхо от реального сообщения */
const recentNonces = new Set<string>();

/** id-шники, которые мы уже пробовали удалять (защита от повторов/шторма 429) */
const deletedIds = new Set<string>();

/** очередь удалений: не чаще одного DELETE в ~1.1 с, иначе Discord отвечает 429 */
const deleteQueue: Array<[string, string]> = [];
let deleteDrain: NodeJS.Timeout | undefined;

function drainDeletes(): void {
    const item = deleteQueue.shift();
    if (!item) {
        if (deleteDrain) clearInterval(deleteDrain);
        deleteDrain = undefined;
        return;
    }
    try {
        const p: unknown = (MessageActions as any).deleteMessage(item[0], item[1]);
        // 404/429 здесь — норм (сообщение уже удалено/лимит): глушим rejection,
        // иначе «Uncaught (in promise) HTTPResponseError» сыпется в консоль
        Promise.resolve(p).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
}

function queueDelete(channelId: string, id: string): void {
    if (!channelId || !id) return;
    // только снежинки (17-20 цифр): optimistic/nonce-подобные id сервер не знает
    if (!/^\d{15,22}$/.test(id)) return;
    if (deletedIds.has(id)) return;
    if (deletedIds.size > 400) deletedIds.clear();
    deletedIds.add(id);
    deleteQueue.push([channelId, id]);
    if (!deleteDrain) deleteDrain = setInterval(drainDeletes, 1100);
}

/**
 * Учесть собственное служебное сообщение для удаления через SELF_DESTRUCT_MS.
 * Локальное (optimistic) эхо имеет тот же nonce, но другой id — удаляем только
 * реальный id, пришедший из шлюза (payload.optimistic !== true). Если optimistic-
 * флаг недоступен — удаляем оба id: лишний DELETE по optimistic-id тихо 404нет
 * (rejection глушится, лимит соблюдает очередь).
 */
export function handleOwnEcho(msg: { id?: string; channel_id?: string; nonce?: string; optimistic?: boolean }): void {
    if (!msg?.id || !msg.channel_id) return;
    const key = msg.nonce ? `n:${msg.nonce}` : `i:${msg.id}`;
    let entry = ownEchoes.get(key);
    if (!entry) {
        entry = { channelId: msg.channel_id, realId: null, nonce: msg.nonce ?? "" };
        ownEchoes.set(key, entry);
        setTimeout(() => {
            if (entry!.realId && cleanupEnabled()) queueDelete(entry!.channelId, entry!.realId);
            ownEchoes.delete(key);
        }, SELF_DESTRUCT_MS + 700);
    }
    if (msg.optimistic !== true) entry.realId = msg.id;
}
// endregion

/** Удалить сообщение (фолбэк: самоуничтожение служебных сообщений) */
export function deleteSignalMessage(channelId: string, messageId: string): void {
    queueDelete(channelId, messageId);
}
