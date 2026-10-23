// Same-machine grow, merge, and region split. Callers own the cooldown clock.

import {NOTICE} from '../protocol.js';

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

function playersOf(instance) {
    const players = [];
    for (const room of instance.rooms || []) {
        for (const bucket of room.buckets || []) {
            for (const playerId of bucket.playerIds || []) {
                players.push({playerId, roomId: room.id, bucket: bucket.key, fromInstanceId: instance.id});
            }
        }
    }
    return players;
}

function bucketDistance(a, b) {
    const [ax, ay] = String(a).split(':').map(Number);
    const [bx, by] = String(b).split(':').map(Number);
    return Math.hypot(ax - bx, ay - by);
}

function groupBy(list, keyFn) {
    const groups = new Map();
    for (const item of list) {
        const key = keyFn(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
}

function chooseMoving(instance, limits, force) {
    const players = playersOf(instance);
    if (players.length < 2) return null;
    if (!force && players.length < limits.growAt) return null;
    const rooms = [...groupBy(players, player => player.roomId).entries()]
        .map(([roomId, list]) => ({roomId, list}))
        .sort((a, b) => b.list.length - a.list.length || (a.roomId < b.roomId ? -1 : 1));
    const crowded = rooms[0];
    const buckets = [...groupBy(crowded.list, player => player.bucket).entries()]
        .map(([key, list]) => ({key, list}))
        .sort((a, b) => b.list.length - a.list.length || (a.key < b.key ? -1 : 1));
    const anchor = buckets[0];
    const ordered = buckets.slice(1).sort((a, b) => {
        const distance = bucketDistance(b.key, anchor.key) - bucketDistance(a.key, anchor.key);
        if (distance) return distance;
        return a.key < b.key ? 1 : -1;
    });
    const moving = [];
    let sourceCount = players.length;
    const take = list => {
        if (sourceCount - list.length < 1) return false;
        if (moving.length + list.length > limits.instanceMax) return false;
        moving.push(...list);
        sourceCount -= list.length;
        return true;
    };
    for (const bucket of ordered) {
        if (!force && sourceCount < limits.growAt) break;
        if (force && moving.length > 0 && sourceCount < limits.growAt) break;
        const before = sourceCount;
        if (!take(bucket.list)) continue;
        if (force && before >= limits.growAt && sourceCount < limits.growAt) break;
        if (!force && sourceCount < limits.growAt) break;
    }
    if (sourceCount >= limits.growAt) {
        const others = rooms.slice(1).sort((a, b) => a.list.length - b.list.length || (a.roomId < b.roomId ? -1 : 1));
        for (const room of others) {
            if (sourceCount < limits.growAt) break;
            take(room.list);
        }
    }
    if (!moving.length) return null;
    if (!force && sourceCount >= limits.growAt) return null;
    return moving;
}

export function planSplit(machine, limits, {force = false, instanceId = null} = {}) {
    const instances = [...(machine.instances || [])].sort((a, b) => population(b) - population(a) || a.id - b.id);
    const source = instanceId == null
        ? instances.find(instance => population(instance) >= limits.growAt) || (force ? instances[0] : null)
        : instances.find(instance => instance.id === instanceId);
    if (!source) return null;
    const moving = chooseMoving(source, limits, force || population(source) >= limits.growAt);
    if (!moving) return null;
    return {
        kind: 'split',
        needsOpen: true,
        toInstanceId: null,
        closeInstanceId: null,
        noticeInstanceIds: [source.id],
        text: NOTICE.split,
        moves: moving.map(player => ({
            playerId: player.playerId,
            fromInstanceId: source.id,
            toInstanceId: null,
        })),
    };
}

function orderedPair(a, b) {
    if (a.population !== b.population) return a.population < b.population
        ? {source: a, target: b}
        : {source: b, target: a};
    return a.instance.id > b.instance.id
        ? {source: a, target: b}
        : {source: b, target: a};
}

export function planMerge(machine, limits, {fromId = null, toId = null, manual = false} = {}) {
    const ranked = (machine.instances || [])
        .map(instance => ({instance, population: population(instance)}))
        .filter(entry => entry.population > 0);
    let source;
    let target;
    if (fromId != null || toId != null) {
        source = ranked.find(entry => entry.instance.id === fromId);
        target = ranked.find(entry => entry.instance.id === toId);
        if (!source || !target || source.instance.id === target.instance.id) return null;
    } else {
        const eligible = manual ? ranked : ranked.filter(entry => entry.population <= limits.mergeBelow);
        let best = null;
        for (let i = 0; i < eligible.length; i += 1) {
            for (let j = i + 1; j < eligible.length; j += 1) {
                const pair = orderedPair(eligible[i], eligible[j]);
                const sum = pair.source.population + pair.target.population;
                if (sum > limits.mergeCombinedMax) continue;
                if (!best || sum < best.sum || (sum === best.sum && pair.source.instance.id < best.source.instance.id)) {
                    best = {...pair, sum};
                }
            }
        }
        if (!best) return null;
        source = best.source;
        target = best.target;
    }
    const sum = source.population + target.population;
    if (sum > limits.mergeCombinedMax || sum > limits.instanceMax) return null;
    const moving = playersOf(source.instance);
    if (!moving.length) return null;
    return {
        kind: 'merge',
        needsOpen: false,
        toInstanceId: target.instance.id,
        closeInstanceId: source.instance.id,
        noticeInstanceIds: [source.instance.id, target.instance.id],
        text: NOTICE.merge,
        moves: moving.map(player => ({
            playerId: player.playerId,
            fromInstanceId: source.instance.id,
            toInstanceId: target.instance.id,
        })),
    };
}

export function planDrain(machine, limits, instanceId) {
    const source = (machine.instances || []).find(instance => instance.id === instanceId);
    if (!source) return null;
    const moving = playersOf(source);
    if (!moving.length) {
        return {
            kind: 'drain',
            needsOpen: false,
            toInstanceId: null,
            closeInstanceId: source.id,
            noticeInstanceIds: [],
            text: NOTICE.drain,
            moves: [],
        };
    }
    if (moving.length > limits.instanceMax) return null;
    const target = (machine.instances || [])
        .filter(instance => instance.id !== source.id)
        .map(instance => ({instance, population: population(instance)}))
        .filter(entry => entry.population + moving.length <= limits.instanceMax)
        .sort((a, b) => b.population - a.population || a.instance.id - b.instance.id)[0];
    return {
        kind: 'drain',
        needsOpen: !target,
        toInstanceId: target ? target.instance.id : null,
        closeInstanceId: source.id,
        noticeInstanceIds: [source.id],
        text: NOTICE.drain,
        moves: moving.map(player => ({
            playerId: player.playerId,
            fromInstanceId: source.id,
            toInstanceId: target ? target.instance.id : null,
        })),
    };
}

export function planAuto(machine, limits) {
    return planSplit(machine, limits, {force: false}) || planMerge(machine, limits);
}
