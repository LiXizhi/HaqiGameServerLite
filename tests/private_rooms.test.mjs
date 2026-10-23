import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthentication} from '../src/presence/auth.js';
import {createPrivateRooms, privateRoomId, REMOTE_CHANNEL} from '../src/presence/private_rooms.js';
import {startPresence} from '../src/presence/index.js';
import {startGateway} from '../src/presence/gateway/server.js';

const identity = (username, playerId) => ({username, playerId, project: 'notes-app', roomType: 'account', roomId: privateRoomId(username, 'notes-app'), visibility: 'private', ownerUsername: username});
test('private rooms isolate membership, sender identity and forwarding across instances', () => {
    const rooms = createPrivateRooms(), a = [], b = [], c = [];
    const alice = rooms.connect(identity('alice', 'a'), {send: m => a.push(m)});
    const other = rooms.connect({...identity('alice', 'b'), instanceId: 999}, {send: m => b.push(m)});
    const bob = rooms.connect(identity('bob', 'c'), {send: m => c.push(m)});
    assert.deepEqual(a.at(-1).clients.map(p => p.id), ['a', 'b']);
    assert.deepEqual(c.at(-1).clients.map(p => p.id), ['c']);
    assert.throws(() => rooms.connect({...identity('bob', 'd'), roomId: privateRoomId('alice', 'notes-app')}, {send() {}}), /forbidden/);
    const request = {type: REMOTE_CHANNEL, kind: 'request', to: 'b', from: 'c', requestId: '1', ownerUsername: 'bob', payload: {op: 'list'}};
    alice.handle(request);
    assert.equal(b.at(-1).from, 'a'); assert.equal(b.at(-1).ownerUsername, undefined);
    assert.throws(() => bob.handle(request), /target-unavailable/);
    assert.throws(() => alice.handle({...request, to: 'c'}), /target-unavailable/);
    assert.throws(() => alice.handle({type: 'enterRoom', roomId: privateRoomId('bob', 'notes-app')}), /private-protocol/);
    assert.throws(() => alice.handle({...request, payload: 'x'.repeat(16000)}), /payload-too-large/);
    other.close(); assert.deepEqual(a.at(-1).clients.map(p => p.id), ['a']);
    alice.close(); bob.close(); assert.deepEqual(rooms.list(), []);
});

test('real sockets: verified owner only, private metadata, remote relay and public nondiscovery', async () => {
    const auth = createAuthentication({fetchImpl: async (_url, options) => Response.json({username: options.headers.Authorization === 'Bearer bob' ? 'bob' : 'alice'})});
    const server = await startPresence({gatewayPort: 0, gamePort: 0, auth});
    const sockets = [];
    const join = (username, patch = {}) => fetch(`${server.gateway.url}/api/join`, {method: 'POST', headers: {'content-type': 'application/json', Authorization: `Bearer ${username}`},
        body: JSON.stringify({username, project: 'notes-app', roomType: 'account', roleId: 'tab', roomId: 'account', ...patch})});
    async function connect(username, socketUrl) {
        const response = await join(username), assignment = await response.json(); assert.equal(response.status, 200);
        assert.equal(assignment.visibility, 'private'); assert.equal(assignment.ownerUsername, username);
        const ws = new WebSocket(socketUrl || assignment.url); sockets.push(ws); const messages = [];
        ws.addEventListener('message', event => messages.push(JSON.parse(event.data)));
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        ws.send(JSON.stringify({type: 'hello', ...assignment}));
        await until(() => messages.some(m => m.type === 'welcome'));
        return {ws, assignment, messages};
    }
    try {
        for (const patch of [{roomId: privateRoomId('bob', 'notes-app')}, {visibility: 'public'}, {ownerUsername: 'bob'}]) assert.equal((await join('alice', patch)).status, 403);
        const second = await server.local.add({port: 0, machineId: 'second-world'});
        assert.equal(second.ok, true);
        const a = await connect('alice'), b = await connect('alice', second.url), c = await connect('bob');
        await until(() => a.messages.some(m => m.type === 'privateMembers' && m.clients.length === 2));
        a.ws.send(JSON.stringify({type: REMOTE_CHANNEL, kind: 'request', requestId: 'test', to: b.assignment.playerId, from: c.assignment.playerId, payload: {op: 'list'}}));
        await until(() => b.messages.some(m => m.requestId === 'test'));
        assert.equal(b.messages.find(m => m.requestId === 'test').from, a.assignment.playerId);
        c.ws.send(JSON.stringify({type: REMOTE_CHANNEL, kind: 'request', requestId: 'attack', to: a.assignment.playerId, payload: {op: 'list'}}));
        await until(() => c.messages.some(m => m.requestId === 'attack'));
        assert.equal(c.messages.find(m => m.requestId === 'attack').type, 'reject');
        const state = await (await fetch(`${server.gateway.url}/api/admin/state`)).json();
        assert.equal(state.privateRooms, undefined);
        assert.ok(!JSON.stringify(state).includes(privateRoomId('alice', 'notes-app')));
        a.ws.send(JSON.stringify({type: 'enterRoom', roomId: privateRoomId('bob', 'notes-app')}));
        await until(() => a.ws.readyState === 3);
    } finally { for (const ws of sockets) ws.close(); await server.close(); }
});

