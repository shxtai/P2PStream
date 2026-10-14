/**
 * P2PStream signaling broker — MQTT 3.1.1 subset on Cloudflare Workers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ЗАЧЕМ: публичные MQTT-брокеры у части сетей режутся DPI (WSS открывается,
 * CONNECT молча дропается). Сигналинг P2PStream можно перенести на СОБСТВЕННЫЙ
 * брокер здесь — в Discord не пишется ничего вообще, динамический IP не важен
 * (статический адрес *.<account>.workers.dev), бесплатного тарифа хватает.
 *
 * РЕАЛИЗОВАНО (ровно то, что использует клиент P2PStream):
 *   - CONNECT / CONNACK (без аутентификации, clientId не проверяется)
 *   - SUBSCRIBE / SUBACK (QoS 0, точные топики; '+' на уровне одного сегмента)
 *   - PUBLISH QoS 0 (fanout всем подписчикам с совпавшим фильтром)
 *   - PINGREQ / PINGRESP, DISCONNECT
 * Сессии в памяти Durable Object — подписки живут, пока жив WebSocket.
 *
 * ДЕПЛОЙ (2 минуты, без консоли):
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker -> Deploy
 *      (имя любое, например p2ps-broker)
 *   2. Edit code -> вставить содержимое этого файла -> Deploy
 *   3. Settings -> Bindings -> Add -> Durable Object Namespace:
 *      class name = Broker,  namespace name = BROKER
 *      (при первом деплое Cloudflare сама предложит миграцию — согласиться;
 *       БЕЗ биндинга сокет откроется, но CONNACK никогда не придёт)
 *   4. ПРОВЕРКА (у себя, Node 22+):
 *        node cf-worker/test-mqtt.mjs wss://<имя>.<аккаунт>.workers.dev/mqtt
 *      Должно напечатать «РАУНДТРИП OK». «нет CONNACK» = деплой старый
 *      или биндинг не добавлен — повтори шаги 2-3.
 *   5. В настройках P2PStream:
 *        брокер = включён
 *        адрес  = wss://p2ps-broker.<твой-аккаунт>.workers.dev/mqtt
 *      и у друга то же самое. Готово — сигналинг больше не пишется в Discord.
 */

// ---------------------------------------------------------------------------
// Durable Object: единственный инстанс "broker", держит все WebSockets
// ---------------------------------------------------------------------------

