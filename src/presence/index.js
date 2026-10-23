// Local dev entry: one gateway and one stateless game server on this machine.

import {execFile} from 'node:child_process';
import {connect, getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout} from 'node:net';
import {fileURLToPath} from 'node:url';
import {createRegistry} from './gateway/registry.js';
import {startGateway} from './gateway/server.js';
import {createLocalSpawner} from './gateway/spawn.js';
import {loadRoomCatalog} from './protocol.js';
import {createAnalytics} from './analytics/index.js';
import {createAuthentication} from './auth.js';

// US -> Keepwork TCP handshakes can exceed Node's 250ms address-attempt
// default. Abandoning IPv4 early then hitting unreachable IPv6 caused 503s.
// Preserve larger operator settings and the authentication request's 8s limit.
setDefaultAutoSelectFamilyAttemptTimeout(Math.max(1500, getDefaultAutoSelectFamilyAttemptTimeout()));

function execText(file, args) {
    return new Promise(resolve => {
        execFile(file, args, {timeout: 8000, windowsHide: true}, (error, stdout) => {
            resolve(error ? '' : String(stdout || ''));
        });
    });
}

function portAccepts(host, port) {
    return new Promise(resolve => {
        const socket = connect({host, port});
        const finish = open => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(300);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function waitForPort(host, port, open, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await portAccepts(host, port) === open) return true;
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    return false;
}

function signal(pid, name) {
    try {
        process.kill(pid, name);
    } catch (error) {
        if (error.code !== 'ESRCH') throw error;
    }
}

async function presenceListener(port) {
    const entryPath = fileURLToPath(import.meta.url);
    const isPresenceCommand = command => {
        const normalized = command.replaceAll('\\', '/');
        return normalized.includes(entryPath.replaceAll('\\', '/'))
            || /(?:^|\s)["']?src\/presence\/index\.js["']?(?:\s|$)/.test(normalized);
    };
    if (process.platform === 'win32') {
        const listed = await execText('netstat.exe', ['-ano', '-p', 'tcp']);
        for (const line of listed.split(/\r?\n/)) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] !== 'TCP' || !parts[1]?.endsWith(`:${port}`) || parts[3] !== 'LISTENING') continue;
            const pid = Number(parts[4]);
            if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
            const command = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`]);
            if (isPresenceCommand(command)) return pid;
        }
        return 0;
    }
    const listed = await execText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pids = listed.split(/\s+/).map(Number).filter(pid => pid > 1 && pid !== process.pid);
    for (const pid of pids) {
        const command = await execText('ps', ['-p', String(pid), '-o', 'command=']);
        if (isPresenceCommand(command)) return pid;
    }
    return 0;
}

export async function replacePreviousPresence({host, port} = {}) {
    if (!port) return false;
    let page = '';
    try {
        const response = await fetch(`http://${host}:${port}/admin`, {signal: AbortSignal.timeout(1000)});
        if (!response.ok) return false;
        page = await response.text();
    } catch {
        return false;
    }
    if (!page.includes('<h1>在场网关</h1>')) return false;
    const pid = await presenceListener(port);
    if (!pid) throw new Error(`presence on ${port} did not stop`);
    signal(pid, 'SIGTERM');
    if (await waitForPort(host, port, false, 3000)) return true;
    signal(pid, 'SIGKILL');
    if (await waitForPort(host, port, false, 1000)) return true;
    throw new Error(`presence on ${port} did not stop`);
}

export async function startPresence({
    host = process.env.PRESENCE_HOST || '127.0.0.1',
    gatewayPort = Number(process.env.PRESENCE_GATEWAY_PORT || 8797),
    gamePort = Number(process.env.PRESENCE_GAME_PORT || 8798),
    machineId = process.env.PRESENCE_MACHINE_ID || 'local-1',
    auth = createAuthentication(),
    allowedOrigins = (process.env.PRESENCE_ALLOWED_ORIGINS || '*').split(',').map(value => value.trim()).filter(Boolean),
    publicSocketUrl = process.env.PRESENCE_PUBLIC_SOCKET_URL || '',
    analytics = null,
} = {}) {
    const catalog = loadRoomCatalog();
    const registry = createRegistry({catalog});
    const local = createLocalSpawner({host, catalog, auth, analytics});
    let gateway;
    try {
        gateway = await startGateway({registry, host, port: gatewayPort, local, auth, allowedOrigins, publicSocketUrl, analytics});
    } catch (error) {
        await analytics?.close();
        throw error;
    }
    local.gatewayUrl = gateway.url;
    let game = await local.add({port: gamePort, machineId});
    if (!game.ok && game.error === 'EADDRINUSE') {
        game = await local.add({machineId});
    }
    if (!game.ok) {
        await analytics?.close();
        await gateway.close();
        throw new Error(game.error || 'spawn');
    }
    return {
        gateway,
        game,
        local,
        close: async () => {
            await analytics?.close();
            await local.close();
            await gateway.close();
        },
    };
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) {
    const host = process.env.PRESENCE_HOST || '127.0.0.1';
    const gatewayPort = Number(process.env.PRESENCE_GATEWAY_PORT || 8797);
    await replacePreviousPresence({host, port: gatewayPort});
    const analytics = process.env.PRESENCE_ANALYTICS === '0' ? null : createAnalytics({directory: process.env.PRESENCE_ANALYTICS_DIR});
    const presence = await startPresence({host, gatewayPort, analytics});
    console.log(`Gateway: ${presence.gateway.url}/admin`);
    console.log(`Game server: ${presence.game.url}`);
    console.log(`presence ready gateway=${presence.gateway.url}/admin game=${presence.game.url}`);
    const shutdown = async () => {
        await presence.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
