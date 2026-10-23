// Stateless world-server simulation. Live sockets, rooms, and the latest position only.

import {encodeTextFrame} from '../socket.js';
import {
    LIMITS,
    NOTICE,
    bandEvery,
    boundsFor,
    canonicalRoomId,
    normalizeName,
    parseAppearance,
    regionKey,
    stepPosition,
    validPlayerId,
    validRoomId,
} from '../protocol.js';

function send(sink, message) {
    try {
        sink.send(message);
    } catch {
        // The socket may already be closed.
    }
}

export function createHost({catalog, limits = LIMITS, machineId = 'local'} = {}) {
    if (!catalog) throw new Error('room catalog is required');
    const runtimeLimits = {
        ...limits,
        maxSpeed: catalog.maxSpeed ?? limits.maxSpeed,
        regionSize: catalog.regionSize ?? limits.regionSize,
    };
    const instances = new Map();
    const byPlayer = new Map();
    const relayStats = {frames: 0, bytes: 0, dropped: 0, lastMs: 0, shared: 0, direct: 0};

    function open(instanceId) {
        const id = Number(instanceId);
        if (!instances.has(id)) instances.set(id, {id, players: new Map(), rooms: new Map(), relayTick: 0});
        return instances.get(id);
    }

    function rosterFrom(members) {
        const players = [];
        for (const player of members) players.push({id: player.id, name: player.name, appearance: player.appearance,
            revision: player.revision, x: player.x, y: player.y, facing: player.facing});
        players.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return players;
    }

    function occupants(instance, roomId) {
        const list = [];
        for (const player of instance.players.values()) {
            if (player.roomId === roomId) list.push(player);
        }
        return list;
    }

    // A room object exists only while at least two players share that name.
    function detach(instance, player, reason) {
        const previous = player.roomId;
        if (!previous) return;
        player.roomId = null;
        const room = instance.rooms.get(previous);
        if (!room) return;
        room.members.delete(player);
        for (const other of room.members) send(other.sink, {type: 'left', id: player.id, roomId: previous, reason});
        if (room.members.size >= 2) return;
        const remaining = [...room.members];
        instance.rooms.delete(previous);
        for (const other of remaining) send(other.sink, {type: 'room', roomId: previous, live: false});
    }

    function attach(instance, player, roomId) {
        player.roomId = roomId;
        let room = instance.rooms.get(roomId);
        let created = false;
        if (!room) {
            const players = occupants(instance, roomId);
            if (players.length < 2) {
                send(player.sink, {type: 'entered', instanceId: instance.id, roomId, live: false});
                return;
            }
            room = {id: roomId, members: new Set(players)};
            instance.rooms.set(roomId, room);
            created = true;
        } else {
            room.members.add(player);
        }
        const names = rosterFrom(room.members);
        send(player.sink, {type: 'entered', instanceId: instance.id, roomId, live: true});
        send(player.sink, {type: 'roster', roomId, players: names});
        send(player.sink, {type: 'room', roomId, live: true});
        for (const other of room.members) {
            if (other === player) continue;
            send(other.sink, {
                type: 'joined',
                id: player.id,
                name: player.name,
                roomId,
                appearance: player.appearance,
                revision: player.revision,
                x: player.x,
                y: player.y,
                facing: player.facing,
            });
            if (created) {
                send(other.sink, {type: 'room', roomId, live: true});
                send(other.sink, {type: 'roster', roomId, players: names});
            }
        }
    }
    function remove(playerId, reason) {
        const player = byPlayer.get(playerId);
        if (!player) return null;
        const instance = instances.get(player.instanceId);
        if (instance) detach(instance, player, reason);
        instance?.players.delete(playerId);
        byPlayer.delete(playerId);
        return player;
    }

    function hello(sink, message, now) {
        if (!validPlayerId(message.playerId)) return send(sink, {type: 'reject', reason: 'player'});
        if (!validRoomId(message.roomId)) return send(sink, {type: 'reject', reason: 'room'});
        const roomId = canonicalRoomId(message.roomId);
        const instance = instances.get(Number(message.instanceId));
        if (!instance) return send(sink, {type: 'reject', reason: 'instance-missing'});
        const appearance = parseAppearance(message.appearance, runtimeLimits);
        if (!appearance.ok) return send(sink, {type: 'reject', reason: appearance.error});
        const point = stepPosition(
            {hasPosition: false, x: 0, y: 0, lastMoveAt: now},
            {...message, teleport: true},
            now,
            runtimeLimits,
            boundsFor(catalog, roomId),
        );
        if (!point) return send(sink, {type: 'reject', reason: 'position'});
        const existing = byPlayer.get(message.playerId);
        if (existing && existing.sink !== sink) {
            existing.sink.replaced = true;
            send(existing.sink, {type: 'reject', reason: 'replaced'});
            existing.sink.close?.();
            remove(message.playerId, 'replaced');
        }
        if (!byPlayer.has(message.playerId) && byPlayer.size >= runtimeLimits.serverMax) {
            return send(sink, {type: 'reject', reason: 'server-full'});
        }
        if (instance.players.size >= runtimeLimits.instanceMax && !instance.players.has(message.playerId)) {
            return send(sink, {type: 'reject', reason: 'full'});
        }
        const player = {
            id: message.playerId,
            name: normalizeName(message.name, message.playerId),
            appearance: appearance.appearance,
            revision: 1,
            roomId: null,
            x: point.x,
            y: point.y,
            facing: Number.isFinite(Number(message.facing)) ? Number(message.facing) : 0,
            seq: 0,
            instanceId: instance.id,
            sink,
            lastSeen: now,
            lastMoveAt: now - runtimeLimits.moveIntervalMs,
            hasPosition: true,
        };
        instance.players.set(player.id, player);
        byPlayer.set(player.id, player);
        sink.playerId = player.id;
        attach(instance, player, roomId);
        send(sink, {
            type: 'welcome',
            instanceId: instance.id,
            roomId,
            live: instance.rooms.has(roomId),
            self: {id: player.id, name: player.name, x: player.x, y: player.y, appearance: player.appearance, revision: 1},
        });
    }

    function requirePlayer(sink) {
        const player = sink.playerId ? byPlayer.get(sink.playerId) : null;
        if (!player || player.sink !== sink) {
            send(sink, {type: 'reject', reason: 'hello'});
            return null;
        }
        return player;
    }

    function move(sink, message, now) {
        const player = requirePlayer(sink);
        if (!player || !player.roomId) return;
        player.lastSeen = now;
        if (now - player.lastMoveAt < runtimeLimits.moveIntervalMs) {
            send(sink, {type: 'moveDropped', seq: message.seq ?? null});
            return;
        }
        const point = stepPosition(player, message, now, runtimeLimits, boundsFor(catalog, player.roomId));
        if (!point) return send(sink, {type: 'reject', reason: 'position'});
        player.x = point.x;
        player.y = point.y;
        if (Number.isFinite(Number(message.facing))) player.facing = Number(message.facing);
        if (Number.isFinite(Number(message.seq))) player.seq = Number(message.seq);
        player.lastMoveAt = now;
        send(sink, {type: 'moved', seq: player.seq, x: player.x, y: player.y});
    }

    function enterRoom(sink, message, now) {
        const player = requirePlayer(sink);
        if (!player) return;
        if (!validRoomId(message.roomId)) return send(sink, {type: 'reject', reason: 'room'});
        const roomId = canonicalRoomId(message.roomId);
        player.lastSeen = now;
        const instance = instances.get(player.instanceId);
        if (Number.isFinite(Number(message.x)) && Number.isFinite(Number(message.y))) {
            const point = stepPosition(
                player,
                {...message, teleport: true},
                now,
                runtimeLimits,
                boundsFor(catalog, roomId),
            );
            if (point) {
                player.x = point.x;
                player.y = point.y;
            }
        }
        if (player.roomId === roomId) {
            send(sink, {type: 'entered', instanceId: player.instanceId, roomId, live: instance.rooms.has(roomId)});
            return;
        }
        const second = Math.floor(now / 1000);
        if (player.roomSecond !== second) {
            player.roomSecond = second;
            player.roomChanges = 0;
        }
        if (player.roomChanges >= 8) return send(sink, {type: 'reject', reason: 'room-rate'});
        player.roomChanges += 1;
        detach(instance, player);
        attach(instance, player, roomId);
    }

    function leaveRoom(sink, message, now) {
        const player = requirePlayer(sink);
        if (!player || !player.roomId) return;
        player.lastSeen = now;
        const instance = instances.get(player.instanceId);
        detach(instance, player);
        send(sink, {type: 'leftRoom', instanceId: player.instanceId});
        void message;
    }

    function appear(sink, message, now) {
        const player = requirePlayer(sink);
        if (!player) return;
        player.lastSeen = now;
        const appearance = parseAppearance(message.appearance, runtimeLimits);
        if (!appearance.ok) return send(sink, {type: 'reject', reason: appearance.error});
        if (now - (player.lastAppearAt ?? -Infinity) < runtimeLimits.moveIntervalMs) {
            send(sink, {type: 'appearDropped'});
            return;
        }
        player.lastAppearAt = now;
        player.appearance = appearance.appearance;
        player.revision += 1;
        const notice = {type: 'appear', id: player.id, appearance: player.appearance, revision: player.revision};
        send(sink, {...notice, self: true});
        const room = instances.get(player.instanceId)?.rooms.get(player.roomId);
        if (!room) return;
        for (const other of room.members) {
            if (other !== player) send(other.sink, notice);
        }
    }

    function playerJson(player) {
        return `{"id":"${player.id}","x":${player.x},"y":${player.y},"facing":${player.facing},"seq":${player.seq}}`;
    }

    function snapshot(player) {
        return {id: player.id, x: player.x, y: player.y, facing: player.facing, seq: player.seq};
    }

    function diagonal(members) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const player of members) {
            if (player.x < minX) minX = player.x;
            if (player.y < minY) minY = player.y;
            if (player.x > maxX) maxX = player.x;
            if (player.y > maxY) maxY = player.y;
        }
        return Math.hypot(maxX - minX, maxY - minY);
    }

    function noteFrame(frame, accepted) {
        if (!accepted) {
            relayStats.dropped += 1;
            return;
        }
        relayStats.frames += 1;
        relayStats.bytes += frame.length;
    }

    // Nearby whole rooms share one encoded frame. Spread rooms only search the cells that can see this tick.
    function deliverShared(members, tick, roster) {
        const first = members.values().next().value;
        if (!first) return;
        relayStats.shared += 1;
        if (typeof first.sink.sendFrame !== 'function') {
            const players = [];
            for (const player of members) players.push(snapshot(player));
            const message = {type: 'relay', tick, players};
            if (roster) message.roster = roster;
            for (const player of members) send(player.sink, message);
            relayStats.frames += members.size;
            return;
        }
        const chunks = ['{"type":"relay","tick":', String(tick), ',"players":['];
        let comma = false;
        for (const player of members) {
            if (comma) chunks.push(',');
            comma = true;
            chunks.push(playerJson(player));
        }
        chunks.push(']');
        if (roster) {
            chunks.push(',"roster":');
            chunks.push(JSON.stringify(roster));
        }
        chunks.push('}');
        const frame = encodeTextFrame(chunks.join(''));
        for (const player of members) noteFrame(frame, player.sink.sendFrame(frame) !== false);
    }

    function deliverDirect(player, tick, updates) {
        if (updates.length === 0) return;
        relayStats.direct += 1;
        if (typeof player.sink.sendFrame !== 'function') {
            const players = [];
            for (const other of updates) players.push(snapshot(other));
            send(player.sink, {type: 'relay', tick, players});
            relayStats.frames += 1;
            return;
        }
        const chunks = ['{"type":"relay","tick":', String(tick), ',"players":['];
        for (let index = 0; index < updates.length; index += 1) {
            if (index) chunks.push(',');
            chunks.push(playerJson(updates[index]));
        }
        chunks.push(']}');
        const frame = encodeTextFrame(chunks.join(''));
        noteFrame(frame, player.sink.sendFrame(frame) !== false);
    }

    function deliverGroup(recipients, updates, tick) {
        if (updates.length === 0 || recipients.length === 0) return;
        relayStats.direct += 1;
        const first = recipients[0];
        if (typeof first.sink.sendFrame !== 'function') {
            const players = [];
            for (const other of updates) players.push(snapshot(other));
            const message = {type: 'relay', tick, players};
            for (const player of recipients) send(player.sink, message);
            relayStats.frames += recipients.length;
            return;
        }
        const chunks = ['{"type":"relay","tick":', String(tick), ',"players":['];
        for (let index = 0; index < updates.length; index += 1) {
            if (index) chunks.push(',');
            chunks.push(playerJson(updates[index]));
        }
        chunks.push(']}');
        const frame = encodeTextFrame(chunks.join(''));
        for (const player of recipients) noteFrame(frame, player.sink.sendFrame(frame) !== false);
    }

    // Players who share a map cell share one capped frame. A crowd does not encode one frame per person.
    function deliverPacked(members, tick) {
        const cell = 100;
        const cap = runtimeLimits.relayCap;
        const list = [];
        const grid = new Map();
        let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
        for (const player of members) {
            list.push(player);
            const cx = Math.floor(player.x / cell), cy = Math.floor(player.y / cell);
            minCx = Math.min(minCx, cx); maxCx = Math.max(maxCx, cx);
            minCy = Math.min(minCy, cy); maxCy = Math.max(maxCy, cy);
            const key = `${cx}:${cy}`;
            let bucket = grid.get(key);
            if (!bucket) grid.set(key, bucket = []);
            bucket.push(player);
        }
        const headSlots = Math.ceil(cap * 0.75);
        const tailSlots = cap - headSlots;
        for (const [key, bucket] of grid) {
            const [cx, cy] = key.split(':').map(Number);
            const gathered = [];
            // Expand by rings instead of re-reading the entire square at every
            // radius. Empty rows/columns beyond the occupied bounds need no lookup.
            for (let radius = 0; radius <= 8; radius += 1) {
                gatherCellRing(grid, cx, cy, radius, minCx, maxCx, minCy, maxCy, gathered);
                if (radius >= 1 && gathered.length >= cap) break;
            }
            const origin = bucket[0];
            const ranked = [];
            for (const other of gathered) {
                ranked.push({other, distance: Math.hypot(other.x - origin.x, other.y - origin.y)});
            }
            ranked.sort((a, b) => a.distance - b.distance || (a.other.id < b.other.id ? -1 : 1));
            const seen = new Set();
            const updates = [];
            const head = Math.min(headSlots, ranked.length);
            for (let index = 0; index < head; index += 1) {
                seen.add(ranked[index].other);
                updates.push(ranked[index].other);
            }
            if (tailSlots > 0) {
                const offset = (tick * tailSlots) % list.length;
                for (let index = 0; index < list.length && updates.length < head + tailSlots; index += 1) {
                    const other = list[(offset + index) % list.length];
                    if (seen.has(other)) continue;
                    seen.add(other);
                    updates.push(other);
                }
            }
            deliverGroup(bucket, updates, tick);
        }
    }

    function gatherCellRing(grid, cx, cy, radius, minCx, maxCx, minCy, maxCy, found) {
        for (let x = Math.max(minCx, cx - radius); x <= Math.min(maxCx, cx + radius); x += 1) {
            for (let y = Math.max(minCy, cy - radius); y <= Math.min(maxCy, cy + radius); y += 1) {
                if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== radius) continue;
                const bucket = grid.get(`${x}:${y}`);
                if (!bucket) continue;
                for (const player of bucket) found.push(player);
            }
        }
    }

    function relayRoom(instance, tick) {
        const farTick = tick % runtimeLimits.farEvery === 0;
        const midTick = tick % runtimeLimits.midEvery === 0;
        const cell = runtimeLimits.nearDistance;
        for (const room of instance.rooms.values()) {
            const members = room.members;
            if (members.size < 2) continue;
            const span = diagonal(members);
            const allVisible = farTick
                || (midTick && span <= runtimeLimits.midDistance)
                || span < runtimeLimits.nearDistance;
            if (allVisible && members.size - 1 <= runtimeLimits.relayCap) {
                deliverShared(members, tick, farTick ? rosterFrom(members) : null);
                continue;
            }
            if (allVisible) {
                deliverPacked(members, tick);
                continue;
            }
            const grid = new Map();
            const list = [];
            for (const player of members) {
                list.push(player);
                const key = `${Math.floor(player.x / cell)}:${Math.floor(player.y / cell)}`;
                let bucket = grid.get(key);
                if (!bucket) grid.set(key, bucket = []);
                bucket.push(player);
            }
            const reach = midTick ? runtimeLimits.midDistance : runtimeLimits.nearDistance;
            const radius = Math.max(1, Math.ceil(reach / cell));
            for (const player of list) {
                const cx = Math.floor(player.x / cell);
                const cy = Math.floor(player.y / cell);
                const updates = [];
                for (let dx = -radius; dx <= radius; dx += 1) {
                    for (let dy = -radius; dy <= radius; dy += 1) {
                        const bucket = grid.get(`${cx + dx}:${cy + dy}`);
                        if (!bucket) continue;
                        for (const other of bucket) {
                            if (other === player) continue;
                            const distance = Math.hypot(other.x - player.x, other.y - player.y);
                            if (tick % bandEvery(distance, runtimeLimits) !== 0) continue;
                            updates.push(other);
                        }
                    }
                }
                deliverDirect(player, tick, takeCapped(player, updates, tick));
            }
        }
    }

    // A packed room cannot ship every neighbor every second. Keep the nearest players,
    // and rotate the rest through the remaining slots so nobody disappears permanently.
    function takeCapped(player, others, tick) {
        const cap = runtimeLimits.relayCap;
        const ranked = [];
        for (const other of others) {
            if (other === player) continue;
            const distance = Math.hypot(other.x - player.x, other.y - player.y);
            if (tick % bandEvery(distance, runtimeLimits) !== 0) continue;
            ranked.push({other, distance});
        }
        if (ranked.length <= cap) {
            const updates = [];
            for (const item of ranked) updates.push(item.other);
            return updates;
        }
        ranked.sort((a, b) => a.distance - b.distance || (a.other.id < b.other.id ? -1 : 1));
        const head = Math.min(ranked.length, Math.ceil(cap * 0.75));
        const tailSlots = cap - head;
        const updates = [];
        for (let index = 0; index < head; index += 1) updates.push(ranked[index].other);
        const overflow = ranked.length - head;
        if (tailSlots > 0 && overflow > 0) {
            const offset = (tick * tailSlots) % overflow;
            for (let index = 0; index < tailSlots; index += 1) {
                updates.push(ranked[head + ((offset + index) % overflow)].other);
            }
        }
        return updates;
    }

    function migratePlayer(player, toInstanceId, reason) {
        const from = instances.get(player.instanceId);
        const to = open(toInstanceId);
        if (!from || from.id === to.id) return;
        const roomId = player.roomId;
        detach(from, player, reason);
        from.players.delete(player.id);
        player.instanceId = to.id;
        to.players.set(player.id, player);
        send(player.sink, {type: 'migrate', instanceId: to.id, roomId, reason});
        if (roomId) attach(to, player, roomId);
    }

    return {
        machineId,
        limits: runtimeLimits,
        open,
        stats() {
            let players = 0;
            let liveRooms = 0;
            for (const instance of instances.values()) {
                players += instance.players.size;
                liveRooms += instance.rooms.size;
            }
            return {
                players,
                liveRooms,
                instances: instances.size,
                relay: {...relayStats},
            };
        },
        liveRooms(instanceId) {
            const instance = instances.get(instanceId);
            return instance ? [...instance.rooms.keys()] : [];
        },
        instanceOf(playerId) {
            return byPlayer.get(playerId)?.instanceId ?? null;
        },
        player(playerId) {
            const player = byPlayer.get(playerId);
            if (!player) return null;
            return {
                id: player.id,
                name: player.name,
                appearance: player.appearance,
                revision: player.revision,
                roomId: player.roomId,
                x: player.x,
                y: player.y,
                facing: player.facing,
                instanceId: player.instanceId,
                sink: player.sink,
            };
        },
        handle(sink, message, now) {
            if (!message || typeof message !== 'object') return send(sink, {type: 'reject', reason: 'message'});
            if (message.type === 'hello') return hello(sink, message, now);
            if (message.type === 'move') return move(sink, message, now);
            if (message.type === 'enterRoom') return enterRoom(sink, message, now);
            if (message.type === 'leaveRoom') return leaveRoom(sink, message, now);
            if (message.type === 'appear') return appear(sink, message, now);
            send(sink, {type: 'reject', reason: 'message'});
        },
        disconnect(sink, reason = 'disconnect') {
            if (sink?.replaced) return;
            if (sink?.playerId) remove(sink.playerId, reason);
        },
        relay(now) {
            void now;
            const started = performance.now();
            for (const instance of instances.values()) {
                instance.relayTick += 1;
                relayRoom(instance, instance.relayTick);
            }
            relayStats.lastMs = performance.now() - started;
        },
        expire(now) {
            for (const player of [...byPlayer.values()]) {
                if (now - player.lastSeen < runtimeLimits.clientTimeoutMs) continue;
                send(player.sink, {type: 'reject', reason: 'timeout'});
                player.sink.close?.();
                remove(player.id, 'timeout');
            }
        },
        apply(commands) {
            for (const command of commands || []) {
                if (command.type === 'open') open(command.instanceId);
                else if (command.type === 'notice') {
                    for (const instanceId of command.instanceIds || []) {
                        const instance = instances.get(instanceId);
                        if (!instance) continue;
                        for (const player of instance.players.values()) {
                            send(player.sink, {
                                type: 'notice',
                                action: command.action,
                                inSeconds: command.inSeconds,
                                text: command.text || NOTICE[command.action] || '',
                            });
                        }
                    }
                } else if (command.type === 'migrate') {
                    for (const moveCommand of command.moves || []) {
                        const player = byPlayer.get(moveCommand.playerId);
                        if (!player) continue;
                        migratePlayer(player, moveCommand.toInstanceId, command.reason);
                    }
                } else if (command.type === 'close') {
                    const instance = instances.get(command.instanceId);
                    if (instance && instance.players.size === 0) instances.delete(command.instanceId);
                }
            }
        },
        report(advertiseUrl) {
            const list = [];
            for (const instance of [...instances.values()].sort((a, b) => a.id - b.id)) {
                const rooms = new Map();
                for (const player of instance.players.values()) {
                    if (!player.roomId) continue;
                    if (!rooms.has(player.roomId)) rooms.set(player.roomId, new Map());
                    const key = regionKey(player.x, player.y, runtimeLimits.regionSize);
                    const buckets = rooms.get(player.roomId);
                    if (!buckets.has(key)) buckets.set(key, []);
                    buckets.get(key).push(player.id);
                }
                list.push({
                    id: instance.id,
                    rooms: [...rooms.entries()].map(([id, buckets]) => ({
                        id,
                        count: [...buckets.values()].reduce((sum, ids) => sum + ids.length, 0),
                        buckets: [...buckets.entries()].map(([key, playerIds]) => ({
                            key,
                            count: playerIds.length,
                            playerIds,
                        })),
                    })),
                });
            }
            return {machineId, advertiseUrl, instances: list};
        },
    };
}
