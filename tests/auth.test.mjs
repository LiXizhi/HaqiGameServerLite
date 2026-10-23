import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthentication} from '../src/presence/auth.js';
import {startPresence} from '../src/presence/index.js';

const body = {username: 'alice', project: 'haqi', roleId: 'role-1', roomId: 'haqi:camp', x: 10, y: 20};
test('Keepwork Bearer verification checks exact username and fails closed', async () => {
    let calls = 0;
    const auth = createAuthentication({fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.keepwork.com/core/v0/users/profile');
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        assert.equal(options.redirect, 'error');
        return Response.json({username: 'alice', id: 1});
    }});
    await assert.rejects(auth.verify('', body), /auth-required/);
    assert.equal(calls, 0);
    const identity = await auth.verify('Bearer test-token', body);
    assert.match(identity.playerId, /^haqi_[a-f0-9]{40}$/);
    await assert.rejects(auth.verify('Bearer test-token', {...body, username: 'Alice'}), /username-mismatch/);
    for (const status of [401, 403, 500]) {
        const broken = createAuthentication({fetchImpl: async () => new Response('', {status})});
        await assert.rejects(broken.verify('Bearer test-token', body), /token-invalid|auth-unavailable/);
    }
    const down = createAuthentication({fetchImpl: async () => { throw Error('sensitive upstream error'); }});
    await assert.rejects(down.verify('Bearer test-token', body), {message: 'auth-unavailable'});
});

test('tickets bind identity, room, instance, expiration and cannot be reused or forged', () => {
    let at = 100;
    const auth = createAuthentication({now: () => at});
    const identity = {username: 'alice', project: 'haqi', playerId: 'haqi_alice'};
    const hello = {playerId: identity.playerId, roomId: body.roomId, instanceId: 1};
    const ticket = auth.issue(identity, {instanceId: 1}, body.roomId);
    for (const patch of [{playerId: 'haqi_bob'}, {roomId: 'awc:camp'}, {instanceId: 2}])
        assert.throws(() => auth.consume(ticket, {...hello, ...patch}), /ticket-invalid/);
    assert.throws(() => auth.consume(`x${ticket}`, hello), /ticket-invalid/);
    assert.equal(auth.consume(ticket, hello).username, 'alice');
    assert.throws(() => auth.consume(ticket, hello), /ticket-invalid/);
    const expired = auth.issue(identity, {instanceId: 1}, body.roomId);
    at += 60001;
    assert.throws(() => auth.consume(expired, hello), /ticket-invalid/);
});

function socketHello(url, hello) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { ws.close(); reject(Error('timeout')); }, 5000);
        ws.onopen = () => ws.send(JSON.stringify(hello));
        ws.onerror = () => { clearTimeout(timer); reject(Error('socket')); };
        ws.onmessage = event => {
            const message = JSON.parse(event.data);
            if (!['welcome', 'reject'].includes(message.type)) return;
            clearTimeout(timer); ws.close(); resolve(message);
        };
    });
}

