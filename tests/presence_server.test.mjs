import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createPresenceClient, smoothPosition} from '../src/presence/client.js';
import {planSplit} from '../src/presence/gateway/balance.js';
import {createRegistry} from '../src/presence/gateway/registry.js';
import {startGateway} from '../src/presence/gateway/server.js';
import {startGameServer} from '../src/presence/gameserver/index.js';
import {createHost} from '../src/presence/gameserver/instance.js';
import {startPresence} from '../src/presence/index.js';
import {LIMITS, loadRoomCatalog} from '../src/presence/protocol.js';

const catalog = loadRoomCatalog();
const cooldown = LIMITS.balanceCooldownMs;

function sink() {
    const messages = [];
    const client = {
        messages,
        send(message) { messages.push(message); },
        close() { client.closed = true; },
    };
    return client;
}

function host() {
    const sim = createHost({catalog, machineId: 'm'});
    sim.open(1);
    return sim;
}

function hello(sim, playerId, roomId, x, y, instanceId = 1, extra = {}, at = 0) {
    const client = sink();
    sim.handle(client, {
        type: 'hello',
        playerId,
        name: playerId,
        roomId,
        x,
        y,
        instanceId,
        ...extra,
    }, at);
    return client;
}

function relays(client) {
    return client.messages.filter(message => message.type === 'relay');
}

test('a named room stays unreal until a second player arrives and disappears when it empties', () => {
    const sim = host();
    const alice = hello(sim, 'alice', ' 码头 ', 0, 0);
    assert.equal(sim.player('alice').roomId, '码头');
    assert.deepEqual(sim.liveRooms(1), []);
    assert.equal(alice.messages.some(message => message.type === 'welcome' && message.live === false), true);
    const bob = hello(sim, 'bob', '码头', 8, 0);
    assert.deepEqual(sim.liveRooms(1), ['码头']);
    assert.equal(alice.messages.some(message => message.type === 'room' && message.live === true), true);
    assert.equal(bob.messages.some(message => message.type === 'room' && message.live === true), true);
    sim.handle(bob, {type: 'enterRoom', roomId: 'camp'}, 1);
    assert.equal(sim.player('bob').roomId, 'camp');
    assert.notEqual(sim.player('bob').roomId, sim.player('alice').roomId);
    assert.deepEqual(sim.liveRooms(1), []);
    assert.equal(alice.messages.some(message => message.type === 'room' && message.live === false), true);
    sim.handle(alice, {type: 'enterRoom', roomId: 'camp'}, 2);
    assert.deepEqual(sim.liveRooms(1), ['camp']);
    sim.handle(alice, {type: 'leaveRoom'}, 3);
    sim.handle(bob, {type: 'leaveRoom'}, 3);
    assert.equal(sim.player('alice').roomId, null);
    assert.equal(sim.player('bob').roomId, null);
    assert.deepEqual(sim.liveRooms(1), []);
    const rejected = sink();
    sim.handle(rejected, {type: 'hello', playerId: 'cara', roomId: '   ', x: 0, y: 0, instanceId: 1}, 4);
    assert.equal(rejected.messages.some(message => message.type === 'reject' && message.reason === 'room'), true);
});

test('same room relays a near move and another room stays invisible', () => {
    const sim = host();
    const alice = hello(sim, 'alice', 'town', 0, 0);
    const bob = hello(sim, 'bob', 'town', 10, 10);
    const cara = hello(sim, 'cara', 'fire', 12, 12);
    sim.handle(alice, {type: 'move', x: 30, y: 40, seq: 1}, 0);
    sim.relay(0);
    const others = relays(bob).at(-1).players.filter(player => player.id !== 'bob');
    assert.deepEqual(others.map(player => player.id), ['alice']);
    assert.equal(others[0].x, 30);
    assert.equal(relays(cara).length, 0);
    assert.equal(relays(alice).at(-1).players.some(player => player.id === 'cara'), false);
});

