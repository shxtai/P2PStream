/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Кодирование/отправка сигналов. Транспорты (в порядке приоритета):
 *
 *  1. MQTT-брокер (broker.ts, опционально) — Discord вообще не участвует.
 *
 *  2. ТИХИЙ ДИСКОРД-ТРАНСПОРТ (v1.10, основной): сигналы едут штатными
 *     сообщениями Discord с флагом SUPPRESS_NOTIFICATIONS (1<<12) — тем же,
 *     что клиент ставит для «@silent». Ни у кого НИКАКИХ уведомлений:
 *       - адресные сигналы (join/offer/answer/ice/leave, reply на query)
 *         идут в ЛС между стримером и зрителем — канал никто не видит;
 *       - broadcast (announce/query/bye) — в чат голосового канала;
 *     каждое сообщение удаляется отправителем через ~2 с (REST возвращает
 *     реальный id сразу — самоудаление надёжнее, чем через эхо шлюза).
 *     offer/answer/ice дополнительно шифруются ECDH P-256 + AES-GCM (та же
 *     крипта, что в брокере) — даже внутри ЛС SDP с IP-адресами запечатан.
 *
 *  3. Старый путь MessageActions (видимые коды с автоудалением) — последний
 *     фолбэк, если REST-отправка не удалась.
 */

import { Logger } from "@utils/Logger";
import { ChannelStore, MessageActions, RestAPI } from "@webpack/common";

import {
    brokerChannelTopic,
    brokerIsConnected,
    brokerOpen,
    brokerPublicKey,
    brokerPublish,
    brokerSeal,
    brokerStatus,
    brokerWaitConnected,
    type Sealed,
    TOPIC_PREFIX
} from "./broker";
import { settings } from "./settings";
import { PLUGIN_VERSION } from "./utils";

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
    /** данные (на проводе в offer/answer/ice заменяется на запечатанный e) */
    d?: any;
    /** ПУБЛИЧНЫЙ КЛЮЧ: у исходящего сигнала — ключ АДРЕСАТА (шим шифруем),
     *  во входящем конверте — ключ ОТПРАВИТЕЛЯ (им шифруем ответ). */
    pk?: string;
    /** голосовой канал, к которому относится сигнал (в ЛС-транспорте msg.channel_id — ЛС, поэтому ch обязателен) */
    ch?: string;
    /** версия плагина отправителя (join — чтобы хост знал, можно ли шифровать ему) */
    av?: string;
    /** Принудительная маршрутизация (внутреннее поле движка):
     *  "broker" — только брокер; "chat" — только Discord-транспорт (пир старой версии);
     *  "both" — в оба канала (возможности пира неизвестны). */
    _route?: "broker" | "chat" | "both";
}

const logger = new Logger("P2PStream:Signaling");

const MARKER = "```vcp2p\n";
const TAIL = "\n```";
/** максимальная длина полезной нагрузки в одном сообщении (лимит Discord 2000 с запасом) */
const MAX_CHUNK = 1700;
/** время жизни собственных служебных сообщений, мс */
export const SELF_DESTRUCT_MS = 1500;
/** флаг Discord «@silent»: без push-уведомлений и значков у получателей */
const SUPPRESS_NOTIFICATIONS = 1 << 12;

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

/** Разобрать содержимое сообщения в 0..1 сигналов (фрагменты собираются автоматически).
 *  Здесь же распечатываются зашифрованные payloads (e): конверт несёт публичный
 *  ключ отправителя (pk) — им выводится общий секрет, расшифровываем d. */
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
    try {
        const wire = JSON.parse(await inflate(b64urlToBytes(payload))) as Record<string, any>;
        if (!wire || wire.v !== 1 || typeof wire.t !== "string" || typeof wire.s !== "string" || typeof wire.from !== "string") {
            return [];
        }
        const sig: Signal = {
            v: 1,
            t: wire.t as SignalType,
            s: wire.s,
            from: wire.from,
            to: typeof wire.to === "string" ? wire.to : undefined,
            ch: typeof wire.ch === "string" ? wire.ch : undefined,
            pk: typeof wire.pk === "string" ? wire.pk : undefined,
            av: typeof wire.av === "string" ? wire.av : undefined
        };
        if (wire.e && wire.pk) {
            // запечатанный payload (offer/answer/ice) — распечатываем
            try {
                sig.d = await brokerOpen(wire.pk, wire.e as Sealed);
            } catch (e) {
                logger.debug("Не удалось распечатать сигнал (чужой/битый ключ?):", e);
                return [];
            }
        } else {
            sig.d = wire.d;
        }
        return [sig];
    } catch (e) {
        logger.debug("Не удалось разобрать сигнал:", e);
        return [];
    }
}

