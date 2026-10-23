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

export function startGateway({registry, host = '127.0.0.1', port = 0, adminToken = process.env.PRESENCE_ADMIN_TOKEN || '', local = null} = {}) {
    const adminDir = fileURLToPath(new URL('./admin/', import.meta.url));
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
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
            if (request.method === 'GET' && url.pathname === '/api/admin/state') {
                const state = registry.state();
                state.localServers = local ? local.list() : [];
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
            sendJson(response, 400, {ok: false, error: error.message || 'bad-request'});
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
