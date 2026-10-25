/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Super Z
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * (1.23.23) Прямая доставка нативного звука: main-процесс отдаёт PCM по локальному
 * WebSocket (127.0.0.1, случайный порт и токен), его принимает Worker рендерера и
 * сразу передаёт в AudioWorklet. Главный поток окна Discord в пути больше не
 * участвует — раньше звук забирался таймером в нём, и каждое его зависание на
 * 250+ мс давало провал («провалов доставки 12» за минуту в логе 1.23.22).
 * Только node-модули: файл бандлится в main-процесс.
 */

import { createHash, randomBytes } from "crypto";
import { createServer, type IncomingMessage, type Server } from "http";
import type { Socket } from "net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** клиент не успевает забирать (> ~2.5 с звука в очереди сокета) — пропускаем куски */
const MAX_BACKLOG_BYTES = 1_000_000;

/** Бинарный WebSocket-кадр сервер → клиент (без маски, FIN). */
export function wsBinaryFrame(payload: Buffer): Buffer {
    const n = payload.length;
    let head: Buffer;
    if (n < 126) {
        head = Buffer.from([0x82, n]);
    } else if (n < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x82;
        head[1] = 126;
        head.writeUInt16BE(n, 2);
    } else {
        head = Buffer.alloc(10);
        head[0] = 0x82;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(n), 2);
    }
    return Buffer.concat([head, payload]);
}

export class AudioWsServer {
    readonly token = randomBytes(16).toString("hex");
    private server: Server | null = null;
    private port = 0;
    private starting: Promise<number> | null = null;
    private clients = new Set<Socket>();
    /** неполный стерео-кадр с прошлого куска */
    private tail: Buffer = Buffer.alloc(0);

    get connected(): boolean {
        return this.clients.size > 0;
    }

    start(): Promise<number> {
        if (this.port) return Promise.resolve(this.port);
        this.starting ??= new Promise<number>((resolve, reject) => {
            const server = createServer((_req, res) => {
                res.writeHead(404);
                res.end();
            });
            server.on("upgrade", (req: IncomingMessage, sock: Socket) => this.onUpgrade(req, sock));
            server.once("error", e => {
                this.starting = null;
                reject(e);
            });
            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                this.server = server;
                this.port = typeof addr === "object" && addr ? addr.port : 0;
                resolve(this.port);
            });
        });
        return this.starting;
    }

    private onUpgrade(req: IncomingMessage, sock: Socket): void {
        const key = req.headers["sec-websocket-key"];
        if (req.url !== "/" + this.token || typeof key !== "string") {
            sock.destroy();
            return;
        }
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        sock.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
        );
        sock.setNoDelay(true);
        this.clients.add(sock);
        const drop = () => {
            this.clients.delete(sock);
        };
        sock.on("close", drop);
        sock.on("error", drop);
        // от клиента нужен только close-кадр (opcode 0x8); остальное игнорируем
        sock.on("data", (d: Buffer) => {
            if (d.length && (d[0] & 0x0f) === 0x8) {
                drop();
                try { sock.end(); } catch { /* ignore */ }
            }
        });
    }

    /** Отдать кусок PCM подключённым клиентам. false — клиентов нет (пусть идёт в очередь опроса). */
    send(chunk: Buffer, frameBytes: number): boolean {
        if (!this.clients.size) {
            this.tail = Buffer.alloc(0);
            return false;
        }
        const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
        const whole = buf.length - (buf.length % frameBytes);
        this.tail = whole < buf.length ? Buffer.from(buf.subarray(whole)) : Buffer.alloc(0);
        if (!whole) return true;
        const frame = wsBinaryFrame(buf.subarray(0, whole));
        for (const s of this.clients) {
            if (s.writableLength > MAX_BACKLOG_BYTES) continue;
            try { s.write(frame); } catch { /* ignore */ }
        }
        return true;
    }

    resetTail(): void {
        this.tail = Buffer.alloc(0);
    }

    close(): void {
        for (const s of this.clients) try { s.destroy(); } catch { /* ignore */ }
        this.clients.clear();
        try { this.server?.close(); } catch { /* ignore */ }
        this.server = null;
        this.port = 0;
        this.starting = null;
    }
}