test('real gateway and world require verified identity and signed single-use hello', async () => {
    const auth = createAuthentication({fetchImpl: async (_url, options) => options.headers.Authorization === 'Bearer valid'
        ? Response.json({username: 'alice'}) : new Response('', {status: 401})});
    const presence = await startPresence({gatewayPort: 0, gamePort: 0, auth, allowedOrigins: ['https://cdn.keepwork.com']});
    const join = (token, data = body) => fetch(`${presence.gateway.url}/api/join`, {
        method: 'POST', headers: {'content-type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(data),
    });
    try {
        assert.equal((await join('invalid')).status, 401);
        assert.equal((await join('valid', {...body, username: 'bob'})).status, 401);
        const preflight = await fetch(`${presence.gateway.url}/api/join`, {method: 'OPTIONS', headers: {Origin: 'https://cdn.keepwork.com'}});
        assert.equal(preflight.status, 204);
        assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
        assert.equal((await fetch(`${presence.gateway.url}/api/join`, {method: 'OPTIONS', headers: {Origin: 'https://other.example'}})).status, 403);
        const assignment = await (await join('valid', {...body, playerId: 'forged'})).json();
        assert.notEqual(assignment.playerId, 'forged');
        const hello = {type: 'hello', ...body, playerId: assignment.playerId, instanceId: assignment.instanceId, ticket: assignment.ticket};
        assert.equal((await socketHello(assignment.url, {...hello, ticket: ''})).type, 'reject');
        const welcome = await socketHello(assignment.url, hello);
        assert.equal(welcome.type, 'welcome');
        assert.equal(welcome.self.id, assignment.playerId);
        assert.equal((await socketHello(assignment.url, hello)).type, 'reject');
    } finally { await presence.close(); }
});


test('wildcard join admits any origin but requires a verified token and does not enable admin CORS', async () => {
    const config = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    const allowedOrigins = config.match(/^PRESENCE_ALLOWED_ORIGINS=(.+)$/m)[1].trim().split(',');
    const auth = createAuthentication({fetchImpl: async (_url, options) => options.headers.Authorization === 'Bearer valid'
        ? Response.json({username: 'alice'}) : new Response('', {status: 401})});
    const presence = await startPresence({gatewayPort: 0, gamePort: 0, auth, allowedOrigins});
    try {
        const url = `${presence.gateway.url}/api/join`;
        for (const origin of ['http://127.0.0.1:3002', 'http://127.0.0.1:65535', 'http://localhost:5173',
            'http://192.0.2.10:9000', 'http://[::1]:3002', 'https://other.example', 'null']) {
            const result = await fetch(url, {method: 'OPTIONS', headers: {Origin: origin,
                'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'}});
            assert.equal(result.status, 204);
            assert.equal(result.headers.get('access-control-allow-origin'), '*');
            assert.equal(result.headers.get('access-control-allow-credentials'), null);
            for (const token of ['', 'Bearer invalid']) {
                const denied = await fetch(url, {method: 'POST', headers: {Origin: origin,
                    'content-type': 'application/json', Authorization: token}, body: JSON.stringify(body)});
                assert.equal(denied.status, 401);
                assert.equal(denied.headers.get('access-control-allow-origin'), '*');
            }
            const admitted = await fetch(url, {method: 'POST', headers: {Origin: origin,
                'content-type': 'application/json', Authorization: 'Bearer valid'}, body: JSON.stringify(body)});
            assert.equal(admitted.status, 200);
        }
        const admin = await fetch(`${presence.gateway.url}/api/admin/state`, {headers: {Origin: 'https://other.example'}});
        assert.equal(admin.headers.get('access-control-allow-origin'), null);
    } finally { await presence.close(); }
});

// Real TCP/WebSocket fixtures; only the upstream Keepwork profile is stubbed.
async function connectedClient(assignment, data, peers) {
    const ws = new WebSocket(assignment.url);
    peers.push(ws);
    ws.closed = new Promise(resolve => ws.addEventListener('close', resolve, {once: true}));
    ws.messages = [];
    const first = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(Error('hello timeout')); }, 5000);
        ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('socket')); }, {once: true});
        ws.addEventListener('open', () => ws.send(JSON.stringify({type: 'hello', ...data,
            playerId: assignment.playerId, instanceId: assignment.instanceId, ticket: assignment.ticket})), {once: true});
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data); ws.messages.push(message);
            if (['welcome', 'reject'].includes(message.type)) { clearTimeout(timer); resolve(message); }
        });
    });
    return {ws, message: await first};
}

