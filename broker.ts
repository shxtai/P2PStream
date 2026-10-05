/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Сигналинг через публичный MQTT-брокер (v1.7, «тихий сигналинг»).
 *
 * Раньше весь обмен (announce/query/join/offer/answer/ICE) ходил СООБЩЕНИЯМИ
 * в чат Discord — пользователи видели потоки кодов в ЛС, Discord отвечал
 * 429 на самоудаления. Теперь всё идёт через бесплатный публичный брокер:
 *
 *   - топик личного ящика:  p2ps/v1/u/<discordUserId>   (адресные сигналы);
 *   - топик голосового канала: p2ps/v1/c/<channelId>    (announce/query/bye).
 *
 * Топики детерминированы из Discord ID — никакой регистрации и ключей.
 * Переговорные payloads (offer/answer/ICE — внутри SDP есть IP) шифруются
 * ECDH P-256 + AES-GCM: публичный ключ стороны прикладывается к join/offer,
 * дальше обе стороны шифруют трафик общим секретом.
 *
 * Реализован минимальный MQTT 3.1.1 клиент поверх WebSocket (QoS 0),
 * без внешних зависимостей. Если брокеры недоступны — движок откатывается
 * на старый сигналинг через чат (см. settings.chatFallback).
 */

import { Logger } from "@utils/Logger";

import { settings } from "./settings";
import { myId, randomId } from "./utils";

const logger = new Logger("P2PStream:Broker");

export const TOPIC_PREFIX = "p2ps/v1";

/** Брокеры по умолчанию (публичные песочницы, анонимные WSS). */
export const DEFAULT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081/mqtt"
];

const KEEPALIVE_S = 60;
const PING_MS = 40_000;
const RECONNECT_BASE_MS = 2_500;
const RECONNECT_MAX_MS = 20_000;
/** таймаут на CONNACK/открытие WSS — раньше при молчащем брокере навсегда висели в "connecting" */
const CONNECT_TIMEOUT_MS = 6_000;
/** после стольких неудач подряд — длинный cooldown, чтобы не долбить мёртвые брокеры */
const COOLDOWN_AFTER_ATTEMPTS = 10;
const COOLDOWN_MS = 60_000;
/** Столько брокер не нужен (нет голоса/эфира/просмотров) — отключаемся. */
const IDLE_DISCONNECT_MS = 120_000;

// region MQTT-кодирование
const te = new TextEncoder();
const td = new TextDecoder();

function mqttBytes(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + bytes.length);
    out[0] = (bytes.length >> 8) & 0xff;
    out[1] = bytes.length & 0xff;
    out.set(bytes, 2);
    return out;
}

function mqttString(s: string): Uint8Array {
    return mqttBytes(te.encode(s));
}

function varint(len: number): number[] {
    const out: number[] = [];
    do {
        let d = len % 128;
        len = Math.floor(len / 128);
        if (len > 0) d |= 0x80;
        out.push(d);
    } while (len > 0);
    return out;
}

function packet(firstByte: number, body: Uint8Array): Uint8Array {
    const head = varint(body.length);
    const out = new Uint8Array(1 + head.length + body.length);
    out[0] = firstByte;
    out.set(head, 1);
    out.set(body, 1 + head.length);
    return out;
}

function connectPacket(clientId: string): Uint8Array {
    const body = new Uint8Array([
        ...mqttString("MQTT"),
        0x04,        // protocol level (MQTT 3.1.1)
        0x02,        // clean session
        (KEEPALIVE_S >> 8) & 0xff,
        KEEPALIVE_S & 0xff,
        ...mqttString(clientId)
    ]);
    return packet(0x10, body);
}

function subscribePacket(topics: string[]): Uint8Array {
    const parts: number[] = [0x00, 0x01]; // packet id = 1 (QoS 0 — ack не критичен)
    const chunks: Uint8Array[] = [];
    for (const t of topics) chunks.push(mqttString(t));
    const tailLen = chunks.reduce((a, c) => a + c.length, 0) + topics.length; // + qos byte per topic
    const body = new Uint8Array(2 + tailLen);
    body[0] = parts[0];
    body[1] = parts[1];
    let off = 2;
    for (const c of chunks) {
        body.set(c, off);
        off += c.length;
        body[off] = 0; // QoS 0
        off += 1;
    }
    return packet(0x82, body);
}

function publishPacket(topic: string, payload: string): Uint8Array {
    const body = new Uint8Array([...mqttString(topic), ...te.encode(payload)]);
    return packet(0x30, body); // QoS 0
}

