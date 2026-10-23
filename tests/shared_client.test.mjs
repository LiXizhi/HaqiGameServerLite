import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createPresenceClient, presenceIdentity, PROJECTS} from '../src/presence/client.js';
import {createHost} from '../src/presence/gameserver/instance.js';
import {loadRoomCatalog} from '../src/presence/protocol.js';

test('browser client import graph has no Node or external dependencies', async () => {
    const visited = new Set();
    async function inspect(url) {
        if (visited.has(url.href)) return;
        visited.add(url.href);
        const source = await readFile(url, 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
            assert.ok(match[1].startsWith('./'), match[1]);
            await inspect(new URL(match[1], url));
        }
    }
    await inspect(new URL('../src/presence/client.js', import.meta.url));
    assert.equal(typeof createPresenceClient, 'function');
});

test('three projects can reuse local player and room IDs without seeing each other', () => {
    const sim = createHost({catalog: loadRoomCatalog(), machineId: 'shared'});
    sim.open(1);
    const clients = Object.values(PROJECTS).map(project => {
        const identity = presenceIdentity(project, 'alice', 'lobby');
        const client = {messages: [], send(message) { this.messages.push(message); }, close() {}};
        sim.handle(client, {type: 'hello', ...identity, instanceId: 1, x: 0, y: 0}, 0);
        return {client, identity};
    });
    assert.deepEqual(sim.liveRooms(1), []);
    const second = {messages: [], send(message) { this.messages.push(message); }, close() {}};
    sim.handle(second, {type: 'hello', ...presenceIdentity(PROJECTS.haqi, 'bob', 'lobby'), instanceId: 1, x: 1, y: 0}, 0);
    assert.deepEqual(sim.liveRooms(1), ['haqi:lobby']);
    assert.ok(clients[0].client.messages.some(message => message.type === 'joined'));
    for (const {client, identity} of clients.slice(1)) {
        assert.equal(sim.player(identity.playerId).roomId, identity.roomId);
        assert.equal(client.messages.some(message => message.type === 'joined'), false);
    }
});

test('namespaced identifiers reject invalid values and overlength instead of truncating', () => {
    assert.deepEqual(presenceIdentity('awc', 'user-1', ' lobby '), {playerId: 'awc_user-1', roomId: 'awc:lobby'});
    for (const args of [['bad_project', 'p', 'r'], ['haqi', 'bad:id', 'r'], ['haqi', 'p', '\nroom'], ['haqi', 'p'.repeat(64), 'r'], ['haqi', 'p', 'r'.repeat(64)]]) {
        assert.throws(() => presenceIdentity(...args));
    }
});