/**
 * Закодировать сигнал в 1..N содержимых сообщений (конверт Discord-транспорта).
 * Конверт: { v:1, t, s, from, to?, ch, d? | (e? + pk?), pk? }:
 *   - ch — голосовой канал (в ЛС-транспорте получатель не увидит его из msg.channel_id);
 *   - offer/answer/ice с известным ключом адресата уезжают запечатанными
 *     ECDH+AES-GCM, в конверте остаётся НАШ публичный ключ для обратного ответа;
 *   - join несёт наш публичный ключ в pk — хост им зашифрует оффер нам.
 */
export async function encodeSignal(sig: Signal, voiceChannelId?: string): Promise<string[]> {
    const wire: Record<string, unknown> = {
        v: 1,
        t: sig.t,
        s: sig.s,
        from: sig.from,
        ch: voiceChannelId ?? sig.ch
    };
    if (sig.to) wire.to = sig.to;

    if (sig.d !== undefined && sig.pk) {
        const [sealed, myPk] = await Promise.all([brokerSeal(sig.pk, sig.d), brokerPublicKey()]);
        wire.e = sealed;
        wire.pk = myPk;
    } else {
        wire.d = sig.d ?? null;
        if (sig.t === "join") {
            // наш публичный ключ (хост им зашифрует оффер нам) + версия (гейтинг шифрования)
            wire.pk = await brokerPublicKey();
            wire.av = PLUGIN_VERSION;
        }
    }

    const bytes = await deflate(JSON.stringify(wire));
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

// region тихий Discord-транспорт (@silent + ЛС + самоудаление)
/** Здоровье сигналинга — движок по нему предупреждает, если эфир видят только мы */
export const signalingHealth = {
    sent: 0,
    failed: 0,
    consecutiveFailures: 0,
    lastError: null as string | null,
    lastSuccess: 0
};

function healthOk(): void {
    signalingHealth.sent++;
    signalingHealth.consecutiveFailures = 0;
    signalingHealth.lastSuccess = Date.now();
}

function healthFail(e: unknown): void {
    signalingHealth.failed++;
    signalingHealth.consecutiveFailures++;
    signalingHealth.lastError = e instanceof Error ? e.message : String(e);
}

/** Кэш ЛС-каналов: userId -> channelId (заполняется ChannelStore и REST'ом) */
const dmChannels = new Map<string, string>();

/** Существующий ЛС-канал с пользователем (синхронно, без запросов) */
function existingDm(userId: string): string | null {
    try {
        const id = ChannelStore?.getDMFromUserId?.(userId);
        if (typeof id === "string" && id) {
            dmChannels.set(userId, id);
            return id;
        }
    } catch { /* ignore */ }
    return dmChannels.get(userId) ?? null;
}

/** channelIds, для которых ЛС создать не вышло (не долбим REST повторно) */
const dmFailedUntil = new Map<string, number>();

/** ЛС-канал с пользователем; при отсутствии — создать REST-запросом */
async function dmChannelFor(userId: string): Promise<string | null> {
    if (!userId) return null;
    const cached = existingDm(userId);
    if (cached) return cached;
    const blocked = dmFailedUntil.get(userId);
    if (blocked && Date.now() < blocked) return null;
    try {
        const res: any = await RestAPI.post({
            url: "/users/@me/channels",
            body: { recipient_id: userId }
        });
        const id: string | undefined = res?.body?.id;
        if (id) {
            dmChannels.set(userId, id);
            return id;
        }
        return null;
    } catch (e) {
        // 403 — у адресата закрыты ЛС; не повторяем 2 минуты
        dmFailedUntil.set(userId, Date.now() + 120_000);
        healthFail(e);
        return null;
    }
}

/** Тихая REST-отправка упала на СЕТЕВОМ уровне (ERR_CONNECTION_CLOSED, «Request has
 *  been terminated» — без HTTP-статуса): до этого момента не пытаемся её повторять.
 *  Иначе каждый сигнал тратил секунды на две заведомо мёртвые попытки (ЛС + канал),
 *  оффер не успевал дойти, и зритель сдавался раньше, чем хост ответит. */
let silentRestBrokenUntil = 0;
const SILENT_REST_COOLDOWN_MS = 5 * 60_000;

export function silentRestAvailable(): boolean {
    return Date.now() >= silentRestBrokenUntil;
}

/** Отправить ОДНО тихое сообщение REST-ом; возвращает messageId или null */
async function sendSilentMessage(channelId: string, content: string): Promise<string | null> {
    if (!silentRestAvailable()) return null;
    const nonce = makeNonce();
    try {
        const res: any = await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                content,
                flags: SUPPRESS_NOTIFICATIONS,
                tts: false,
                nonce,
                allowedMentions: { parse: [] }
            }
        });
        const id: string | undefined = res?.body?.id;
        if (!id) throw new Error("REST-ответ без id сообщения");
        healthOk();
        return id;
    } catch (e: any) {
        healthFail(e);
        const status = e?.status ?? e?.body?.code;
        if (!status) {
            silentRestBrokenUntil = Date.now() + SILENT_REST_COOLDOWN_MS;
        }
        logger.warn(`Тихая отправка в ${channelId} не удалась (${status ?? e?.message}): перехожу на обычную`);
        return null;
    }
}

