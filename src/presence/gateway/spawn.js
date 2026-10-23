// World servers spawned inside the gateway process, each on its own port.

import {startGameServer} from '../gameserver/index.js';

export function createLocalSpawner({host = '127.0.0.1', catalog, limits, gatewayUrl = ''} = {}) {
    const servers = [];
    let seq = 1;
    const spawner = {
        gatewayUrl,
        list() {
            return servers.map(server => ({
                machineId: server.machineId,
                port: server.port,
                url: server.url,
            }));
        },
        async add({port, machineId} = {}) {
            if (!spawner.gatewayUrl) return {ok: false, error: 'gateway'};
            const explicit = port !== undefined && port !== null && port !== '';
            let candidate;
            if (!explicit) {
                const used = servers.map(server => server.port).filter(value => value > 0);
                candidate = used.length ? Math.max(...used) + 1 : 8798;
            } else {
                candidate = Number(port);
                if (!Number.isInteger(candidate) || candidate < 0 || candidate > 65535) return {ok: false, error: 'port'};
            }
            const id = machineId || `local-${seq}`;
            const attempts = explicit ? 1 : 20;
            let lastError = null;
            for (let attempt = 0; attempt < attempts; attempt += 1) {
                try {
                    const game = await startGameServer({
                        host,
                        port: candidate,
                        machineId: id,
                        gatewayUrl: spawner.gatewayUrl,
                        catalog,
                        limits,
                    });
                    if (!machineId) seq += 1;
                    else {
                        const match = /^local-(\d+)$/.exec(id);
                        if (match) seq = Math.max(seq, Number(match[1]) + 1);
                    }
                    servers.push(game);
                    return {ok: true, machineId: id, port: game.port, url: game.url};
                } catch (error) {
                    lastError = error;
                    if (explicit || error?.code !== 'EADDRINUSE') break;
                    candidate += 1;
                }
            }
            return {ok: false, error: lastError?.code || lastError?.message || 'spawn'};
        },
        async close() {
            const closing = servers.splice(0, servers.length);
            await Promise.all(closing.map(server => server.close()));
        },
    };
    return spawner;
}