async function assign(presence, data = body, token = 'valid') {
    const response = await fetch(`${presence.gateway.url}/api/join`, {method: 'POST',
        headers: {'content-type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(data)});
    assert.equal(response.status, 200);
    return response.json();
}

async function closePeers(peers) {
    await Promise.all(peers.map(async ws => { ws.close(); await ws.closed; }));
}

test('same account and different roles allow 10 clients, reject the 11th, and free slots on disconnect', async () => {
    const auth = createAuthentication({fetchImpl: async (_url, options) =>
        Response.json({username: options.headers.Authorization === 'Bearer bob' ? 'bob' : 'alice'})});
    const presence = await startPresence({gatewayPort: 0, gamePort: 0, auth}), peers = [];
    try {
        // An unused ticket is not a live client and must not reserve capacity.
        await assign(presence);
        const assignments = await Promise.all(Array.from({length: 11}, (_, i) => assign(presence, {...body, roleId: `role-${i}`})));
        assert.equal(new Set(assignments.map(a => a.playerId)).size, 11);
        const clients = await Promise.all(assignments.map(a => connectedClient(a, body, peers)));
        const accepted = clients.filter(c => c.message.type === 'welcome');
        const refused = clients.filter(c => c.message.reason === 'account-connection-limit');
        assert.equal(accepted.length, 10); assert.equal(refused.length, 1);
        await refused[0].ws.closed;
        assert.ok(accepted.every(c => c.ws.readyState === WebSocket.OPEN));
        assert.ok(accepted.every(c => !c.ws.messages.some(m => m.reason === 'replaced')));
        // Another role/project/token cannot bypass the account cap.
        const alternate = {...body, project: 'awc', roleId: 'role-2', roomId: 'awc:lobby'};
        const capped = await connectedClient(await assign(presence, alternate, 'refreshed'), alternate, peers);
        assert.equal(capped.message.reason, 'account-connection-limit'); await capped.ws.closed;
        // A different verified user has an independent allowance.
        const bob = {...body, username: 'bob'};
        assert.equal((await connectedClient(await assign(presence, bob, 'bob'), bob, peers)).message.type, 'welcome');
        accepted[0].ws.close(); await accepted[0].ws.closed;
        assert.equal((await connectedClient(await assign(presence), body, peers)).message.type, 'welcome');
    } finally { await closePeers(peers); await presence.close(); }
});

test('failed admission and repeated release do not leak or over-release account slots', async () => {
    const auth = createAuthentication({fetchImpl: async () => Response.json({username: 'alice'})});
    const presence = await startPresence({gatewayPort: 0, gamePort: 0, auth}), peers = [];
    try {
        for (let i = 0; i < 12; i++) {
            const bad = await connectedClient(await assign(presence), {...body, x: 'invalid'}, peers);
            assert.equal(bad.message.type, 'reject'); await bad.ws.closed;
        }
        const clients = await Promise.all(Array.from({length: 10}, async (_, i) => connectedClient(await assign(presence, {...body, roleId: `role-${i}`}), body, peers)));
        assert.ok(clients.every(c => c.message.type === 'welcome'));
    } finally { await closePeers(peers); await presence.close(); }
    const release = auth.openSession({username: 'alice'}); release(); release();
    const slots = Array.from({length: 10}, () => auth.openSession({username: 'alice'}));
    assert.throws(() => auth.openSession({username: 'alice'}), /account-connection-limit/);
    slots.forEach(fn => fn());
});

test('shared auth counts simultaneous clients across world server instances', async () => {
    const auth = createAuthentication({fetchImpl: async () => Response.json({username: 'alice'})});
    const first = await startPresence({gatewayPort: 0, gamePort: 0, auth});
    const second = await startPresence({gatewayPort: 0, gamePort: 0, auth});
    const peers = [];
    try {
        const clients = await Promise.all(Array.from({length: 12}, async (_, i) => {
            const server = i % 2 ? first : second;
            return connectedClient(await assign(server, {...body, roleId: `role-${i}`}), body, peers);
        }));
        assert.equal(clients.filter(c => c.message.type === 'welcome').length, 10);
        assert.equal(clients.filter(c => c.message.reason === 'account-connection-limit').length, 2);
    } finally { await closePeers(peers); await first.close(); await second.close(); }
});


test('verified same-role takeover crosses world servers and failed hello keeps the old session', async () => {
    const auth = createAuthentication({fetchImpl: async () => Response.json({username: 'alice'})});
    const first = await startPresence({gatewayPort: 0, gamePort: 0, auth});
    const second = await startPresence({gatewayPort: 0, gamePort: 0, auth});
    const peers = [];
    try {
        const old = await connectedClient(await assign(first), body, peers);
        const observer = await connectedClient(await assign(first, {...body, roleId: 'observer'}), body, peers);
        const bad = await connectedClient(await assign(second), {...body, x: 'invalid'}, peers);
        await bad.ws.closed;
        assert.equal(old.ws.readyState, WebSocket.OPEN);
        const next = await connectedClient(await assign(second), body, peers);
        assert.equal(next.message.type, 'welcome');
        await old.ws.closed;
        assert.ok(old.ws.messages.some(m => m.type === 'reject' && m.reason === 'replaced'));
        assert.equal(next.ws.readyState, WebSocket.OPEN);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(observer.ws.messages.some(m => m.type === 'left' && m.reason === 'replaced'));
        const other = await connectedClient(await assign(first, {...body, roleId: 'other'}), body, peers);
        assert.equal(other.message.type, 'welcome');
        assert.equal(next.ws.readyState, WebSocket.OPEN);
    } finally { await closePeers(peers); await first.close(); await second.close(); }
});