const PINGREQ = new Uint8Array([0xc0, 0x00]);
const DISCONNECT = new Uint8Array([0xe0, 0x00]);
// endregion

// region ECDH + AES-GCM (шифрование переговорных payloads)
let ecdhPair: CryptoKey | null = null;
const peerAesCache = new Map<string, CryptoKey>();

export interface Sealed {
    /** iv (base64url) */
    iv: string;
    /** ciphertext (base64url) */
    ct: string;
}

async function getEcdhKey(): Promise<CryptoKey> {
    if (!ecdhPair) {
        // ECDH: для deriveKey нужен ПРИВАТНЫЙ ключ своей пары (+ публичный ключ пира)
        const pair = await crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" },
            true,
            ["deriveKey"]
        );
        ecdhPair = (pair as unknown as CryptoKeyPair).privateKey;
    }
    return ecdhPair;
}

function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4 !== 0) t += "=";
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Свой публичный ключ (base64url raw P-256) — прикладывается к join/offer. */
export async function brokerPublicKey(): Promise<string> {
    const key = await getEcdhKey();
    const raw = await crypto.subtle.exportKey("raw", key);
    return b64url(new Uint8Array(raw));
}

async function deriveAes(peerPubB64: string): Promise<CryptoKey> {
    const cached = peerAesCache.get(peerPubB64);
    if (cached) return cached;
    const peerRaw = unb64url(peerPubB64);
    const peerKey = await crypto.subtle.importKey(
        "raw",
        peerRaw as BufferSource,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
    );
    const myKey = await getEcdhKey();
    const aes = await crypto.subtle.deriveKey(
        { name: "ECDH", public: peerKey as CryptoKey },
        myKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
    if (peerAesCache.size > 50) peerAesCache.clear();
    peerAesCache.set(peerPubB64, aes);
    return aes;
}

/** Зашифровать payload для стороны с публичным ключом peerPubB64. */
export async function brokerSeal(peerPubB64: string, data: unknown): Promise<Sealed> {
    const aes = await deriveAes(peerPubB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = te.encode(JSON.stringify(data ?? null));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aes, plain as BufferSource);
    return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

/** Расшифровать payload, зашифрованный стороной с публичным ключом peerPubB64. */
export async function brokerOpen(peerPubB64: string, sealed: Sealed): Promise<unknown> {
    const aes = await deriveAes(peerPubB64);
    const iv = unb64url(sealed.iv);
    const ct = unb64url(sealed.ct);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, aes, ct as BufferSource);
    return JSON.parse(td.decode(plain));
}
// endregion

// region состояние брокер-клиента
export type BrokerStatus = "off" | "connecting" | "connected" | "failed";

let ws: WebSocket | null = null;
let status: BrokerStatus = "off";
/** последняя причина отказа брокера (для /p2p-doctor) */
let lastError = "—";
let urlIndex = 0;
let reconnectAttempts = 0;
let wsGeneration = 0;
let pingTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let recv: number[] = [];
let lastIdleCheck = 0;

/** Подписки, которые должны существовать (личный ящик + текущий голосовой канал). */
const wantSubs = new Set<string>();
/** Подписки, подтверждённые отправкой SUBSCRIBE в текущей сессии. */
const doneSubs = new Set<string>();

let messageHandler: ((msg: any, topic?: string) => void) | null = null;

export function setBrokerMessageHandler(fn: ((msg: any, topic?: string) => void) | null): void {
    messageHandler = fn;
}

export function brokerStatus(): BrokerStatus {
    return status;
}

export function brokerIsConnected(): boolean {
    return status === "connected" && ws?.readyState === WebSocket.OPEN;
}

/** Текущий брокер (для doctor), без префикса wss:// — коротко. */
export function brokerLabel(): string | null {
    if (!brokerIsConnected() || !currentUrl) return null;
    try {
        return new URL(currentUrl).host;
    } catch {
        return currentUrl;
    }
}

/** Последняя причина отказа брокера (для /p2p-doctor) */
export function brokerLastError(): string {
    return lastError;
}

let currentUrl: string | null = null;

function brokerUrls(): string[] {
    const custom = String(settings.store.brokerUrl ?? "").trim();
    if (custom) return [custom, ...DEFAULT_BROKERS];
    return [...DEFAULT_BROKERS];
}

function nextUrl(): string {
    const list = brokerUrls();
    const url = list[urlIndex % list.length];
    urlIndex++;
    return url;
}

/** Убедиться, что соединение есть (идемпотентно, можно звать на каждый чих). */
export function brokerEnsure(): void {
    lastIdleCheck = Date.now();
    if (brokerIsConnected() || status === "connecting") return;
    void connect();
}

/** WebSocket.send со строгими типами TS (Uint8Array<ArrayBufferLike> не проходит) */
function wsSend(sock: WebSocket, bytes: Uint8Array): void {
    sock.send(bytes.slice().buffer as ArrayBuffer);
}

function connect(): Promise<void> {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    const gen = ++wsGeneration;
    const url = nextUrl();
    const clientId = `p2ps-${randomId(10)}`;
    status = "connecting";
    currentUrl = url;

    return new Promise(resolve => {
        let settled = false;
        let sock: WebSocket;
        try {
            sock = new WebSocket(url);
        } catch (e: any) {
            logger.warn("Не удалось открыть WebSocket:", url, e);
            lastError = e?.message ?? "WebSocket не открылся";
            status = "failed";
            scheduleReconnect();
            resolve();
            return;
        }
        ws = sock;
        sock.binaryType = "arraybuffer";

        const failOver = (why: string) => {
            if (gen !== wsGeneration || settled) return;
            settled = true;
            lastError = why;
            clearTimeout(connackTimer);
            logger.warn(`Брокер ${url} не подошёл (${why}) — пробую следующий`);
            cleanupSocket(sock);
            status = "failed";
            scheduleReconnect();
            resolve();
        };

        // Раньше здесь не было таймаута: если WSS открылся, но CONNACK не пришёл
        // (молчаливый брокер/CSP/фильтр), клиент навсегда зависал в "connecting"
        // и ротации брокеров не происходило.
        const connackTimer = setTimeout(() => failOver(`таймаут ${CONNECT_TIMEOUT_MS / 1000} с (нет CONNACK)`), CONNECT_TIMEOUT_MS);

        sock.onopen = () => {
            if (gen !== wsGeneration) return;
            try {
                wsSend(sock, connectPacket(clientId));
            } catch {
                failOver("send CONNECT");
            }
        };
        sock.onmessage = ev => {
            if (gen !== wsGeneration) return;
            try {
                const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : te.encode(String(ev.data));
                recv.push(...data);
                drainPackets();
            } catch (e) {
                logger.debug("onmessage parse:", e);
            }
        };
        sock.onerror = () => { /* onclose придёт сам */ };
        sock.onclose = () => {
            if (gen !== wsGeneration || settled) return;
            settled = true;
            clearTimeout(connackTimer);
            lastError = "WebSocket закрыт до CONNACK";
            cleanupSocket(sock);
            status = "failed";
            scheduleReconnect();
            resolve();
        };

        function cleanupSocket(s: WebSocket): void {
            try { s.onopen = s.onmessage = s.onerror = s.onclose = null; } catch { /* ignore */ }
            try { s.close(); } catch { /* ignore */ }
            if (ws === s) ws = null;
            doneSubs.clear();
            if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; }
        }

        /** Разбор входящих MQTT-пакетов из аккумулятора recv. */
        function drainPackets(): void {
            for (;;) {
                if (recv.length < 2) return;
                const first = recv[0];
                // remaining length varint
                let len = 0, mul = 1, i = 1, byte = 0;
                do {
                    if (i >= recv.length) return; // ждём ещё байты
                    byte = recv[i++];
                    len += (byte & 0x7f) * mul;
                    mul *= 128;
                    if (mul > 128 * 128 * 128 * 4) { recv = []; return; } // мусор
                } while (byte & 0x80);
                if (recv.length < i + len) return; // пакет ещё не доехал целиком
                const body = recv.splice(0, i + len).slice(i);
                handlePacket(first & 0xf0, body);
            }
        }

        function handlePacket(type: number, body: number[]): void {
            switch (type) {
                case 0x20: { // CONNACK
                    const code = body[1] ?? 5;
                    if (code === 0) {
                        if (settled) return;
                        settled = true;
                        clearTimeout(connackTimer);
                        status = "connected";
                        reconnectAttempts = 0;
                        logger.info(`Сигналинг через брокер ${url}`);
                        startPing();
                        syncSubscriptions();
                        resolve();
                    } else {
                        failOver(`CONNACK ${code}`);
                    }
                    return;
                }
                case 0x30: { // PUBLISH (QoS 0)
                    try {
                        const tLen = (body[0] << 8) | body[1];
                        const topic = td.decode(new Uint8Array(body.slice(2, 2 + tLen)));
                        const payload = td.decode(new Uint8Array(body.slice(2 + tLen)));
                        const msg = JSON.parse(payload);
                        void messageHandler?.(msg, topic);
                    } catch (e) {
                        logger.debug("Не удалось разобрать PUBLISH:", e);
                    }
                    return;
                }
                default:
                    return; // PINGRESP (0xD0) и прочее игнорируем
            }
        }

        function startPing(): void {
            if (pingTimer) clearInterval(pingTimer);
            pingTimer = setInterval(() => {
                try { wsSend(sock, PINGREQ); } catch { /* onclose разберётся */ }
            }, PING_MS);
        }
    });
}