export class Broker {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        /** ws -> Set<topicFilter> */
        this.clients = new Map();
        /** ws -> channelId (голосовой канал Discord) для фильтрации анонсов */
        this.voiceChannels = new Map();
        /** ws -> Discord userId (из username в CONNECT) */
        this.discordUsers = new Map();
        /** простой logger */
        this.logger = {
            info: (msg) => console.log(`[p2ps-broker] ${msg}`),
            warn: (msg) => console.warn(`[p2ps-broker] ${msg}`),
            error: (msg) => console.error(`[p2ps-broker] ${msg}`)
        };
    }

    async fetch(request) {
        const pair = new WebSocketPair();
        const server = pair[1];
        // Обычный accept(): обработчики ниже — addEventListener. Раньше был
        // state.acceptWebSocket() (Hibernation API): с ним события приходят ТОЛЬКО
        // в методы webSocketMessage/webSocketClose, и брокер не видел ни одного пакета.
        server.accept();
        this.clients.set(server, new Set());

        server.addEventListener("message", ev => {
            try {
                const bytes = new Uint8Array(ev.data);
                this.handleBytes(server, bytes);
            } catch {
                try { server.close(); } catch { /* ignore */ }
            }
        });

        const close = () => this.clients.delete(server);
        server.addEventListener("close", close);
        server.addEventListener("error", close);

        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    handleBytes(ws, bytes) {
        // пакеты могут слипаться — разбираем цикл по remaining length
        let i = 0;
        while (i < bytes.length) {
            const first = bytes[i];
            let len = 0, mul = 1, p = i + 1, byte = 0;
            do {
                if (p >= bytes.length) return; // ждём остальные байты (маленькие пакеты, реально не встречается)
                byte = bytes[p++];
                len += (byte & 0x7f) * mul;
                mul *= 128;
            } while (byte & 0x80);
            if (p + len > bytes.length) return;
            const body = bytes.subarray(p, p + len);
            this.handlePacket(ws, first & 0xf0, body);
            i = p + len;
        }
    }

    handlePacket(ws, type, body) {
        switch (type) {
            case 0x10: { // CONNECT -> CONNACK (session present = 0, rc = 0 or 5)
                // Проверяем, что brokerSecret задан в wrangler env
                const secret = this.env.BROKER_SECRET;
                if (!secret) {
                    this.logger.warn("BROKER_SECRET не задан в env — аутентификация отключена");
                    this.send(ws, new Uint8Array([0x20, 0x02, 0x00, 0x00]));
                    return;
                }
                // Парсим CONNECT payload: clientId + username/password
                if (body.length < 10) return; // минимальный CONNECT: clientId >= 1 байт, flags=1, keepalive=2
                const flags = body[3];
                const hasUsername = (flags & 0x80) !== 0;
                const hasPassword = (flags & 0x40) !== 0;
                let p = 6; // после MQTT, level, flags, keepalive
                // clientId (переменная длина)
                const clientIdLen = body[p++];
                if (p + clientIdLen > body.length) return;
                const clientId = new TextDecoder().decode(body.subarray(p, p + clientIdLen));
                p += clientIdLen;
                // username (если есть)
                let username = "";
                if (hasUsername) {
                    const usernameLen = body[p++];
                    if (p + usernameLen > body.length) return;
                    username = new TextDecoder().decode(body.subarray(p, p + usernameLen));
                    p += usernameLen;
                }
                // password (если есть)
                let password = "";
                if (hasPassword) {
                    const passwordLen = body[p++];
                    if (p + passwordLen > body.length) return;
                    password = new TextDecoder().decode(body.subarray(p, p + passwordLen));
                }
                // Проверяем пароль: должен совпадать с BROKER_SECRET
                if (password !== secret) {
                    this.logger.warn(`Неверный пароль для клиента ${clientId}: ${password}`);
                    this.send(ws, new Uint8Array([0x20, 0x02, 0x05, 0x00])); // CONNACK rc=5 (not authorized)
                    return;
                }
                // clientId = DiscordUserId:ChannelId (если есть channelId)
                const [userId, channelId] = clientId.split(':');
                this.discordUsers.set(ws, userId);
                if (channelId) this.voiceChannels.set(ws, channelId);
                this.logger.info(`Клиент ${clientId} подключился успешно (user=${userId}, channel=${channelId || 'none'})`);
                this.send(ws, new Uint8Array([0x20, 0x02, 0x00, 0x00])); // CONNACK rc=0 (accepted)
                return;
            }
            // тип = старшие 4 бита: SUBSCRIBE (0x82 на проводе) приходит сюда как 0x80.
            // Раньше было case 0x82 — подписки не регистрировались никогда.
            case 0x80: { // SUBSCRIBE -> SUBACK (QoS 0 для каждого фильтра)
                if (body.length < 4) return;
                const topics = this.clients.get(ws) ?? new Set();
                const filters = parseSubscribeTopics(body);
                for (const f of filters) topics.add(f);
                // SUBACK: packet id (2 байта, как в SUBSCRIBE) + код на каждый фильтр
                const ack = new Uint8Array(4 + filters.length);
                ack[0] = 0x90;
                ack[1] = 2 + filters.length;
                ack[2] = body[0];
                ack[3] = body[1];
                for (let k = 0; k < filters.length; k++) ack[4 + k] = 0;
                this.send(ws, ack);
                return;
            }
            case 0xc0: { // PINGREQ -> PINGRESP
                this.send(ws, new Uint8Array([0xd0, 0x00]));
                return;
            }
            case 0xe0: { // DISCONNECT
                try { ws.close(); } catch { /* ignore */ }
                return;
            }
            case 0x30: { // PUBLISH QoS 0 -> fanout
                if (body.length < 2) return;
                const tLen = (body[0] << 8) | body[1];
                if (2 + tLen > body.length) return;
                const topic = new TextDecoder().decode(body.subarray(2, 2 + tLen));
                const payload = body.subarray(2 + tLen);
                for (const [client, filters] of this.clients) {
                    if (client === ws) continue; // себе эхо не нужно (клиент сам фильтрует from)
                    if (client.readyState !== 1) continue; // OPEN
                    for (const f of filters) {
                        if (topicMatches(f, topic)) {
                            // remaining length — varint (раньше 1 байт: любой пакет
                            // длиннее 127 байт, т.е. каждый offer/answer, приходил битым)
                            const head = varint(2 + tLen + payload.length);
                            const out = new Uint8Array(1 + head.length + 2 + tLen + payload.length);
                            out[0] = 0x30;
                            out.set(head, 1);
                            let o = 1 + head.length;
                            out[o++] = (tLen >> 8) & 0xff;
                            out[o++] = tLen & 0xff;
                            out.set(body.subarray(2, 2 + tLen), o);
                            out.set(payload, o + tLen);
                            this.send(client, out);
                            break;
                        }
                    }
                }
                return;
            }
            default:
                return;
        }
    }

    send(ws, bytes) {
        try { ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// MQTT-помощники
// ---------------------------------------------------------------------------

/** MQTT remaining length (variable byte integer) */
function varint(len) {
    const out = [];
    do {
        let d = len % 128;
        len = Math.floor(len / 128);
        if (len > 0) d |= 0x80;
        out.push(d);
    } while (len > 0);
    return out;
}

/** Вытащить фильтры топиков из SUBSCRIBE (пропуская packet id) */
function parseSubscribeTopics(body) {
    const td = new TextDecoder();
    const topics = [];
    let p = 2; // packet id
    while (p + 2 <= body.length) {
        const tLen = (body[p] << 8) | body[p + 1];
        p += 2;
        if (p + tLen + 1 > body.length) break;
        topics.push(td.decode(body.subarray(p, p + tLen)));
        p += tLen + 1; // +1 QoS byte
    }
    return topics;
}

/** Совпадение фильтра с топиком: ТОЛЬКО точное имя.
 *  Wildcard '+' разрешён ТОЛЬКО в последнем сегменте личного ящика (p2ps/v1/u/+),
 *  чтобы клиент мог подписаться на свой ящик независимо от userId.
 *  Wildcard '*' (произвольное число сегментов) запрещён. */
function topicMatches(filter, topic) {
    if (filter === topic) return true;
    // запретить '*' — слишком широкий (p2ps/# поймает всё)
    if (filter.includes('*')) return false;
    // разрешить '+' только в последнем сегменте личного ящика
    const fParts = filter.split('/');
    if (fParts.length < 4 || fParts[fParts.length - 1] !== '+') return false;
    // фильтр типа p2ps/v1/u/+ — разрешить
    const tParts = topic.split('/');
    if (fParts.length !== tParts.length) return false;
    for (let i = 0; i < fParts.length - 1; i++) {
        if (fParts[i] !== tParts[i]) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
    async fetch(request, env) {
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
            const id = env.BROKER.idFromName("global");
            const stub = env.BROKER.get(id);
            return stub.fetch(request);
        }
        // health-check для проверки деплоя из браузера
        return new Response("P2PStream signaling broker is running. Connect with MQTT over WSS at /mqtt\n", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" }
        });
    }
};
