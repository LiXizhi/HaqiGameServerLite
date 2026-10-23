// One game-server process must carry 8000 players: 16 instances of 500.
// Clustered rooms share one encoded frame. Spread rooms search only nearby cells.

import assert from 'node:assert/strict';
import net from 'node:net';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {createHost} from '../src/presence/gameserver/instance.js';
import {LIMITS, loadRoomCatalog} from '../src/presence/protocol.js';
import {encodeTextFrame, startSocketServer} from '../src/presence/socket.js';

const catalog = loadRoomCatalog();
const PLAYERS = 8000;
const PER_INSTANCE = LIMITS.instanceMax;
const INSTANCES = PLAYERS / PER_INSTANCE;

function loadSink(counter) {
    return {
        send() {},
        sendFrame(frame) {
            counter.frames += 1;
            counter.bytes += frame.length;
            if (frame.length > counter.max) counter.max = frame.length;
            return true;
        },
        close() {},
    };
}

function fill(sim, sink, place) {
    for (let instanceId = 1; instanceId <= INSTANCES; instanceId += 1) {
        sim.open(instanceId);
        for (let index = 0; index < PER_INSTANCE; index += 1) {
            const point = place(index);
            sim.handle(sink, {
                type: 'hello',
                playerId: `p${instanceId}x${index}`,
                roomId: 'camp',
                x: point.x,
                y: point.y,
                instanceId,
            }, 0);
        }
    }
}

function relayMs(sim) {
    const started = performance.now();
    sim.relay(0);
    return performance.now() - started;
}

function pausedSocket(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({host: '127.0.0.1', port}, () => {
            socket.write(
                'GET / HTTP/1.1\r\n' +
                'Host: 127.0.0.1\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: cHJlc2VuY2UtdGVzdC1rZXk=\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n',
            );
        });
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (!buffer.includes('\r\n\r\n')) return;
            socket.pause();
            resolve(socket);
        });
        socket.on('error', reject);
    });
}

test('one world server relays 8000 players inside the one-second budget', {timeout: 180000}, async () => {
    const clusteredCount = {frames: 0, bytes: 0, max: 0};
    const clustered = createHost({catalog, machineId: 'capacity'});
    fill(clustered, loadSink(clusteredCount), index => ({x: (index % 20) * 20, y: Math.floor(index / 20) * 20}));
    assert.equal(clustered.stats().players, PLAYERS);
    assert.equal(clustered.stats().liveRooms, INSTANCES);
    relayMs(clustered);
    const clusterMs = Math.max(relayMs(clustered), relayMs(clustered), relayMs(clustered));
    assert.ok(clusteredCount.max < 12000, `relay frame ${clusteredCount.max} bytes`);
    assert.ok(clusterMs < 800, `clustered relay ${clusterMs.toFixed(1)} ms`);

    const spread = createHost({catalog, machineId: 'spread'});
    fill(spread, loadSink({frames: 0, bytes: 0, max: 0}), index => ({x: index * 100, y: 0}));
    const nearMs = relayMs(spread);
    assert.ok(spread.stats().relay.direct > 0);
    assert.ok(nearMs < 800, `spread near relay ${nearMs.toFixed(1)} ms`);
    for (let tick = 0; tick < 6; tick += 1) spread.relay(0);
    const farMs = relayMs(spread);
    assert.ok(farMs < 800, `spread far relay ${farMs.toFixed(1)} ms`);

    let connection = null;
    const slow = await startSocketServer({
        relayDropBytes: 1024,
        idleMs: 10000,
        onConnection(socket) {
            connection = socket;
        },
    });
    const paused = await pausedSocket(slow.port);
    try {
        const bulky = encodeTextFrame('x'.repeat(32000));
        let dropped = false;
        for (let attempt = 0; attempt < 80 && !dropped; attempt += 1) {
            if (connection.sendFrame(bulky) === false) dropped = true;
        }
        assert.equal(dropped, true);
    } finally {
        paused.destroy();
        await slow.close();
    }

    const connections = [];
    let hellos = 0;
    const server = await startSocketServer({
        maxConnections: PLAYERS,
        idleMs: 120000,
        onConnection(socket) {
            connections.push(socket);
            socket.on('message', text => {
                if (!text.includes('"hello"')) return;
                hellos += 1;
                socket.send('{"type":"welcome"}');
            });
        },
    });
    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
    assert.equal(health.ok, true);
    const clients = [];
    let relays = 0;
    try {
        const url = `ws://127.0.0.1:${server.port}`;
        function openClient(index) {
            const socket = new WebSocket(url);
            socket.onmessage = event => {
                if (String(event.data).includes('"relay"')) relays += 1;
            };
            clients.push(socket);
            return new Promise((resolve, reject) => {
                socket.addEventListener('open', () => {
                    socket.send('{"type":"hello"}');
                    resolve();
                });
                socket.addEventListener('error', () => reject(new Error(`socket ${index}`)));
            });
        }
        for (let start = 0; start < PLAYERS; start += 50) {
            const opening = [];
            for (let index = start; index < Math.min(PLAYERS, start + 50); index += 1) opening.push(openClient(index));
            const results = await Promise.allSettled(opening);
            const failed = results.filter(result => result.status === 'rejected').length;
            if (failed) {
                await new Promise(resolve => setTimeout(resolve, 50));
                const retry = [];
                for (let index = 0; index < failed; index += 1) retry.push(openClient(start + index));
                const second = await Promise.allSettled(retry);
                const still = second.find(result => result.status === 'rejected');
                if (still) throw still.reason;
            }
        }
        const helloDeadline = Date.now() + 20000;
        while (hellos < PLAYERS && Date.now() < helloDeadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(hellos, PLAYERS);
        assert.equal(connections.length, PLAYERS);
        const people = [];
        for (let index = 0; index < LIMITS.relayCap; index += 1) {
            people.push(`{"id":"p1x${index}","x":${index},"y":0,"facing":0,"seq":1}`);
        }
        const frame = encodeTextFrame(`{"type":"relay","tick":1,"players":[${people.join(',')}]}`);
        const fanoutStarted = performance.now();
        for (const socket of connections) socket.sendFrame(frame);
        const fanoutMs = performance.now() - fanoutStarted;
        assert.ok(fanoutMs < 1000, `fanout ${fanoutMs.toFixed(1)} ms`);
        const relayDeadline = Date.now() + 20000;
        while (relays < PLAYERS && Date.now() < relayDeadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(relays, PLAYERS);
        const extra = new WebSocket(url);
        const denied = await new Promise(resolve => {
            extra.addEventListener('open', () => resolve(false));
            extra.addEventListener('error', () => resolve(true));
            extra.addEventListener('close', () => resolve(true));
            setTimeout(() => resolve(extra.readyState !== WebSocket.OPEN), 3000);
        });
        extra.close();
        assert.equal(denied, true);
    } finally {
        for (const client of clients) client.close();
        await server.close();
    }
});
