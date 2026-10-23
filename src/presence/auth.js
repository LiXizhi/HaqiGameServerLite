import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

export class AuthError extends Error {
    constructor(code, status = 401) { super(code); this.status = status; }
}

// Keepwork SDK core/getUserProfile: GET /core/v0/users/profile, Bearer token.
// Never accept an API URL from a caller or forward credentials on redirects.
export function createAuthentication({fetchImpl = fetch, now = Date.now,
    secret = randomBytes(32), ticketMs = 60000} = {}) {
    const used = new Map();
    const sign = text => createHmac('sha256', secret).update(text).digest();
    return {
        async verify(header, body) {
            if (typeof header !== 'string' || !/^Bearer [^\s]{1,8192}$/.test(header)) throw new AuthError('auth-required');
            if (typeof body.username !== 'string' || !body.username || body.username.length > 128) throw new AuthError('username-required');
            if (!['haqi', 'awc', 'aichat'].includes(body.project)) throw new AuthError('project', 400);
            if (typeof body.roleId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.roleId)) throw new AuthError('role', 400);
            if (typeof body.roomId !== 'string' || !body.roomId.startsWith(`${body.project}:`)) throw new AuthError('room', 400);
            let response, profile;
            try {
                response = await fetchImpl('https://api.keepwork.com/core/v0/users/profile', {
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
            const hash = createHash('sha256').update(JSON.stringify([profile.username, body.roleId])).digest('hex').slice(0, 40);
            return {username: profile.username, project: body.project, playerId: `${body.project}_${hash}`};
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
