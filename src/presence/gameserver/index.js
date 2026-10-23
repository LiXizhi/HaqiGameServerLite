// WebSocket process. It registers with the gateway and applies open, notice, migrate, and close.

import {createHost} from './instance.js';
import {LIMITS, loadRoomCatalog} from '../protocol.js';
import {startSocketServer} from '../socket.js';

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.ok === false) throw new Error(data.error || `gateway ${response.status}`);
    return data;
}

export async function startGameServer({
    host = '127.0.0.1',
    port = 0,
    machineId = 'local-1',
    gatewayUrl,
    catalog = loadRoomCatalog(),
    limits = LIMITS,
    now = () => Date.now(),
    auth = null,
    analytics = null,
} = {}) {
    if (!gatewayUrl) throw new Error('gatewayUrl is required');
    const sim = createHost({catalog, limits, machineId});
    let advertiseUrl = '';
    const sockets = await startSocketServer({
        host,
        port,
        maxConnections: limits.serverMax,
        maxMessageBytes: limits.maxMessageBytes,
        relayDropBytes: limits.relayDropBytes,
        outboundCloseBytes: limits.outboundCloseBytes,
        inboundPerSecond: limits.inboundPerSecond,
        idleMs: limits.idleMs,
        onHealth() {
            return {machineId, url: advertiseUrl, ...sim.stats()};
        },
        onConnection(socket) {
            let primed = false;
            let identity = null;
            let authenticating = false;
            let sessionTimer;
            let releaseSession;
            let admitted = false;
            let privatePeer = null;
            const sink = {
                send(message) {
                    if (socket.readyState === 1) {
                        if (message.type === 'welcome') releaseSession?.activate?.();
                        socket.send(JSON.stringify(message));
                        if (message.type === 'welcome') admitted = true;
                        if (message.type === 'welcome') analytics?.enter(socket, identity);
                    }
                },
                sendFrame(frame) {
                    if (socket.readyState !== 1) return false;
                    return socket.sendFrame(frame);
                },
                close() {
                    socket.close();
                },
            };
            socket.on('message', async data => {
                if (auth && authenticating) return;
                if (auth) authenticating = true;
                if (!primed) {
                    primed = true;
                    try {
                        await flush();
                    } catch {
                        // A missed heartbeat still lets the hello proceed if the instance is already open.
                    }
                }
                let message;
                if (socket.readyState !== 1) { authenticating = false; return; }
                try {
                    message = JSON.parse(data.toString());
                    if (!message || typeof message.type !== 'string') throw new Error('message');
                } catch {
                    sink.send({type: 'reject', reason: 'message'});
                    authenticating = false;
                    return;
                }
                if (auth) {
                    try {
                        if (message.type === 'hello') {
                            if (identity) throw new Error('already-connected');
                            identity = auth.consume(message.ticket, message);
                            releaseSession = auth.openSession(identity, () => {
                                sink.send({type: 'reject', reason: 'replaced'});
                                sim.disconnect(sink, 'replaced');
                                socket.close();
                            });
                            // Reconnect periodically to revalidate the upstream account.
                            sessionTimer = setTimeout(() => socket.close(), 60 * 60 * 1000);
                            sessionTimer.unref?.();
                        } else if (!identity) throw new Error('auth-required');
                        if (message.type === 'enterRoom' && !message.roomId?.startsWith(`${identity.project}:`)) throw new Error('room');
                    } catch (error) {
                        sink.send({type: 'reject', reason: error.message === 'account-connection-limit'
                            ? 'account-connection-limit' : 'auth-required'});
                        socket.close();
                        authenticating = false;
                        return;
                    }
                }
                if (!auth && (message.roomType === 'account' || message.roomId === 'account' || message.roomId?.startsWith('account:'))) {
                    sink.send({type: 'reject', reason: 'auth-required'}); socket.close(); return;
                }
                if (identity?.roomType === 'account') {
                    try {
                        if (message.type === 'hello') privatePeer = auth.privateRooms.connect(identity, sink);
                        else if (!privatePeer) throw Error('private-room-forbidden');
                        else privatePeer.handle(message);
                    } catch (error) {
                        sink.send({type: 'reject', reason: error.message, requestId: message.requestId});
                        if (message.type === 'hello' || message.type === 'enterRoom') socket.close();
                    }
                } else sim.handle(sink, message, now());
                // Invalid room/position/full instance must not retain a reserved
                // account slot after a failed initial hello.
                if (auth && message.type === 'hello' && !admitted) socket.close();
                authenticating = false;
            });
            socket.on('close', () => { privatePeer?.close(); releaseSession?.(); analytics?.leave(socket); clearTimeout(sessionTimer); sim.disconnect(sink); });
        },
    });
    const addressPort = sockets.port;
    advertiseUrl = `ws://${host}:${addressPort}`;
    let closed = false;
    let flushing = null;

    function flush() {
        if (flushing) return flushing;
        flushing = postJson(`${gatewayUrl}/api/heartbeat`, sim.report(advertiseUrl))
            .then(result => {
                sim.apply(result.commands || []);
                return result;
            })
            .finally(() => {
                flushing = null;
            });
        return flushing;
    }

    await postJson(`${gatewayUrl}/api/register`, {machineId, advertiseUrl});
    await flush();

    const heartbeatTimer = setInterval(() => {
        if (!closed) flush().catch(() => {});
    }, 5000);
    const relayTimer = setInterval(() => {
        if (!closed) sim.relay(now());
    }, 1000);
    const expireTimer = setInterval(() => {
        if (!closed) sim.expire(now());
    }, 5000);

    return {
        port: addressPort,
        url: advertiseUrl,
        machineId,
        flush,
        relayNow() {
            sim.relay(now());
        },
        close() {
            closed = true;
            clearInterval(heartbeatTimer);
            clearInterval(relayTimer);
            clearInterval(expireTimer);
            return new Promise(resolve => sockets.close().then(resolve));
        },
    };
}
