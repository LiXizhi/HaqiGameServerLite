import {parentPort, workerData} from 'node:worker_threads';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes, createHmac} from 'node:crypto';
import {dayOf, ingest, report} from './model.js';
const directory = workerData.directory;
await mkdir(directory, {recursive: true, mode: 0o700});
let state;
try { state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = {version: 1, salt: randomBytes(32).toString('hex'), first: {}, days: {}}; }
async function atomic(name, data) {
    await writeFile(join(directory, `${name}.tmp`), JSON.stringify(data), {mode: 0o600});
    await rename(join(directory, `${name}.tmp`), join(directory, name));
}
async function publish(today = dayOf(Date.now())) {
    // Regenerate retained reports after restart, including the last day before downtime.
    for (const date of Object.keys(state.days)) {
        if (date >= today) continue;
        await atomic(`${date}.json`, report(state, date));
    }
}
await publish();
let lastDay = dayOf(Date.now());
parentPort.on('message', async batch => {
    try {
        ingest(state, batch, key => createHmac('sha256', state.salt).update(key).digest('hex'));
        await atomic('state.json', state);
        const today = dayOf(batch.at);
        if (today !== lastDay) { await publish(today); lastDay = today; }
        await atomic('today.json', report(state, today));
        parentPort.postMessage('ready');
    } catch { throw new Error('分析文件写入失败'); }
});
parentPort.postMessage('ready');