test('enterRoom stays on the same instance and the same socket', () => {
    const sim = host();
    const alice = hello(sim, 'alice', 'town', 0, 0);
    sim.handle(alice, {type: 'enterRoom', roomId: 'home:alice', x: 5, y: 6}, 10);
    assert.equal(sim.instanceOf('alice'), 1);
    assert.equal(sim.player('alice').sink, alice);
    assert.equal(alice.messages.some(message => message.type === 'migrate'), false);
    assert.equal(alice.messages.some(message => message.type === 'entered' && message.roomId === 'home:alice'), true);
});

test('a second move in the same second is dropped and far peers update on the slow band', () => {
    const sim = host();
    const alice = hello(sim, 'alice', 'town', 0, 0);
    const near = hello(sim, 'near', 'town', 10, 10);
    const mid = hello(sim, 'mid', 'town', 1000, 0);
    const far = hello(sim, 'far', 'town', 5000, 0);
    sim.handle(alice, {type: 'move', x: 100000, y: 0, seq: 1}, 0);
    assert.equal(sim.player('alice').x, catalog.maxSpeed);
    sim.handle(alice, {type: 'move', x: 20, y: 0, seq: 2}, 500);
    assert.equal(alice.messages.some(message => message.type === 'moveDropped'), true);
    assert.equal(sim.player('alice').x, catalog.maxSpeed);
    sim.handle(alice, {type: 'move', x: 40, y: 0, seq: 3}, 1000);
    assert.equal(sim.player('alice').x, 40);

    const seen = tick => relays(near)[tick - 1].players.map(player => player.id);
    for (let tick = 1; tick <= 8; tick += 1) sim.relay(tick * 1000);
    assert.equal(seen(1).includes('far'), false);
    assert.equal(seen(1).includes('mid'), false);
    assert.equal(seen(4).includes('mid'), true);
    assert.equal(seen(4).includes('far'), false);
    assert.equal(seen(8).includes('far'), true);
});

test('sparse instances merge only after the cooldown and tell both rooms of players', () => {
    const sim = createHost({catalog, machineId: 'm'});
    sim.open(1);
    sim.open(2);
    const clients = [
        hello(sim, 'a1', 'town', 0, 0, 1),
        hello(sim, 'a2', 'town', 20, 0, 1),
        hello(sim, 'b1', 'town', 0, 30, 2),
        hello(sim, 'b2', 'fire', 10, 10, 2),
    ];
    const registry = createRegistry({catalog, now: () => 0});
    const early = registry.heartbeat({machineId: 'm', advertiseUrl: 'ws://127.0.0.1:9', instances: sim.report('ws://127.0.0.1:9').instances, at: 0});
    assert.equal(early.commands.some(command => command.type === 'notice'), false);
    const notice = registry.heartbeat({machineId: 'm', advertiseUrl: 'ws://127.0.0.1:9', instances: sim.report('ws://127.0.0.1:9').instances, at: cooldown});
    sim.apply(notice.commands);
    for (const client of clients) {
        assert.equal(client.messages.some(message => message.type === 'notice' && message.text.includes('并入')), true);
    }
    const follow = registry.heartbeat({
        machineId: 'm',
        advertiseUrl: 'ws://127.0.0.1:9',
        instances: sim.report('ws://127.0.0.1:9').instances,
        at: cooldown + LIMITS.noticeLeadMs,
    });
    sim.apply(follow.commands);
    const instanceIds = ['a1', 'a2', 'b1', 'b2'].map(id => sim.instanceOf(id));
    assert.equal(new Set(instanceIds).size, 1);
    assert.equal(clients[2].messages.some(message => message.type === 'migrate'), true);
    assert.equal(sim.player('b1').sink, clients[2]);
});

