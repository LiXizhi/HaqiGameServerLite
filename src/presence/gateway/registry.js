// Gateway registry. Game servers report live counts; this process assigns and balances.
// Player appearance and positions are not stored here.

import {LIMITS, canonicalRoomId, validPlayerId, validRoomId, regionKey} from '../protocol.js';
import {planAuto, planDrain, planMerge, planSplit} from './balance.js';

function population(instance) {
    let total = 0;
    const seen = new Set();
    for (const room of instance.rooms || []) {
        for (const bucket of room.buckets || []) {
            if (bucket.playerIds?.length) {
                for (const playerId of bucket.playerIds) {
                    if (seen.has(playerId)) continue;
                    seen.add(playerId);
                    total += 1;
                }
            } else {
                total += Number(bucket.count) || 0;
            }
        }
    }
    return total;
}

function machinePopulation(machine) {
    let total = 0;
    for (const instance of machine.instances) total += population(instance);
    return total;
}

function bucketCount(instance, roomId, key) {
    const room = (instance.rooms || []).find(entry => entry.id === roomId);
    if (!room) return 0;
    const bucket = (room.buckets || []).find(entry => entry.key === key);
    if (!bucket) return 0;
    return bucket.playerIds?.length || Number(bucket.count) || 0;
}

function normalizeInstance(raw) {
    const rooms = [];
    for (const room of raw.rooms || []) {
        const buckets = [];
        for (const bucket of room.buckets || []) {
            const playerIds = Array.isArray(bucket.playerIds) ? bucket.playerIds.map(String) : [];
            buckets.push({
                key: String(bucket.key),
                count: playerIds.length || Number(bucket.count) || 0,
                playerIds,
            });
        }
        rooms.push({id: String(room.id), buckets});
    }
    return {id: Number(raw.id), rooms};
}

