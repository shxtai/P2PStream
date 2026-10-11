// Тест MQTT-брокера P2PStream на Cloudflare Workers (Node 22+, global WebSocket)
const URL = process.argv[2] || "wss://shrill-shape-9a12.kosyakmilya.workers.dev/mqtt";
const TOPIC = "p2p/v1/doctor-test";

function encRemaining(len) {
    const out = [];
    do { let b = len % 128; len = Math.floor(len / 128); if (len > 0) b |= 0x80; out.push(b); } while (len > 0);
    return out;
}
function encStr(s) {
    const b = Buffer.from(s, "utf8");
    return [b.length >> 8, b.length & 255, ...b];
}

function connectPacket(clientId) {
    const vh = [...encStr("MQTT"), 4, 0x02, ...encStr(60)]; // MQTT 3.1.1, clean session, keepalive 60
    const payload = [...encStr(clientId)];
    const body = [...vh, ...payload];
    return Buffer.from([0x10, ...encRemaining(body.length), ...body]);
}
function subscribePacket(pid, topic) {
    const body = [...encStr(pid >> 8), pid & 255, ...encStr(topic), 0];
    return Buffer.from([0x82, ...encRemaining(body.length), ...body]);
}
function publishPacket(topic, msg) {
    const body = [...encStr(topic), ...encStr(msg)];
    return Buffer.from([0x30, ...encRemaining(body.length), ...body]); // QoS0
}
function pingreq() { return Buffer.from([0xc0, 0x00]); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

await new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.binaryType = "arraybuffer";
    let buf = Buffer.alloc(0);
    let stage = 0;
    const t0 = Date.now();
    const failTimer = setTimeout(() => { log("FAIL: таймаут 15 с, стадия", stage); try { ws.close(); } catch {} reject(new Error("timeout")); }, 15000);

    ws.onopen = () => {
        log("WSS открыт за", Date.now() - t0, "мс →", URL);
        ws.send(connectPacket("p2pdoc-" + Math.random().toString(36).slice(2, 8)));
        log("→ CONNECT отправлен");
    };
    ws.onmessage = ev => {
        const chunk = Buffer.from(ev.data);
        buf = Buffer.concat([buf, chunk]);
        // разбор пакетов
        while (buf.length >= 2) {
            const type = buf[0] >> 4;
            let remLen = 0, mult = 1, pos = 1, byte;
            do {
                if (pos >= buf.length) return;
                byte = buf[pos++];
                remLen += (byte & 127) * mult;
                mult *= 128;
            } while (byte & 0x80);
            if (buf.length < pos + remLen) return;
            const body = buf.subarray(pos, pos + remLen);
            buf = buf.subarray(pos + remLen);

            if (type === 2) { // CONNACK
                const rc = body[1];
                log("← CONNACK, return code =", rc, rc === 0 ? "(OK)" : "(ОТКАЗ)");
                if (rc !== 0) { clearTimeout(failTimer); reject(new Error("CONNACK rc=" + rc)); return; }
                ws.send(subscribePacket(1, TOPIC));
                log("→ SUBSCRIBE", TOPIC);
            } else if (type === 9) {
                log("← SUBACK ok");
                const msg = "doctor-ping-" + Date.now();
                ws.send(publishPacket(TOPIC, msg));
                log("→ PUBLISH:", msg);
            } else if (type === 3) { // PUBLISH QoS0
                // тело: topic(2б) + payload
                const tl = (body[0] << 8) | body[1];
                const topic = body.subarray(2, 2 + tl).toString("utf8");
                const payload = body.subarray(2 + tl).toString("utf8");
                log("← PUBLISH topic=", topic, "payload=", payload);
                if (topic === TOPIC && payload.startsWith("doctor-ping-")) {
                    log("РАУНДТРИП OK — брокер полностью работоспособен");
                    clearTimeout(failTimer);
                    ws.send(pingreq());
                    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 500);
                    return;
                }
            } else if (type === 13) {
                log("← PINGRESP");
            } else {
                log("← пакет type=", type);
            }
        }
    };
    ws.onerror = e => { clearTimeout(failTimer); log("WSS ошибка:", e.message ?? e); reject(new Error("ws error")); };
    ws.onclose = e => log("WSS закрыт, code=", e.code);
});