test('a crowded room splits by region bucket and keeps each bucket together', () => {
    const sim = host();
    const near = Array.from({length: 300}, (_, index) => `n${index}`);
    const far = Array.from({length: 60}, (_, index) => `f${index}`);
    const side = Array.from({length: 40}, (_, index) => `s${index}`);
    for (const id of near) hello(sim, id, 'town', 0, 0);
    for (const id of far) hello(sim, id, 'town', 10000, 0);
    for (const id of side) hello(sim, id, 'town', 0, 10000);
    const registry = createRegistry({catalog, now: () => 0});
    const report = () => sim.report('ws://127.0.0.1:9').instances;
    registry.heartbeat({machineId: 'm', advertiseUrl: 'ws://127.0.0.1:9', instances: report(), at: 0});
    const notice = registry.heartbeat({machineId: 'm', advertiseUrl: 'ws://127.0.0.1:9', instances: report(), at: cooldown});
    sim.apply(notice.commands);
    assert.equal(sim.player('n0').sink.messages.some(message => message.type === 'notice' && message.text.includes('区域')), true);
    const follow = registry.heartbeat({
        machineId: 'm',
        advertiseUrl: 'ws://127.0.0.1:9',
        instances: report(),
        at: cooldown + LIMITS.noticeLeadMs,
    });
    const migrate = follow.commands.find(command => command.type === 'migrate');
    const moved = new Set(migrate.moves.map(move => move.playerId));
    assert.deepEqual(moved, new Set(far));
    for (const id of near.concat(side)) assert.equal(moved.has(id), false);
    sim.apply(follow.commands);
    const farInstance = sim.instanceOf('f0');
    assert.notEqual(farInstance, 1);
    for (const id of far) assert.equal(sim.instanceOf(id), farInstance);
    for (const id of near.concat(side)) assert.equal(sim.instanceOf(id), 1);
    const direct = planSplit({instances: sim.report('ws://127.0.0.1:9').instances}, LIMITS, {force: false});
    assert.equal(direct, null);
});

test('a quiet player leaves the room after 30 seconds', () => {
    const sim = host();
    hello(sim, 'alice', 'town', 0, 0);
    const bob = hello(sim, 'bob', 'town', 10, 0);
    sim.expire(LIMITS.clientTimeoutMs - 1);
    assert.equal(sim.player('alice')?.roomId, 'town');
    sim.expire(LIMITS.clientTimeoutMs);
    assert.equal(sim.player('alice'), null);
    assert.equal(bob.messages.some(message => message.type === 'left' && message.id === 'alice'), true);
});

test('a silent game server leaves the registry and a new process restores appearance from hello', () => {
    const registry = createRegistry({catalog, now: () => 0});
    registry.heartbeat({
        machineId: 'm',
        advertiseUrl: 'ws://127.0.0.1:9',
        at: 1000,
        instances: [{id: 1, rooms: [{id: 'town', buckets: [{key: '0:0', count: 1, playerIds: ['alice']}]}]}],
    });
    registry.dropStale(1000 + LIMITS.heartbeatTimeoutMs);
    assert.equal(registry.state().machines.length, 0);

    const first = host();
    hello(first, 'alice', 'town', 0, 0, 1, {appearance: {hat: 'red'}});
    assert.deepEqual(first.player('alice').appearance, {hat: 'red'});
    const second = host();
    assert.equal(second.player('alice'), null);
    hello(second, 'alice', 'town', 4, 5, 1, {appearance: {hat: 'red'}});
    assert.deepEqual(second.player('alice').appearance, {hat: 'red'});
});

test('a full world server refuses another player and the gateway offers another machine', () => {
    const sim = createHost({catalog, limits: {...LIMITS, serverMax: 2}});
    sim.open(1);
    hello(sim, 'alice', 'town', 0, 0);
    hello(sim, 'bob', 'town', 8, 0);
    const cara = sink();
    sim.handle(cara, {type: 'hello', playerId: 'cara', roomId: 'town', x: 0, y: 0, instanceId: 1}, 0);
    assert.equal(cara.messages.some(message => message.type === 'reject' && message.reason === 'server-full'), true);

    const registry = createRegistry({catalog, limits: {...LIMITS, serverMax: 2}, now: () => 0});
    const full = [{id: 1, rooms: [{id: 'town', buckets: [{key: '0:0', count: 2, playerIds: []}]}]}];
    registry.heartbeat({machineId: 'a', advertiseUrl: 'ws://127.0.0.1:9', instances: full, at: 0});
    registry.heartbeat({machineId: 'b', advertiseUrl: 'ws://127.0.0.1:10', instances: [], at: 0});
    const moved = registry.join({playerId: 'cara', roomId: 'town', x: 0, y: 0, at: 0});
    assert.equal(moved.ok, true);
    assert.equal(moved.machineId, 'b');
    registry.heartbeat({machineId: 'b', advertiseUrl: 'ws://127.0.0.1:10', instances: full, at: 1});
    const denied = registry.join({playerId: 'dana', roomId: 'town', x: 0, y: 0, at: 1});
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'server-full');
});

