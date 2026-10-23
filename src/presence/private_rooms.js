import {createHash} from 'node:crypto';

export const REMOTE_CHANNEL = 'account.relay.v1';
export const privateRoomId = (username, project) => `account:private:${createHash('sha256').update(JSON.stringify([project, username])).digest('hex').slice(0, 48)}`;

// Shared by all world instances in this gateway process. Private clients never
// enter the public spatial simulation, reports, migration or discovery stream.
export function createPrivateRooms() {
    const rooms = new Map();
    const notify = room => {
        const clients = [...room.clients.values()].map(c => ({id: c.identity.playerId, ...c.metadata}));
        for (const client of room.clients.values()) client.sink.send({type: 'privateMembers', clients});
    };
    return {
        list() { return [...rooms.values()].map(({id, ownerUsername, clients}) => ({id, visibility: 'private', ownerUsername, count: clients.size})); },
        connect(identity, sink) {
            const id = privateRoomId(identity.username, identity.project);
            if (identity.roomType !== 'account' || identity.roomId !== id || identity.ownerUsername !== identity.username || identity.visibility !== 'private') throw Error('private-room-forbidden');
            let room = rooms.get(id);
            if (!room) { room = {id, ownerUsername: identity.username, clients: new Map()}; rooms.set(id, room); }
            const client = {identity, sink, metadata: {name: 'Client', device: ''}};
            room.clients.set(identity.playerId, client);
            sink.send({type: 'welcome', self: {id: identity.playerId}, room: {id, visibility: 'private', ownerUsername: identity.username}, capabilities: [REMOTE_CHANNEL]});
            notify(room);
            return {
                handle(message) {
                    if (room.clients.get(identity.playerId) !== client) throw Error('private-room-forbidden');
                    if (message.type === 'move' || message.type === 'ping') { sink.send({type: 'pong'}); return; }
                    if (message.type === 'clientMetadata') {
                        client.metadata = {name: String(message.name || 'Client').slice(0, 80), device: String(message.device || '').slice(0, 80),
                            clientId: typeof message.clientId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(message.clientId) ? message.clientId : identity.playerId};
                        notify(room); return;
                    }
                    if (message.type !== REMOTE_CHANNEL || typeof message.requestId !== 'string' || message.requestId.length > 100) throw Error('private-protocol');
                    const target = room.clients.get(message.to);
                    if (!target || target === client || target.identity.username !== identity.username) throw Error('target-unavailable');
                    // No caller-supplied identity, room or extra envelope fields survive.
                    const frame = {type: REMOTE_CHANNEL, requestId: message.requestId,
                        from: identity.playerId, to: target.identity.playerId, payload: message.payload};
                    if (Buffer.byteLength(JSON.stringify(frame)) > 15 * 1024) throw Error('payload-too-large');
                    target.sink.send(frame);
                },
                close() {
                    if (room.clients.get(identity.playerId) !== client) return;
                    room.clients.delete(identity.playerId);
                    if (!room.clients.size) rooms.delete(id); else notify(room);
                },
            };
        },
    };
}