function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectAttempts++;
    if (reconnectAttempts > COOLDOWN_AFTER_ATTEMPTS) {
        // мёртвые брокеры не долбим: длинная пауза, чат-фолбэк тем временем работает
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (wantSubs.size > 0 || needKeepAlive()) void connect();
        }, COOLDOWN_MS);
        return;
    }
    // каждые 2 попытки переключаемся на следующий брокер (urlIndex уже крутится в connect)
    const delay = Math.min(RECONNECT_BASE_MS * reconnectAttempts, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (wantSubs.size > 0 || needKeepAlive()) void connect();
        else status = "off";
    }, delay);
}

function needKeepAlive(): boolean {
    // внешние потребители зовут brokerEnsure() при голосе/эфире/просмотре —
    // reconnect продолжается, пока есть подписки или недавняя активность
    return Date.now() - lastIdleCheck < IDLE_DISCONNECT_MS;
}

/** Отправить/убрать подписки до актуального wantSubs. */
function syncSubscriptions(): void {
    if (!brokerIsConnected()) return;
    const todo = [...wantSubs].filter(t => !doneSubs.has(t));
    if (todo.length) {
        try { wsSend(ws!, subscribePacket(todo)); } catch { /* ignore */ }
        todo.forEach(t => doneSubs.add(t));
    }
    for (const t of [...doneSubs]) {
        if (!wantSubs.has(t)) {
            doneSubs.delete(t);
            // отписка не критична: MQTT-сессия clean, при переподключении set пересоберётся
        }
    }
}

