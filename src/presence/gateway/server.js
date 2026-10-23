// HTTP control plane and the admin site. Movement is not proxied through here.

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ADMIN_FILES = new Map([
    ['/admin', 'index.html'],
    ['/admin/', 'index.html'],
    ['/admin/index.html', 'index.html'],
    ['/admin/admin.js', 'admin.js'],
    ['/admin/admin.css', 'admin.css'],
]);

const TYPES = {
    'index.html': 'text/html; charset=utf-8',
    'admin.js': 'text/javascript; charset=utf-8',
    'admin.css': 'text/css; charset=utf-8',
};

function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', chunk => {
            size += chunk.length;
            if (size > 4_000_000) {
                reject(new Error('body'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try {
                resolve(JSON.parse(text));
            } catch {
                reject(new Error('json'));
            }
        });
        request.on('error', reject);
    });
}

export function startGateway({registry, host = '127.0.0.1', port = 0, adminToken = process.env.PRESENCE_ADMIN_TOKEN || '', local = null,
    auth = null, allowedOrigins = [], publicSocketUrl = '', analytics = null} = {}) {
    const adminDir = fileURLToPath(new URL('./admin/', import.meta.url));
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/api/join' || url.pathname === '/api/instances') {
                const origin = request.headers.origin;
                // Public, token-authenticated join only. Control/admin routes do
                // not inherit this CORS policy; cookies are never enabled.
                const anyOrigin = !!auth && allowedOrigins.includes('*');
                if (origin && !anyOrigin && !allowedOrigins.includes(origin)) {
                    sendJson(response, 403, {ok: false, error: 'origin'}); return;
                }
                if (origin) {
                    response.setHeader('Access-Control-Allow-Origin', anyOrigin ? '*' : origin);
                    response.setHeader('Vary', 'Origin');
                    response.setHeader('Access-Control-Allow-Methods', url.pathname === '/api/instances' ? 'GET, OPTIONS' : 'POST, OPTIONS');
                    response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
                }
                if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
                if (url.pathname === '/api/instances') {
                    if (request.method !== 'GET') { sendJson(response, 405, {ok: false}); return; }
                    sendJson(response, 200, registry.listInstances({page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize')}));
                    return;
                }
                if (request.method === 'POST' && auth) {
                    const body = await readBody(request);
                    const identity = await auth.verify(request.headers.authorization, body);
                    if (identity.roomType === 'account') { body.roomId = identity.roomId; body.x = 0; body.y = 0; }
                    const result = registry.join({...body, playerId: identity.playerId});
                    if (!result.ok) { sendJson(response, 503, result); return; }
                    const socketUrl = publicSocketUrl.replace('{port}', new URL(result.url).port);
                    sendJson(response, 200, {...result, ...(socketUrl ? {url: socketUrl} : {}),
                        playerId: identity.playerId, username: identity.username, roomId: body.roomId,
                        ...(identity.roomType === 'account' ? {visibility: 'private', ownerUsername: identity.username, roomType: 'account', capabilities: ['account.relay.v1']} : {}),
                        ticket: auth.issue(identity, result, body.roomId)});
                    return;
                }
            }
            if (request.method === 'GET' && ADMIN_FILES.has(url.pathname)) {
                const name = ADMIN_FILES.get(url.pathname);
                const body = await readFile(join(adminDir, name));
                response.writeHead(200, {
                    'content-type': TYPES[name],
                    'cache-control': 'no-store',
                });
                response.end(body);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/health') {
                sendJson(response, 200, {ok: true});
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/admin/report') {
                if (!adminToken || request.headers['x-admin-token'] !== adminToken) {
                    sendJson(response, 401, {ok: false, error: '需要配置并提供管理口令'}); return;
                }
                const date = url.searchParams.get('date') || 'today';
                if (!/^(today|\d{4}-\d{2}-\d{2})$/.test(date)) {
                    sendJson(response, 400, {ok: false, error: '日期格式错误'}); return;
                }
                if (!analytics) { sendJson(response, 503, {ok: false, error: '分析未启用'}); return; }
                try {
                    const data = JSON.parse(await readFile(join(analytics.directory, `${date}.json`), 'utf8'));
                    sendJson(response, 200, data);
                } catch { sendJson(response, 404, {ok: false, error: '暂无该日报；需先采集数据'}); }
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/admin/state') {
                const state = registry.state();
                state.localServers = local ? local.list() : [];
                if (adminToken && request.headers['x-admin-token'] === adminToken) state.privateRooms = auth?.privateRooms?.list() || [];
                sendJson(response, 200, state);
                return;
            }
            if (request.method === 'POST' && url.pathname === '/api/admin/action') {
                if (adminToken && request.headers['x-admin-token'] !== adminToken) {
                    sendJson(response, 401, {ok: false, error: 'token'});
                    return;
                }
                const body = await readBody(request);
                if (body.op === 'pause') {
                    sendJson(response, 200, {ok: true, paused: registry.setPaused(body.paused)});
                    return;
                }
                if (body.op === 'add-server') {
                    if (!local) {
                        sendJson(response, 400, {ok: false, error: 'no-local'});
                        return;
                    }
                    const result = await local.add({port: body.port, machineId: body.machineId});
                    sendJson(response, result.ok ? 200 : 400, result);
                    return;
                }
                const result = registry.manual(body);
                sendJson(response, result.ok ? 200 : 400, result);
                return;
            }
            if (request.method === 'POST' && (url.pathname === '/api/register' || url.pathname === '/api/heartbeat' || url.pathname === '/api/join')) {
                const body = await readBody(request);
                if (url.pathname === '/api/join' && (body.roomType === 'account' || body.roomId === 'account' || body.roomId?.startsWith('account:'))) {
                    sendJson(response, 401, {ok: false, error: 'auth-required'}); return;
                }
                const result = url.pathname === '/api/register'
                    ? registry.register(body)
                    : url.pathname === '/api/heartbeat'
                        ? registry.heartbeat(body)
                        : registry.join(body);
                const status = result.ok ? 200 : result.error === 'no-server' || result.error === 'server-full' ? 503 : 400;
                sendJson(response, status, result);
                return;
            }
            sendJson(response, 404, {ok: false, error: 'not-found'});
        } catch (error) {
            sendJson(response, error.status || 400, {ok: false, error: error.status ? error.message : 'bad-request'});
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            const address = server.address();
            resolve({
                server,
                host,
                port: address.port,
                url: `http://${host}:${address.port}`,
                close: () => new Promise(done => server.close(() => done())),
            });
        });
    });
}
