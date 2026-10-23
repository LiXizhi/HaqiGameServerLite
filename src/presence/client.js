// Small presence client. Receiving clients smooth one-sample-per-second movement locally.

import {smoothPosition} from './interpolation.js';

export {smoothPosition};
export {presenceIdentity, PROJECTS} from './namespace.js';

function listen(socket, onMessage) {
    if (typeof socket.on === 'function') {
        socket.on('message', data => onMessage(data.toString()));
        return;
    }
    socket.onmessage = event => onMessage(typeof event.data === 'string' ? event.data : String(event.data));
}

function onceOpen(socket) {
    return new Promise((resolve, reject) => {
        const fail = error => reject(error instanceof Error ? error : new Error('socket'));
        if (typeof socket.once === 'function') {
            socket.once('open', () => resolve());
            socket.once('error', fail);
            return;
        }
        socket.onopen = () => resolve();
        socket.onerror = fail;
    });
}

export function createPresenceClient({gatewayUrl, WebSocketImpl = globalThis.WebSocket, now = () => Date.now()} = {}) {
    const messages = [];
    const waiters = [];
    const peers = new Map();
    let socket = null;
    let assignment = null;
    let selfId = null;

    function note(message) {
        messages.push(message);
        if (message.type === 'relay') {
            const at = now();
            for (const player of message.players || []) {
                if (player.id === selfId) continue;
                const samples = peers.get(player.id) || [];
                samples.push({x: player.x, y: player.y, facing: player.facing, at});
                if (samples.length > 2) samples.shift();
                peers.set(player.id, samples);
            }
        }
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
            if (!waiters[index].predicate(message)) continue;
            const waiter = waiters.splice(index, 1)[0];
            waiter.resolve(message);
        }
    }

    return {
        messages,
        sample(id, at = now()) {
            return smoothPosition(peers.get(id), at);
        },
        async join(body) {
            const response = await fetch(`${gatewayUrl}/api/join`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify(body),
            });
            const data = await response.json();
            if (!response.ok || data.ok === false) throw new Error(data.error || 'join failed');
            assignment = data;
            return data;
        },
        async connect(hello) {
            if (!assignment) throw new Error('join first');
            selfId = hello.playerId;
            socket = new WebSocketImpl(assignment.url);
            listen(socket, text => {
                try {
                    note(JSON.parse(text));
                } catch {
                    note({type: 'reject', reason: 'message'});
                }
            });
            await onceOpen(socket);
            this.send({
                type: 'hello',
                playerId: hello.playerId,
                name: hello.name,
                appearance: hello.appearance,
                roomId: hello.roomId,
                x: hello.x,
                y: hello.y,
                facing: hello.facing,
                instanceId: assignment.instanceId,
            });
        },
        send(message) {
            socket.send(JSON.stringify(message));
        },
        waitFor(predicate, timeoutMs = 2000) {
            const existing = [...messages].reverse().find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
                const waiter = {predicate, resolve};
                waiters.push(waiter);
                const timer = setTimeout(() => {
                    const index = waiters.indexOf(waiter);
                    if (index >= 0) waiters.splice(index, 1);
                    reject(new Error('timeout'));
                }, timeoutMs);
                const finish = waiter.resolve;
                waiter.resolve = message => {
                    clearTimeout(timer);
                    finish(message);
                };
            });
        },
        close() {
            socket?.close();
        },
    };
}