test('the 501st player is placed on another instance', () => {
    const registry = createRegistry({catalog, now: () => 0});
    registry.heartbeat({
        machineId: 'm',
        advertiseUrl: 'ws://127.0.0.1:9',
        at: 0,
        instances: [{id: 1, rooms: [{id: 'town', buckets: [{key: '0:0', count: 500, playerIds: []}]}]}],
    });
    const joined = registry.join({playerId: 'extra', roomId: 'town', x: 10, y: 10, at: 0});
    assert.equal(joined.ok, true);
    assert.notEqual(joined.instanceId, 1);
});

test('admin state lists machines and the dashboard html', async () => {
    const registry = createRegistry({catalog});
    const gateway = await startGateway({registry, adminToken: 'secret'});
    try {
        const denied = await fetch(`${gateway.url}/api/admin/action`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({op: 'pause', paused: true}),
        });
        assert.equal(denied.status, 401);
        await fetch(`${gateway.url}/api/register`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({machineId: 'm', advertiseUrl: 'ws://127.0.0.1:9'}),
        });
        await fetch(`${gateway.url}/api/heartbeat`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                machineId: 'm',
                advertiseUrl: 'ws://127.0.0.1:9',
                instances: [{id: 1, rooms: [{id: 'town', count: 1, buckets: [{key: '0:0', count: 1, playerIds: ['alice']}]}]}],
            }),
        });
        const state = await (await fetch(`${gateway.url}/api/admin/state`)).json();
        assert.equal(state.machines.length, 1);
        assert.equal(state.machines[0].instances[0].rooms[0].id, 'town');
        assert.equal(state.machines[0].instances[0].rooms[0].count, 1);
        const page = await (await fetch(`${gateway.url}/admin`)).text();
        assert.match(page, /在场网关/);
    } finally {
        await gateway.close();
    }
});

test('clients smooth samples and see a near move through the websocket', async () => {
    const halfway = smoothPosition(
        [{x: 0, y: 0, facing: 0, at: 0}, {x: 100, y: 0, facing: 1, at: 1000}],
        500,
    );
    assert.deepEqual(halfway, {x: 50, y: 0, facing: 0});

    const registry = createRegistry({catalog});
    const gateway = await startGateway({registry});
    const game = await startGameServer({gatewayUrl: gateway.url, catalog, machineId: 'm'});
    const alice = createPresenceClient({gatewayUrl: gateway.url});
    const bob = createPresenceClient({gatewayUrl: gateway.url});
    try {
        await alice.join({playerId: 'alice', name: '爱丽丝', roomId: 'town', x: 0, y: 0});
        await bob.join({playerId: 'bob', name: '鲍勃', roomId: 'town', x: 10, y: 10});
        await alice.connect({playerId: 'alice', name: '爱丽丝', roomId: 'town', x: 0, y: 0, appearance: {robe: 'blue'}});
        await bob.connect({playerId: 'bob', name: '鲍勃', roomId: 'town', x: 10, y: 10, appearance: {robe: 'green'}});
        await alice.waitFor(message => message.type === 'welcome');
        await bob.waitFor(message => message.type === 'welcome');
        alice.send({type: 'move', x: 30, y: 40, seq: 1});
        await alice.waitFor(message => message.type === 'moved' && message.x === 30);
        game.relayNow();
        const relay = await bob.waitFor(message => message.type === 'relay' && message.players.some(player => player.id === 'alice' && player.x === 30));
        assert.equal(relay.players.some(player => player.id === 'cara'), false);
    } finally {
        alice.close();
        bob.close();
        await game.close();
        await gateway.close();
    }
});