/** Отправить сигнал адресно через ЛС (@silent, самоудаление). true — ушло. */
async function sendViaDm(voiceChannelId: string, sig: Signal, contents: string[]): Promise<boolean> {
    if (!silentRestAvailable()) return false;
    const dm = await dmChannelFor(sig.to!);
    // ЛС закрыто — падаем в тихий канал голосового чата
    const target = dm ?? voiceChannelId;
    let sent = 0;
    for (const content of contents) {
        const id = await sendSilentMessage(target, content);
        if (!id) break;
        scheduleSelfDelete(target, id);
        sent++;
    }
    return sent === contents.length;
}

/** Отправить broadcast-сигнал в голосовой канал (@silent, самоудаление). true — ушло. */
async function sendViaVoiceChannel(voiceChannelId: string, contents: string[]): Promise<boolean> {
    let sent = 0;
    for (const content of contents) {
        const id = await sendSilentMessage(voiceChannelId, content);
        if (!id) break;
        scheduleSelfDelete(voiceChannelId, id);
        sent++;
    }
    return sent === contents.length;
}

/** Самоудаление тихого сообщения: REST вернул реальный id — надёжно и без эха шлюза */
function scheduleSelfDelete(channelId: string, messageId: string): void {
    setTimeout(() => {
        if (cleanupEnabled()) queueDelete(channelId, messageId);
    }, SELF_DESTRUCT_MS + 500);
}
// endregion

/** Отправить сигнал. Маршрут: _route="chat"/"both" (совместимость со старыми
 *  версиями пиров) или брокер-первым (по умолчанию).
 *
 *  Discord-транспорт (v1.10): тихие @silent-сообщения через REST;
 *  адресные сигналы — в ЛС с получателем, broadcast — в голосовой канал.
 *  Если REST не удался — старый путь MessageActions (видимые коды с самоудалением). */
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
                if (route !== "both") logger.warn("Брокер недоступен, Discord-транспорт выключен — сигнал не отправлен:", sig.t);
                return;
            }

            const contents = await encodeSignal(sig, channelId);

            // 1) адресные сигналы — в ЛС с получателем (никто не видит), тихо
            if (sig.to && settings.store.silentDm !== false && silentRestAvailable()) {
                if (await sendViaDm(channelId, sig, contents)) return;
            }
            // 2) broadcast (или ЛС не вышло) — тихое сообщение в голосовой канал.
            // В звонке в ЛС голосовой канал = ЛС: повторять ту же попытку бессмысленно.
            const dmIsVoice = !!sig.to && existingDm(sig.to) === channelId;
            if (settings.store.silentDm !== false && silentRestAvailable() && !dmIsVoice) {
                if (await sendViaVoiceChannel(channelId, contents)) return;
            }
            // 3) последний фолбэк — старый путь (видимые коды с автоудалением)
            for (const content of contents) {
                const ok = await sendMessageSafe(channelId, content);
                if (!ok) break; // сигналинг лежит — не спамим остальными фрагментами
            }
        } catch (e) {
            logger.error("Ошибка отправки сигнала:", e);
        }
    })();
}

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
            { content, tts: false, nonce, flags: SUPPRESS_NOTIFICATIONS },
            true,
            { nonce, allowedMentions: { parse: [] }, flags: SUPPRESS_NOTIFICATIONS }
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
