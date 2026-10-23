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