test('only authenticated administrators can discover private room metadata', async () => {
    const auth = createAuthentication(); const peer = auth.privateRooms.connect(identity('alice', 'a'), {send() {}});
    const gateway = await startGateway({registry: {state: () => ({machines: []})}, auth, adminToken: 'fixture-admin'});
    try {
        for (const token of ['', 'wrong']) {
            const state = await (await fetch(gateway.url + '/api/admin/state', {headers: {'x-admin-token': token}})).json();
            assert.equal(state.privateRooms, undefined);
        }
        const state = await (await fetch(gateway.url + '/api/admin/state', {headers: {'x-admin-token': 'fixture-admin'}})).json();
        assert.deepEqual(state.privateRooms, [{id: privateRoomId('alice', 'notes-app'), visibility: 'private', ownerUsername: 'alice', count: 1}]);
    } finally { peer.close(); await gateway.close(); }
});

async function until(check) {
    const deadline = Date.now() + 5000;
    while (!check()) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
}


test('arbitrary applications and opaque payloads require no server protocol registration', async () => {
    const rooms = createPrivateRooms(), messages = [];
    const a = rooms.connect(identity('alice', 'a'), {send() {}});
    const b = rooms.connect(identity('alice', 'b'), {send: m => messages.push(m)});
    const other = rooms.connect({...identity('alice', 'c'), project: 'another-app', roomId: privateRoomId('alice', 'another-app')}, {send() {}});
    const payload = {channel: 'future.application.v42', kind: 'anything', instructions: [1, null, {nested: true}]};
    a.handle({type: REMOTE_CHANNEL, requestId: 'opaque', to: 'b', payload, from: 'fake', kind: 'ignored'});
    assert.deepEqual(messages.at(-1), {type: REMOTE_CHANNEL, requestId: 'opaque', from: 'a', to: 'b', payload});
    assert.throws(() => a.handle({type: REMOTE_CHANNEL, requestId: 'x', to: 'c', payload}), /target-unavailable/);
    a.close(); b.close(); other.close();
    const auth = createAuthentication({fetchImpl: async () => Response.json({username: 'alice'})});
    const request = {username: 'alice', project: 'new-app_42', roleId: 'tab', roomType: 'account'};
    const verified = await auth.verify('Bearer fixture', request);
    assert.equal(verified.roomId, privateRoomId('alice', 'new-app_42'));
    assert.equal(verified.visibility, 'private');
    for (const patch of [{project: '../invalid'}, {roomType: 'public'}, {visibility: 'public'}, {ownerUsername: 'bob'}, {roomId: privateRoomId('alice', 'notes-app')}]) {
        await assert.rejects(auth.verify('Bearer fixture', {...request, ...patch}));
    }
    await assert.rejects(auth.verify('Bearer fixture', {...request, roomType: undefined}));
});


test('account rooms do not trigger game-role takeover and retain the account connection limit', () => {
    const auth = createAuthentication(); let replaced = 0;
    const game = auth.openSession({username: 'alice', project: 'haqi', roleId: 'hero'}, () => ++replaced); game.activate();
    const releases = Array.from({length: 9}, () => auth.openSession({username: 'alice', project: 'haqi', roleId: 'hero', roomType: 'account'}));
    releases.forEach(release => release.activate());
    assert.equal(replaced, 0);
    assert.throws(() => auth.openSession({username: 'alice', project: 'any-app', roomType: 'account'}), /account-connection-limit/);
    releases.forEach(release => release()); game();
});

test('unauthenticated development gateways cannot allocate reserved account rooms', async () => {
    let joins = 0;
    const server = await startGateway({registry: {join: () => { ++joins; return {ok: true}; }}});
    try {
        for (const body of [{roomType: 'account'}, {roomId: 'account'}, {roomId: 'account:private:known'}]) {
            const response = await fetch(server.url + '/api/join', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
            assert.equal(response.status, 401);
        }
        assert.equal(joins, 0);
    } finally { await server.close(); }
});
