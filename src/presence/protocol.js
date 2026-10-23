// Presence protocol limits and pure helpers. Movement is client-reported.
// GSL grid nodes default to max_users = 500 in script/apps/GameServer/GSL_gridnode.lua.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const LIMITS = {
    instanceMax: 500,
    growAt: 400,
    mergeBelow: 100,
    mergeCombinedMax: 380,
    moveIntervalMs: 1000,
    relayIntervalMs: 1000,
    nearDistance: 800,
    midDistance: 2000,
    midEvery: 4,
    farEvery: 8,
    relayCap: 64,
    appearanceMaxBytes: 2048,
    clientTimeoutMs: 30000,
    balanceCooldownMs: 10 * 60 * 1000,
    noticeLeadMs: 8000,
    heartbeatTimeoutMs: 15000,
    regionSize: 2000,
    maxSpeed: 2500,
    serverMax: 8000,
    maxMessageBytes: 16 * 1024,
    relayDropBytes: 64 * 1024,
    outboundCloseBytes: 1024 * 1024,
    inboundPerSecond: 40,
    idleMs: 30000,
};

export const NOTICE = {
    merge: '人数较少，约8秒后将并入附近的世界，你会和身边的人留在一起。',
    split: '这里的人变多了，约8秒后将按所在区域分开，和你靠近的人会留在同一处。',
    drain: '这个世界即将关闭，约8秒后你会进入同一台机器上的另一个世界。',
};

const PLAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function regionKey(x, y, regionSize = LIMITS.regionSize) {
    const size = regionSize || LIMITS.regionSize;
    return `${Math.floor(Number(x) / size)}:${Math.floor(Number(y) / size)}`;
}

export function bandEvery(distance, limits = LIMITS) {
    if (distance < limits.nearDistance) return 1;
    if (distance <= limits.midDistance) return limits.midEvery;
    return limits.farEvery;
}

export function normalizeName(name, playerId) {
    const clean = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
    return clean || String(playerId).slice(0, 24);
}

export function validPlayerId(id) {
    return typeof id === 'string' && PLAYER_ID.test(id);
}

export function validRoomId(roomId) {
    if (typeof roomId !== 'string') return false;
    const name = roomId.trim();
    if (name.length < 1 || name.length > 64) return false;
    return !/[\u0000-\u001f\u007f]/.test(name);
}

export function canonicalRoomId(roomId) {
    return String(roomId).trim();
}

export function boundsFor(catalog, roomId) {
    const room = (catalog.rooms || []).find(entry => entry.id === roomId);
    return room?.bounds || catalog.defaultBounds;
}

export function clampPoint(x, y, bounds) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !bounds) return null;
    return {
        x: Math.min(bounds.maxX, Math.max(bounds.minX, nx)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, ny)),
    };
}

export function stepPosition(player, message, now, limits, bounds) {
    let x = Number(message.x);
    let y = Number(message.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!message.teleport && player.hasPosition) {
        const dt = Math.max(1, (now - player.lastMoveAt) / 1000);
        const dx = x - player.x;
        const dy = y - player.y;
        const dist = Math.hypot(dx, dy);
        const maxDist = limits.maxSpeed * dt;
        if (dist > maxDist && dist > 0) {
            const scale = maxDist / dist;
            x = player.x + dx * scale;
            y = player.y + dy * scale;
        }
    }
    return clampPoint(x, y, bounds);
}

export function parseAppearance(value, limits = LIMITS) {
    if (value == null) return {ok: true, appearance: {}};
    if (typeof value !== 'object' || Array.isArray(value)) return {ok: false, error: 'appearance'};
    let text;
    try {
        text = JSON.stringify(value);
    } catch {
        return {ok: false, error: 'appearance'};
    }
    if (Buffer.byteLength(text) > limits.appearanceMaxBytes) return {ok: false, error: 'appearance-size'};
    return {ok: true, appearance: JSON.parse(text)};
}

export {smoothPosition} from './interpolation.js';

export function catalogFromJson(text) {
    const catalog = JSON.parse(text);
    if (!catalog.defaultBounds || !Array.isArray(catalog.rooms)) throw new Error('invalid room catalog');
    return catalog;
}

export function loadRoomCatalog() {
    const path = fileURLToPath(new URL('./rooms.json', import.meta.url));
    return catalogFromJson(readFileSync(path, 'utf8'));
}
