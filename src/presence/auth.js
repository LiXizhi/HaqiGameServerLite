import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {createPrivateRooms, privateRoomId} from './private_rooms.js';

export const MAX_ACCOUNT_CONNECTIONS = 10;

export class AuthError extends Error {
    constructor(code, status = 401) { super(code); this.status = status; }
}

// Keepwork SDK core/getUserProfile: GET /core/v0/users/profile, Bearer token.
// Never accept an API URL from a caller or forward credentials on redirects.
export function createAuthentication({fetchImpl = fetch, now = Date.now,
    secret = randomBytes(32), ticketMs = 60000, coordinationDirectory = process.env.KEEPWORK_COORDINATION_DIR,
    profileURL = process.env.PRESENCE_AUTH_PROFILE_URL || 'https://api.keepwork.com/core/v0/users/profile'} = {}) {
    const verifier = new URL(profileURL);
    if (verifier.username || verifier.password || verifier.hash || (verifier.protocol !== 'https:' && !(verifier.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(verifier.hostname)))) throw new Error('invalid-auth-profile-url');
    const used = new Map();
    // Shared by every world server spawned in this gateway process. Count verified
    // accounts across projects/roles/tokens, never IPs or client-supplied player IDs.
    const sessions = new Map();
    const roles = new Map();
    const sign = text => createHmac('sha256', secret).update(text).digest();
    return {
        privateRooms: createPrivateRooms({coordinationDirectory}),
        async verify(header, body) {
            if (typeof header !== 'string' || !/^Bearer [^\s]{1,8192}$/.test(header)) throw new AuthError('auth-required');
            if (typeof body.username !== 'string' || !body.username || body.username.length > 128) throw new AuthError('username-required');
            if (body.roomType !== undefined && body.roomType !== 'account') throw new AuthError('room-type', 400);
            const accountRoom = body.roomType === 'account';
            if (accountRoom ? (typeof body.project !== 'string' || !/^[A-Za-z0-9_-]{1,23}$/.test(body.project)) : !['haqi', 'awc'].includes(body.project)) throw new AuthError('project', 400);
            if (typeof body.roleId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.roleId)) throw new AuthError('role', 400);
            if (!accountRoom && (body.visibility === 'private' || typeof body.roomId !== 'string' || !body.roomId.startsWith(`${body.project}:`))) throw new AuthError('room', 400);
            let response, profile;
            try {
                response = await fetchImpl(verifier.href, {
                    headers: {Authorization: header, Accept: 'application/json'},
                    redirect: 'error', signal: AbortSignal.timeout(8000),
                });
                if (response.status === 401 || response.status === 403) throw new AuthError('token-invalid');
                if (!response.ok) throw new AuthError('auth-unavailable', 503);
                profile = await response.json();
            } catch (error) {
                if (error instanceof AuthError) throw error;
                throw new AuthError('auth-unavailable', 503);
            }
            if (typeof profile?.username !== 'string' || profile.username !== body.username) throw new AuthError('username-mismatch');
            const privateRoom = accountRoom ? {roomType: 'account', roomId: privateRoomId(profile.username, body.project), visibility: 'private', ownerUsername: profile.username} : {};
            if (accountRoom && ((body.roomId !== undefined && body.roomId !== 'account' && body.roomId !== privateRoom.roomId)
                || (body.visibility !== undefined && body.visibility !== 'private')
                || (body.ownerUsername !== undefined && body.ownerUsername !== profile.username))) throw new AuthError('private-room-forbidden', 403);
            // Each verified join has a distinct connection ID. Haqi role ownership
            // transfers only after a valid world admission.
            return {...privateRoom, username: profile.username, project: body.project, roleId: body.roleId,
                playerId: `${body.project}_${randomBytes(20).toString('hex')}`};
        },
        openSession(identity, onReplace = () => {}) {
            if (typeof identity?.username !== 'string' || !identity.username) throw new AuthError('auth-required');
            const account = identity.username;
            const roleKey = identity.roomType !== 'account' && identity.project === 'haqi' && identity.roleId && identity.roleId !== 'lobby'
                ? JSON.stringify([account, identity.project, identity.roleId]) : null;
            const previous = roleKey && roles.get(roleKey);

            const count = sessions.get(account) || 0;
            if (count - (previous ? 1 : 0) >= MAX_ACCOUNT_CONNECTIONS) throw new AuthError('account-connection-limit', 429);
            // Synchronous admission prevents simultaneous hellos from exceeding ten.
            sessions.set(account, count + 1);
            let released = false;
            const entry = {onReplace, release: null};
            const release = () => {
                if (released) return;
                released = true;
                if (roleKey && roles.get(roleKey) === entry) roles.delete(roleKey);
                const remaining = (sessions.get(account) || 1) - 1;
                if (remaining) sessions.set(account, remaining);
                else sessions.delete(account);
            };
            entry.release = release;
            release.activate = () => {
                if (released || !roleKey) return;
                const old = roles.get(roleKey);
                if (old && old !== entry) { old.release(); old.onReplace(); }
                roles.set(roleKey, entry);
            };
            return release;
        },
        issue(identity, assignment, roomId) {
            const claims = {...identity, instanceId: assignment.instanceId, roomId,
                expires: now() + ticketMs, nonce: randomBytes(16).toString('hex')};
            const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
            return `${payload}.${sign(payload).toString('base64url')}`;
        },
        consume(ticket, hello) {
            if (typeof ticket !== 'string' || ticket.length > 4096) throw new AuthError('ticket-invalid');
            const parts = ticket.split('.');
            if (parts.length !== 2) throw new AuthError('ticket-invalid');
            const signature = Buffer.from(parts[1], 'base64url'), expected = sign(parts[0]);
            if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new AuthError('ticket-invalid');
            let claims;
            try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { throw new AuthError('ticket-invalid'); }
            for (const [nonce, expiry] of used) if (expiry <= now()) used.delete(nonce);
            if (!Number.isFinite(claims.expires) || claims.expires <= now() || used.has(claims.nonce)
                || claims.playerId !== hello.playerId || claims.roomId !== hello.roomId
                || claims.instanceId !== hello.instanceId) throw new AuthError('ticket-invalid');
            used.set(claims.nonce, claims.expires);
            return claims;
        },
    };
}
