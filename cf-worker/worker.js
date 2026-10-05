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
 *      (при первом деплое Cloudflare сама предложит миграцию — согласиться)
 *   4. В настройках P2PStream:
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
    }

    async fetch(request) {
        const pair = new WebSocketPair();
        const server = pair[1];
        this.state.acceptWebSocket(server);
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
            case 0x10: { // CONNECT -> CONNACK (session present = 0, rc = 0)
                this.send(ws, new Uint8Array([0x20, 0x02, 0x00, 0x00]));
                return;
            }
            case 0x82: { // SUBSCRIBE -> SUBACK (QoS 0 для каждого фильтра)
                if (body.length < 4) return;
                const topics = this.clients.get(ws) ?? new Set();
                const filters = parseSubscribeTopics(body);
                for (const f of filters) topics.add(f);
                const ack = new Uint8Array(2 + filters.length);
                ack[0] = 0x90;
                ack[1] = filters.length;
                for (let k = 0; k < filters.length; k++) ack[2 + k] = 0;
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
                            const out = new Uint8Array(1 + 2 + tLen + payload.length);
                            out[0] = 0x30;
                            out[1] = (2 + tLen + payload.length) & 0xff; // payload << 120KB не бывает
                            out[2] = (tLen >> 8) & 0xff;
                            out[3] = tLen & 0xff;
                            out.set(body.subarray(2, 2 + tLen), 4);
                            out.set(payload, 4 + tLen);
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

/** Совпадение фильтра с топиком: точное имя или '+' на уровне одного сегмента */
function topicMatches(filter, topic) {
    if (filter === topic) return true;
    if (!filter.includes("+")) return false;
    const f = filter.split("/");
    const t = topic.split("/");
    if (f.length !== t.length) return false;
    for (let i = 0; i < f.length; i++) {
        if (f[i] !== "+" && f[i] !== t[i]) return false;
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
