// Namespace conventions prevent accidental collisions, not hostile impersonation.
export const PROJECTS = Object.freeze({
    haqi: 'haqi',
    aiWorkCompany: 'awc',
    aiChat: 'aichat',
});

export function presenceIdentity(project, playerId, roomId) {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(project)) throw new Error('invalid project');
    if (typeof playerId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(playerId)) throw new Error('invalid playerId');
    if (typeof roomId !== 'string' || !roomId.trim() || /[\u0000-\u001f\u007f]/.test(roomId)) throw new Error('invalid roomId');
    const identity = {playerId: `${project}_${playerId}`, roomId: `${project}:${roomId.trim()}`};
    if (identity.playerId.length > 64 || identity.roomId.length > 64) throw new Error('identity too long');
    return identity;
}