test('a busy game port moves the world server to the next free port', async () => {
    const occupied = createServer();
    await new Promise((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', resolve);
    });
    const busyPort = occupied.address().port;
    const presence = await startPresence({gatewayPort: 0, gamePort: busyPort, machineId: 'local-1'});
    try {
        assert.equal(presence.game.ok, true);
        assert.notEqual(presence.game.port, busyPort);
        const state = await (await fetch(`${presence.gateway.url}/api/admin/state`)).json();
        assert.equal(state.machines[0].advertiseUrl, presence.game.url);
    } finally {
        await presence.close();
        await new Promise(resolve => occupied.close(resolve));
    }
});

function spawnPresence(entry, port, cwd) {
    const child = spawn(process.execPath, [entry], {
        cwd,
        env: {...process.env, PRESENCE_GATEWAY_PORT: String(port), PRESENCE_GAME_PORT: '0'},
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
        output += chunk;
    });
    child.stderr.on('data', chunk => {
        output += chunk;
    });
    return {
        child,
        text: () => output,
    };
}

async function waitForOutput(read, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (read()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(read.toString());
}

test('starting presence again replaces the previous process', async () => {
    const probe = createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const entry = fileURLToPath(new URL('../src/presence/index.js', import.meta.url));
    // npm start passes a relative path; restarting must also recognize that form.
    const first = spawnPresence('src/presence/index.js', port, fileURLToPath(new URL('../', import.meta.url)));
    let second = null;
    try {
        await waitForOutput(() => first.text().includes('presence ready'));
        second = spawnPresence(entry, port);
        await waitForOutput(() => second.text().includes('Game server:'));
        assert.match(second.text(), new RegExp(`Gateway: http://127\\.0\\.0\\.1:${port}/admin`));
        assert.match(second.text(), /Game server: ws:\/\/127\.0\.0\.1:\d+/);
        await waitForOutput(() => first.child.exitCode !== null);
        const state = await (await fetch(`http://127.0.0.1:${port}/api/admin/state`)).json();
        assert.equal(state.localServers.length, 1);
        assert.match(second.text(), new RegExp(state.localServers[0].url.replaceAll('.', '\\.')));
    } finally {
        if (second && second.child.exitCode === null) second.child.kill('SIGKILL');
        if (first.child.exitCode === null) first.child.kill('SIGKILL');
    }
});

test('the gateway process spawns another world server on a different port', async () => {
    const presence = await startPresence({gatewayPort: 0, gamePort: 0, machineId: 'local-1'});
    try {
        const added = await (await fetch(`${presence.gateway.url}/api/admin/action`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({op: 'add-server'}),
        })).json();
        assert.equal(added.ok, true);
        assert.equal(added.machineId, 'local-2');
        assert.notEqual(added.port, presence.game.port);
        const state = await (await fetch(`${presence.gateway.url}/api/admin/state`)).json();
        assert.deepEqual(state.machines.map(machine => machine.id).sort(), ['local-1', 'local-2']);
        assert.equal(state.localServers.length, 2);
        const page = await (await fetch(`${presence.gateway.url}/admin`)).text();
        assert.match(page, /增加本机世界服/);
    } finally {
        await presence.close();
    }
});