/** Личный ящик — подписан всегда, пока брокер подключён. */
export function brokerInboxTopic(): string {
    return `${TOPIC_PREFIX}/u/${myId() || "anon"}`;
}

/** Топик голосового канала — подписан, пока сидим в голосе. */
export function brokerChannelTopic(channelId: string): string {
    return `${TOPIC_PREFIX}/c/${channelId}`;
}

/** Обновить набор нужных подписок (зовёт engine при смене голосового канала). */
export function brokerSetChannel(channelId: string | null): void {
    wantSubs.add(brokerInboxTopic());
    for (const t of [...wantSubs]) {
        if (t.startsWith(`${TOPIC_PREFIX}/c/`)) wantSubs.delete(t);
    }
    if (channelId) wantSubs.add(brokerChannelTopic(channelId));
    if (wantSubs.size > 0) brokerEnsure();
    syncSubscriptions();
}

/** Опубликовать JSON в топик. false — брокер не подключён (нужен фолбэк). */
export function brokerPublish(topic: string, data: unknown): boolean {
    brokerEnsure();
    if (!brokerIsConnected()) return false;
    try {
        wsSend(ws!, publishPacket(topic, JSON.stringify(data)));
        return true;
    } catch (e) {
        logger.debug("brokerPublish:", e);
        return false;
    }
}

/** Подождать подключения до ms мс (чтобы первый announce не ушёл в чат зря). */
export function brokerWaitConnected(ms: number): Promise<boolean> {
    brokerEnsure();
    if (brokerIsConnected()) return Promise.resolve(true);
    return new Promise(resolve => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            if (brokerIsConnected()) {
                clearInterval(timer);
                resolve(true);
            } else if (Date.now() - t0 > ms) {
                clearInterval(timer);
                resolve(false);
            }
        }, 120);
    });
}

/** Вызывается из движка по таймеру: отключаемся, если брокер никому не нужен. */
export function brokerIdleCheck(active: boolean): void {
    lastIdleCheck = Date.now();
    if (active) {
        brokerEnsure();
        return;
    }
    if (!brokerIsConnected()) return;
    // лично проверяем: если голоса/эфира/просмотров нет долго — закрываем
    if (wantSubs.size <= 1) { // только личный ящик
        // остаёмся на личном ящике — чтобы входящие join не терялись; соединение дешёвое
    }
}

export function brokerShutdown(): void {
    wsGeneration++;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; }
    try { wsSend(ws!, DISCONNECT); } catch { /* ignore */ }
    try { ws?.close(); } catch { /* ignore */ }
    ws = null;
    wantSubs.clear();
    doneSubs.clear();
    recv = [];
    status = "off";
    peerAesCache.clear();
    logger.info("Сигналинг через брокер остановлен");
}
// endregion