export function createRegistry({limits = LIMITS, catalog, now = () => Date.now()} = {}) {
    const machines = new Map();
    let nextInstanceId = 1;
    let paused = false;
    const history = [];

    function allocate() {
        const id = nextInstanceId;
        nextInstanceId += 1;
        return id;
    }

    function noteInstanceId(id) {
        if (Number.isFinite(id) && id >= nextInstanceId) nextInstanceId = id + 1;
    }

    function machineView(machine) {
        return {
            id: machine.id,
            advertiseUrl: machine.advertiseUrl,
            lastSeen: machine.lastSeen,
            instances: machine.instances,
        };
    }

    function enqueue(machine, due, command) {
        machine.queue.push({due, command});
    }

    function pull(machine, at) {
        const ready = [];
        const waiting = [];
        for (const item of machine.queue) {
            if (item.due <= at) ready.push(item.command);
            else waiting.push(item);
        }
        machine.queue = waiting;
        return ready;
    }

    function remember(at, machineId, kind, text) {
        history.unshift({at, machineId, kind, text});
        if (history.length > 20) history.pop();
    }

    function schedule(machine, plan, at) {
        const toId = plan.toInstanceId ?? (plan.needsOpen || plan.moves.some(move => move.toInstanceId == null) ? allocate() : null);
        if (plan.needsOpen && toId != null) {
            machine.pendingOpens.add(toId);
            if (!machine.instances.some(instance => instance.id === toId)) {
                machine.instances.push({id: toId, rooms: []});
            }
            enqueue(machine, at, {type: 'open', instanceId: toId});
        }
        const moves = plan.moves.map(move => ({
            playerId: move.playerId,
            fromInstanceId: move.fromInstanceId,
            toInstanceId: move.toInstanceId ?? toId,
        }));
        if (plan.noticeInstanceIds.length) {
            enqueue(machine, at, {
                type: 'notice',
                instanceIds: plan.noticeInstanceIds,
                action: plan.kind,
                inSeconds: limits.noticeLeadMs / 1000,
                text: plan.text,
            });
        }
        if (moves.length) {
            enqueue(machine, at + (plan.noticeInstanceIds.length ? limits.noticeLeadMs : 0), {
                type: 'migrate',
                reason: plan.kind,
                moves,
            });
        }
        if (plan.closeInstanceId != null) {
            const delay = plan.noticeInstanceIds.length ? limits.noticeLeadMs : 0;
            enqueue(machine, at + delay, {type: 'close', instanceId: plan.closeInstanceId});
        }
        machine.pendingUntil = at + (plan.noticeInstanceIds.length ? limits.noticeLeadMs : 0);
        machine.lastBalanceAt = at;
        machine.balanceNotBefore = at + limits.balanceCooldownMs;
        remember(at, machine.id, plan.kind, plan.text);
        return toId;
    }

    function applyReport(machine, instances) {
        const reported = new Map();
        for (const raw of instances || []) {
            const instance = normalizeInstance(raw);
            if (!Number.isFinite(instance.id)) continue;
            noteInstanceId(instance.id);
            reported.set(instance.id, instance);
            machine.pendingOpens.delete(instance.id);
        }
        for (const id of machine.pendingOpens) {
            if (!reported.has(id)) reported.set(id, {id, rooms: []});
        }
        machine.instances = [...reported.values()].sort((a, b) => a.id - b.id);
    }

    function evaluate(machine, at) {
        if (paused || machine.pendingUntil > at || at < machine.balanceNotBefore) return;
        const plan = planAuto(machineView(machine), limits);
        if (!plan) return;
        schedule(machine, plan, at);
    }

    function publicInstance(instance) {
        return {
            id: instance.id,
            playerCount: population(instance),
            rooms: (instance.rooms || []).map(room => ({
                id: room.id,
                count: (room.buckets || []).reduce((sum, bucket) => sum + (bucket.playerIds?.length || Number(bucket.count) || 0), 0),
            })),
        };
    }

    return {
        register({machineId, advertiseUrl, at = now()}) {
            if (!machineId || !advertiseUrl) return {ok: false, error: 'machine'};
            const existing = machines.get(machineId);
            const machine = existing || {
                id: machineId,
                queue: [],
                pendingOpens: new Set(),
                instances: [],
                pendingUntil: 0,
                history: [],
            };
            machine.advertiseUrl = advertiseUrl;
            machine.lastSeen = at;
            if (!existing) {
                machine.balanceNotBefore = at + limits.balanceCooldownMs;
                machine.lastBalanceAt = null;
                machines.set(machineId, machine);
            }
            return {ok: true};
        },

        heartbeat({machineId, advertiseUrl, instances, at = now()}) {
            let machine = machines.get(machineId);
            if (!machine) {
                this.register({machineId, advertiseUrl, at});
                machine = machines.get(machineId);
            }
            if (advertiseUrl) machine.advertiseUrl = advertiseUrl;
            machine.lastSeen = at;
            this.dropStale(at);
            applyReport(machine, instances);
            evaluate(machine, at);
            return {ok: true, commands: pull(machine, at)};
        },

        dropStale(at = now()) {
            for (const [id, machine] of machines) {
                if (at - machine.lastSeen >= limits.heartbeatTimeoutMs) machines.delete(id);
            }
        },

        join({playerId, roomId, x, y, at = now()}) {
            this.dropStale(at);
            if (!validPlayerId(playerId)) return {ok: false, error: 'player'};
            if (!validRoomId(roomId, catalog)) return {ok: false, error: 'room'};
            if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return {ok: false, error: 'position'};
            const room = canonicalRoomId(roomId);
            const key = regionKey(x, y, catalog.regionSize || limits.regionSize);
            const ranked = [...machines.values()].sort((a, b) => a.id < b.id ? -1 : 1);
            const candidates = [];
            for (const machine of ranked) {
                if (machinePopulation(machine) >= limits.serverMax) continue;
                for (const instance of machine.instances) {
                    const count = population(instance);
                    if (count >= limits.instanceMax) continue;
                    candidates.push({
                        machine,
                        instance,
                        count,
                        bucketCount: bucketCount(instance, room, key),
                    });
                }
            }
            candidates.sort((a, b) => b.bucketCount - a.bucketCount || b.count - a.count || a.instance.id - b.instance.id);
            let chosen = candidates[0];
            if (!chosen) {
                const machine = ranked.find(entry => machinePopulation(entry) < limits.serverMax);
                if (!machine) return {ok: false, error: machines.size ? 'server-full' : 'no-server'};
                const instanceId = allocate();
                machine.pendingOpens.add(instanceId);
                machine.instances.push({id: instanceId, rooms: []});
                enqueue(machine, at, {type: 'open', instanceId});
                chosen = {machine, instance: {id: instanceId}};
            }
            return {
                ok: true,
                playerId,
                machineId: chosen.machine.id,
                instanceId: chosen.instance.id,
                url: chosen.machine.advertiseUrl,
            };
        },

        setPaused(value) {
            paused = Boolean(value);
            return paused;
        },

        manual({machineId, op, instanceId = null, fromId = null, toId = null, at = now()}) {
            const machine = machines.get(machineId);
            if (!machine) return {ok: false, error: 'machine'};
            if (machine.pendingUntil > at) return {ok: false, error: 'pending'};
            const view = machineView(machine);
            let plan = null;
            if (op === 'split') plan = planSplit(view, limits, {force: true, instanceId: Number(instanceId)});
            else if (op === 'merge') plan = planMerge(view, limits, {fromId: Number(fromId), toId: Number(toId), manual: true});
            else if (op === 'drain') plan = planDrain(view, limits, Number(instanceId));
            else return {ok: false, error: 'op'};
            if (!plan) return {ok: false, error: 'unavailable'};
            schedule(machine, plan, at);
            return {ok: true};
        },

        state() {
            return {
                paused,
                limits: {
                    instanceMax: limits.instanceMax,
                    serverMax: limits.serverMax,
                    growAt: limits.growAt,
                    mergeBelow: limits.mergeBelow,
                    mergeCombinedMax: limits.mergeCombinedMax,
                },
                lastBalance: history,
                machines: [...machines.values()].map(machine => ({
                    id: machine.id,
                    advertiseUrl: machine.advertiseUrl,
                    lastSeen: machine.lastSeen,
                    playerCount: machine.instances.reduce((sum, instance) => sum + population(instance), 0),
                    instances: machine.instances.map(publicInstance),
                })),
            };
        },
    };
}