test('packed relay keeps the same nearest and rotating roster while expanding sparse cells', () => {
    // Independent full-square reference: optimize lookup work, not who is visible.
    const layouts = [i => ({x: (i - 50) * 100, y: 0}),
        i => ({x: 0, y: (i - 50) * 100}),
        i => ({x: (i % 12 - 6) * 210, y: (Math.floor(i / 12) - 4) * 170}),
        i => ({x: (i % 12) * 12, y: Math.floor(i / 12) * 12})];
    for (const layout of layouts) {
        const sim = host();
        const people = Array.from({length: 100}, (_, i) => ({id: `p${i}`, ...layout(i)}));
        const clients = people.map(p => hello(sim, p.id, 'camp', p.x, p.y));
        for (let tick = 1; tick <= 16; tick++) {
            sim.relay(tick * 1000);
            if (tick % 8) continue;
            for (let i = 0; i < people.length; i++) {
                const p = people[i], cx = Math.floor(p.x / 100), cy = Math.floor(p.y / 100);
                const origin = people.find(q => Math.floor(q.x / 100) === cx && Math.floor(q.y / 100) === cy);
                let candidates;
                for (let radius = 1; radius <= 8; radius++) {
                    candidates = people.filter(q => Math.abs(Math.floor(q.x / 100) - cx) <= radius
                        && Math.abs(Math.floor(q.y / 100) - cy) <= radius);
                    if (candidates.length >= LIMITS.relayCap) break;
                }
                candidates.sort((a,b) => Math.hypot(a.x-origin.x,a.y-origin.y)-Math.hypot(b.x-origin.x,b.y-origin.y)
                    || (a.id < b.id ? -1 : 1));
                const head = Math.min(48, candidates.length), expected = candidates.slice(0,head);
                for (let offset = 0; offset < people.length && expected.length < head+16; offset++) {
                    const other = people[(tick*16+offset)%people.length];
                    if (!expected.includes(other)) expected.push(other);
                }
                assert.deepEqual(relays(clients[i]).at(-1).players.map(q => q.id), expected.map(q => q.id));
            }
        }
    }
});


test('public instance pages are ordered, bounded and private; explicit selection never falls back', async () => {
    let at = 100;
    const registry = createRegistry({catalog, now: () => at});
    registry.heartbeat({machineId: 'list-test', advertiseUrl: 'ws://127.0.0.1:1234',
        instances: Array.from({length: 45}, (_, i) => ({id: i + 1, rooms: [{id: 'haqi:camp', buckets: [{key: '0:0', count: i === 0 ? 400 : i === 1 ? 500 : 0}]}]}))});
    const page = registry.listInstances({page: 2, pageSize: 20});
    assert.equal(page.total, 45); assert.equal(page.pages, 3);
    assert.equal(page.instances[0].id, 21); assert.equal(page.instances.at(-1).id, 40);
    assert.equal(registry.listInstances().instances[0].status, 'crowded');
    assert.equal(registry.listInstances().instances[1].status, 'full');
    const join = instanceId => registry.join({playerId: 'test', roomId: 'haqi:camp', x: 0, y: 0, instanceId});
    assert.equal(join(23).instanceId, 23);
    assert.equal(join(2).ok, false); assert.equal(join(9999).ok, false); assert.equal(join(1.5).ok, false);
    const gateway = await startGateway({registry, auth: {}, allowedOrigins: ['*']});
    try {
        const response = await fetch(`${gateway.url}/api/instances?page=3&pageSize=20`, {headers: {Origin: 'http://127.0.0.1:3002'}});
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        const result = await response.json(); assert.equal(result.instances.length, 5);
        assert.deepEqual(Object.keys(result.instances[0]).sort(), ['capacity', 'id', 'playerCount', 'status']);
        const admin = await fetch(`${gateway.url}/api/admin/state`, {headers: {Origin: 'http://127.0.0.1:3002'}});
        assert.equal(admin.headers.get('access-control-allow-origin'), null);
    } finally { await gateway.close(); }
    at += LIMITS.heartbeatTimeoutMs; assert.equal(registry.listInstances().total, 0);
});

test('late arrivals receive existing peers appearance and position without waiting for movement', () => {
    const sim=host();
    hello(sim,'alice','camp',100,200,1,{appearance:{bodyId:'test-body'},facing:2});
    const bob=hello(sim,'bob','camp',150,200);
    const peer=bob.messages.find(m=>m.type==='roster').players.find(p=>p.id==='alice');
    assert.deepEqual(peer.appearance,{bodyId:'test-body'});
    assert.equal(peer.x,100);assert.equal(peer.y,200);assert.equal(peer.facing,2);
});
