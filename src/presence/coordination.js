import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {join} from 'node:path';

export const COORDINATION = 'account.coordination.v1';
export const RETENTION = 7 * 86400000;
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
// One authority per gateway process. Files contain opaque resource/receipt keys,
// preferences and bounded checkpoint metadata, never credentials or message text.
export function createCoordination({directory, now = Date.now, maxReceipts = 10000} = {}) {
    const scopes = new Map();
    function scope(key) {
        if (scopes.has(key)) return scopes.get(key);
        let data = {revision: 0, order: [], receipts: {}, checkpoints: {}};
        const file = directory && join(directory, createHash('sha256').update(key).digest('hex') + '.json');
        let error = '';
        if (file) try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') error = 'storage-unavailable'; }
        const s = {data, file, error, candidates: new Map(), leases: new Map()}; scopes.set(key, s); return s;
    }
    function persist(s, data) {
        if (!s.file || s.error) throw Error('storage-unavailable');
        mkdirSync(directory, {recursive: true, mode: 0o700});
        const temporary = s.file + '.tmp';
        writeFileSync(temporary, JSON.stringify(data), {mode: 0o600});
        const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, s.file); s.data = data;
    }
    function elect(s, resource) {
        const candidates = [...s.candidates.values()].filter(c => c.resource === resource && c.expires > now() && c.eligible);
        const rank = id => { const i = s.data.order.indexOf(id); return i < 0 ? 10000 : i; };
        candidates.sort((a,b) => rank(a.computerId)-rank(b.computerId) || a.computerId.localeCompare(b.computerId));
        let lease = s.leases.get(resource);
        if (lease && lease.expires <= now()) { s.leases.delete(resource); lease = null; }
        if (!lease && candidates.length) { if(s.leases.size>=64)throw Error('resource-limit');lease = {connection: candidates[0].connection, computerId: candidates[0].computerId, epoch: randomUUID(), expires: now()+30000}; s.leases.set(resource, lease); }
        if (lease) lease.draining = !!candidates.length && candidates[0].computerId !== lease.computerId;
        return lease;
    }
    function view(s, resource) {
        return {revision: s.data.revision, order: s.data.order, candidates: [...s.candidates.values()].filter(c=>c.resource===resource && c.expires>now()).map(({connection,...c})=>c),
            lease: elect(s, resource) || null, checkpoint: s.data.checkpoints[resource] || null};
    }
    return {
        request(key, connection, m) {
            if (!directory) throw Error('coordination-unavailable');
            if (!valid(m.resource)) throw Error('invalid-resource');
            const s = scope(key), resource = m.resource;
            for(const [id,c] of s.candidates)if(c.expires<=now())s.candidates.delete(id);
            for(const [id,l] of s.leases)if(l.expires<=now())s.leases.delete(id);
            if (m.op === 'register') {
                if (!s.candidates.has(connection+':'+resource) && s.candidates.size>=640) throw Error('candidate-limit');
                if (!valid(m.computerId)) throw Error('invalid-computer');
                for (const c of s.candidates.values()) if(c.computerId===m.computerId && c.resource===resource && c.connection!==connection && c.expires>now()) throw Error('computer-already-connected');
                s.candidates.set(connection+':'+resource,{connection,resource,computerId:m.computerId,name:String(m.name||'Computer').slice(0,80),eligible:m.eligible===true,reason:String(m.reason||'').slice(0,160),expires:now()+30000});
            }
            if (m.op === 'preferences') {
                if (m.revision !== s.data.revision) throw Error('revision-conflict');
                if (!Array.isArray(m.order) || m.order.length>100 || !m.order.every(valid) || new Set(m.order).size!==m.order.length) throw Error('invalid-order');
                persist(s,{...s.data,revision:s.data.revision+1,order:m.order});
            }
            let lease = elect(s,resource);
            if (['renew','release','claim','sending','complete','checkpoint'].includes(m.op)) {
                if (!lease || lease.connection!==connection || lease.epoch!==m.epoch) throw Error('not-owner');
                if (m.op==='renew') lease.expires=now()+30000;
                if (m.op==='release') { s.leases.delete(resource); s.candidates.delete(connection+':'+resource); }
                if (m.op==='checkpoint') {
                    if (!s.data.checkpoints[resource] && Object.keys(s.data.checkpoints).length>=64) throw Error('checkpoint-limit');
                    if (Buffer.byteLength(JSON.stringify(m.value))>10000) throw Error('checkpoint-too-large');
                    persist(s,{...s.data,checkpoints:{...s.data.checkpoints,[resource]:m.value}});
                }
            }
            if (['claim','sending','complete','merge'].includes(m.op)) {
                if (!valid(m.key) || !Number.isFinite(m.time) || m.time<now()-RETENTION || m.time>now()+60000) throw Error('invalid-work');
                const key = resource+':'+m.key, receipts = Object.fromEntries(Object.entries(s.data.receipts).filter(([,r])=>r.time>=now()-RETENTION));
                const previous = receipts[key];
                if (m.op==='claim' && previous) return {...view(s,resource),accepted:false};
                if (!previous && Object.keys(receipts).length>=maxReceipts) throw Error('storage-full');
                if (m.op==='claim' && lease.draining) throw Error('draining');
                if (['sending','complete'].includes(m.op) && (!previous || previous.epoch!==m.epoch)) throw Error('work-not-owned');
                if (m.op==='sending' && previous.state!=='accepted') throw Error('already-sending');
                receipts[key]={time:previous?.time||m.time,epoch:previous?.epoch||m.epoch||'',state:m.op==='claim'?'accepted':m.op==='sending'?'sending':m.op==='complete'?'done':'unknown'};
                persist(s,{...s.data,receipts});
                return {...view(s,resource),accepted:true};
            }
            if (!['register','subscribe','preferences','status','renew','release','checkpoint'].includes(m.op)) throw Error('unknown-operation');
            return view(s,resource);
        },
        disconnect(key, connection) {
            const s = scopes.get(key); if (!s) return;
            for (const [id,c] of s.candidates) if(c.connection===connection)s.candidates.delete(id);
            // Keep leases until expiry: an unavailable former owner may still send.
        },
    };
}
