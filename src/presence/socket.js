// WebSocket server for presence text frames. One process is sized for serverMax connections.

import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {LIMITS} from './protocol.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.allocUnsafe(2);
        header[1] = length;
    } else if (length < 65536) {
        header = Buffer.allocUnsafe(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, payload]);
}

export function encodeTextFrame(text) {
    return encodeFrame(0x1, Buffer.from(String(text)));
}

function readFrame(buffer, maxMessage) {
    if (buffer.length < 2) return null;
    const opcode = buffer[0] & 0x0f;
    const fin = (buffer[0] & 0x80) !== 0;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
        if (buffer.length < 4) return null;
        length = buffer.readUInt16BE(2);
        offset = 4;
    } else if (length === 127) {
        if (buffer.length < 10) return null;
        const wide = buffer.readBigUInt64BE(2);
        if (wide > BigInt(maxMessage)) return {error: true};
        length = Number(wide);
        offset = 10;
    }
    if (length > maxMessage) return {error: true};
    if (!masked) return {error: true};
    if (buffer.length < offset + 4 + length) return null;
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    const mask = buffer.subarray(offset, offset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    const rest = buffer.subarray(offset + 4 + length);
    return {
        frame: {opcode, fin, payload},
        rest: rest.length === 0 ? Buffer.alloc(0) : rest,
    };
}

function createConnection(socket, onFinished, options) {
    const listeners = {message: new Set(), close: new Set()};
    let buffer = Buffer.alloc(0);
    let fragments = [];
    let fragmentBytes = 0;
    let finished = false;
    let messagesThisSecond = 0;
    let windowStarted = Date.now();
    socket.setNoDelay(true);
    socket.setTimeout(options.idleMs);
    const connection = {
        readyState: 1,
        get bufferedAmount() {
            return socket.writableLength;
        },
        send(text) {
            if (finished) return false;
            if (socket.writableLength > options.outboundCloseBytes) {
                connection.close();
                return false;
            }
            socket.write(encodeTextFrame(text));
            return true;
        },
        sendFrame(frame) {
            if (finished) return false;
            // Bound the queue including this frame, before handing it to TCP.
            // write(false) means queued with backpressure, not a dropped frame.
            if (socket.writableLength + frame.length > options.relayDropBytes) return false;
            socket.write(frame);
            return true;
        },
        close() {
            if (finished) return;
            try {
                socket.write(encodeFrame(0x8, Buffer.alloc(0)));
            } catch {
                // The peer may already be gone.
            }
            socket.end();
            finish();
        },
        on(event, handler) {
            listeners[event]?.add(handler);
        },
    };
    function finish() {
        if (finished) return;
        finished = true;
        connection.readyState = 3;
        buffer = Buffer.alloc(0);
        fragments = [];
        onFinished();
        for (const handler of listeners.close) handler();
    }
    socket.on('timeout', () => connection.close());
    socket.on('data', chunk => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        if (buffer.length > options.maxMessageBytes * 4) {
            connection.close();
            return;
        }
        while (!finished) {
            const parsed = readFrame(buffer, options.maxMessageBytes);
            if (!parsed) return;
            if (parsed.error) {
                connection.close();
                return;
            }
            buffer = parsed.rest;
            const {opcode, fin, payload} = parsed.frame;
            if (opcode === 0x8) {
                connection.close();
                return;
            }
            if (opcode === 0x9) {
                if (!finished && socket.writableLength <= options.outboundCloseBytes) socket.write(encodeFrame(0xA, payload));
                continue;
            }
            if (opcode === 0xA) continue;
            if (opcode !== 0x1 && opcode !== 0x0) {
                connection.close();
                return;
            }
            fragmentBytes += payload.length;
            if (fragmentBytes > options.maxMessageBytes) {
                connection.close();
                return;
            }
            fragments.push(payload);
            if (!fin) continue;
            const now = Date.now();
            if (now - windowStarted >= 1000) {
                windowStarted = now;
                messagesThisSecond = 0;
            }
            messagesThisSecond += 1;
            if (messagesThisSecond > options.inboundPerSecond) {
                connection.close();
                return;
            }
            const text = fragments.length === 1 ? fragments[0].toString('utf8') : Buffer.concat(fragments).toString('utf8');
            fragments = [];
            fragmentBytes = 0;
            for (const handler of listeners.message) handler(text);
        }
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
    return connection;
}

export function startSocketServer({
    host = '127.0.0.1',
    port = 0,
    maxConnections = LIMITS.serverMax,
    maxMessageBytes = LIMITS.maxMessageBytes,
    relayDropBytes = LIMITS.relayDropBytes,
    outboundCloseBytes = LIMITS.outboundCloseBytes,
    inboundPerSecond = LIMITS.inboundPerSecond,
    idleMs = LIMITS.idleMs,
    onHealth,
    onConnection,
} = {}) {
    const peers = new Set();
    const options = {maxMessageBytes, relayDropBytes, outboundCloseBytes, inboundPerSecond, idleMs};
    const httpServer = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/health') {
            const body = JSON.stringify({ok: true, connections: peers.size, ...(onHealth?.() || {})});
            response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(body),
            });
            response.end(body);
            return;
        }
        response.writeHead(426, {'content-type': 'text/plain; charset=utf-8'});
        response.end('需要 WebSocket');
    });
    httpServer.on('upgrade', (request, socket) => {
        const key = request.headers['sec-websocket-key'];
        const version = request.headers['sec-websocket-version'];
        socket.on('error', () => socket.destroy());
        if (!key || version !== '13' || peers.size >= maxConnections) {
            const status = !key || version !== '13' ? 400 : 503;
            socket.end(`HTTP/1.1 ${status} ${status === 400 ? 'Bad Request' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            return;
        }
        const accept = createHash('sha1').update(String(key) + GUID).digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        peers.add(socket);
        onConnection(createConnection(socket, () => peers.delete(socket), options));
    });
    return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen({port, host, backlog: 8192}, () => {
            const address = httpServer.address();
            resolve({
                port: address.port,
                connections: () => peers.size,
                close() {
                    for (const peer of peers) peer.destroy();
                    return new Promise(done => httpServer.close(() => done()));
                },
            });
        });
    });
}
