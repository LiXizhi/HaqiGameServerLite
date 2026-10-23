import {Worker} from 'node:worker_threads';
import {resolve} from 'node:path';

// No disk IO or aggregation in the game loop. At most one batch is in flight.
export function createAnalytics({directory = resolve('var/analytics'), intervalMs = 60000} = {}) {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {workerData: {directory}});
    const active = new Map();
    const visits = new Map();
    let busy = true, failed = false, dropped = 0, closing = false;
    let finish;
    worker.on('message', () => { busy = false; if (closing) finish?.(); });
    worker.on('error', () => { failed = true; finish?.(); console.error('用户分析不可用；游戏服务继续运行'); });
    worker.on('exit', () => { failed = true; finish?.(); });
    function sample() {
        if (busy || failed) return;
        busy = true;
        worker.postMessage({at: Date.now(), online: [...new Set(active.values())], visits: [...visits.values()], dropped});
        visits.clear(); dropped = 0;
    }
    const timer = setInterval(sample, intervalMs);
    timer.unref();
    return {
        directory,
        enter(socket, identity) {
            if (!identity || failed) return;
            const key = JSON.stringify([identity.project, identity.username]);
            active.set(socket, key);
            const at = Date.now();
            const visitKey = `${Math.floor((at + 28800000) / 86400000)}:${key}`;
            if (visits.size < 20000 || visits.has(visitKey)) visits.set(visitKey, {key, at});
            else dropped += 1;
        },
        leave(socket) { active.delete(socket); },
        async close() {
            clearInterval(timer);
            if (busy && !failed) await Promise.race([new Promise(r => { closing = true; finish = r; }), new Promise(r => setTimeout(r, 2000).unref())]);
            closing = false;
            if (!failed && !busy) {
                sample();
                await Promise.race([new Promise(r => { closing = true; finish = r; }), new Promise(r => setTimeout(r, 2000).unref())]);
            }
            await worker.terminate();
        },
    };
}
