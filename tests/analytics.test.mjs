import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dayOf, ingest, report} from '../src/presence/analytics/model.js';
import {createAnalytics} from '../src/presence/analytics/index.js';
import {startGateway} from '../src/presence/gateway/server.js';

const at = day => Date.parse(`${day}T12:00:00+08:00`);
const batch = (day, users) => ({at: at(day), online: users, visits: [], dropped: 0});
test('北京时间、去重、短连接、次日及七日留存和比较', () => {
    assert.equal(dayOf(Date.parse('2026-10-22T16:00:00Z')), '2026-10-23');
    const state = {first: {}, days: {}};
    ingest(state, batch('2026-10-16', ['a', 'a', 'b']), x => x);
    ingest(state, batch('2026-10-22', ['a', 'c', 'd']), x => x);
    ingest(state, {...batch('2026-10-23', ['a', 'c']), visits: [{key: 'short', at: at('2026-10-22')}]}, x => x);
    const result = report(state, '2026-10-23');
    assert.equal(result.metrics.active, 2);
    assert.equal(result.metrics.newUsers, 0);
    assert.equal(result.retention7.rate, 0.5);
    assert.equal(result.retention1.cohort, 3);
    assert.equal(result.retention1.rate, 1 / 3);
    assert.equal(result.previousDay.activeChange, -0.5);
    assert.equal(result.previousWeek.activeChange, 0);
    assert.equal(result.online[0], null);
    assert.equal(result.online[720], 2);
    assert.equal(result.metrics.sampledMinutes, 1);
});
test('无基数、停机日期与零在线区分', () => {
    const state = {first: {}, days: {}};
    ingest(state, batch('2026-10-22', []), x => x);
    ingest(state, batch('2026-10-23', ['a']), x => x);
    const result = report(state, '2026-10-23');
    assert.equal(result.previousDay.activeChange, null);
    assert.equal(result.previousDay.metrics.peak, 0);
    assert.equal(result.previousWeek.metrics, null);
    assert.equal(result.retention1.rate, null);
    assert.equal(report(state, '2026-10-21'), null);
});
async function waitFile(path) {
    for (let i = 0; i < 100; i++) {
        try { return JSON.parse(await readFile(path, 'utf8')); } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('等待分析文件超时');
}
test('Worker 持久化、隐私、短连接、重启补日报及接口鉴权', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gsl-analytics-'));
    let analytics, gateway;
    try {
        analytics = createAnalytics({directory, intervalMs: 20});
        const socket = {};
        analytics.enter(socket, {project: 'haqi', username: 'private-user'});
        analytics.leave(socket);
        analytics.enter({}, null);
        const today = await waitFile(join(directory, 'today.json'));
        assert.equal(today.metrics.active, 1);
        assert.equal(today.metrics.peak, 0);
        await analytics.close(); analytics = null;
        const raw = await readFile(join(directory, 'state.json'), 'utf8');
        assert.equal(raw.includes('private-user'), false);
        const state = JSON.parse(raw);
        state.days['2026-01-01'] = {users: [], samples: {0: 0}, dropped: 0};
        await writeFile(join(directory, 'state.json'), JSON.stringify(state));
        analytics = createAnalytics({directory, intervalMs: 60000});
        const restored = await waitFile(join(directory, '2026-01-01.json'));
        assert.equal(restored.metrics.active, 0);
        gateway = await startGateway({registry: {}, analytics, adminToken: 'test-only'});
        const url = `${gateway.url}/api/admin/report?date=2026-01-01`;
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, {headers: {'x-admin-token': 'test-only'}})).status, 200);
        assert.equal((await fetch(`${gateway.url}/api/admin/report?date=../state`, {headers: {'x-admin-token': 'test-only'}})).status, 400);
    } finally {
        await gateway?.close(); await analytics?.close();
        await rm(directory, {recursive: true, force: true});
    }
});

import {startPresence} from '../src/presence/index.js';
import {createAuthentication} from '../src/presence/auth.js';
test('实际 welcome 才记录，拒绝连接不计，多角色共享账号', async () => {
    const events = [];
    const analytics = {enter(socket, identity) { events.push(identity); }, leave() {}, async close() {}};
    const auth = createAuthentication({fetchImpl: async () => Response.json({username: 'alice'})});
    const presence = await startPresence({gatewayPort: 0, gamePort: 0, auth, analytics});
    async function hello(ticketValid, roleId) {
        const body = {username: 'alice', project: 'haqi', roleId, roomId: 'haqi:camp', x: 0, y: 0};
        const assignment = await (await fetch(`${presence.gateway.url}/api/join`, {
            method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer test'}, body: JSON.stringify(body),
        })).json();
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(assignment.url);
            const timer = setTimeout(() => { socket.close(); reject(new Error('连接超时')); }, 3000);
            socket.onopen = () => socket.send(JSON.stringify({...body, type: 'hello', playerId: assignment.playerId,
                instanceId: assignment.instanceId, ticket: ticketValid ? assignment.ticket : ''}));
            socket.onmessage = event => {
                const message = JSON.parse(event.data);
                if (['welcome', 'reject'].includes(message.type)) { clearTimeout(timer); socket.close(); resolve(message.type); }
            };
        });
    }
    try {
        assert.equal(await hello(false, 'one'), 'reject');
        assert.equal(events.length, 0);
        assert.equal(await hello(true, 'one'), 'welcome');
        assert.equal(await hello(true, 'two'), 'welcome');
        assert.equal(events.length, 2);
        assert.equal(events[0].username, events[1].username);
    } finally { await presence.close(); }
});

test('8000 账号采集与 Worker 汇总', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'gsl-analytics-load-'));
    const analytics = createAnalytics({directory, intervalMs: 20});
    try {
        const start = performance.now();
        for (let i = 0; i < 8000; i++) analytics.enter({}, {project: 'haqi', username: `load-${i}`});
        const elapsed = performance.now() - start;
        t.diagnostic(`8000 次入场采集主线程耗时 ${elapsed.toFixed(2)} ms`);
        assert.ok(elapsed < 1000, '采集不得占用一秒处理预算');
        const result = await waitFile(join(directory, 'today.json'));
        assert.equal(result.metrics.active, 8000);
        assert.equal(result.metrics.peak, 8000);
    } finally { await analytics.close(); await rm(directory, {recursive: true, force: true}); }
});

import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
test('跨午夜自动生成昨日归档且跨日在线计入新一天', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gsl-analytics-midnight-'));
    const worker = new Worker(new URL('../src/presence/analytics/worker.js', import.meta.url), {workerData: {directory}});
    try {
        await once(worker, 'message');
        let ready = once(worker, 'message');
        worker.postMessage(batch('2026-10-20', ['a'])); await ready;
        ready = once(worker, 'message');
        worker.postMessage(batch('2026-10-21', ['a'])); await ready;
        const yesterday = JSON.parse(await readFile(join(directory, '2026-10-20.json'), 'utf8'));
        const today = JSON.parse(await readFile(join(directory, 'today.json'), 'utf8'));
        assert.equal(yesterday.metrics.active, 1);
        assert.equal(today.retention1.rate, 1);
        assert.equal(today.lastSampleAt, at('2026-10-21'));
    } finally { await worker.terminate(); await rm(directory, {recursive: true, force: true}); }
});
