// Linear blend between the last two relay samples. The sender only moves once a second.
export function smoothPosition(samples, now) {
    if (!samples?.length) return null;
    const next = samples[samples.length - 1];
    if (samples.length === 1 || now >= next.at) return {x: next.x, y: next.y, facing: next.facing};
    const prev = samples[samples.length - 2];
    const span = Math.max(1, next.at - prev.at);
    const t = Math.min(1, Math.max(0, (now - prev.at) / span));
    return {
        x: prev.x + (next.x - prev.x) * t,
        y: prev.y + (next.y - prev.y) * t,
        facing: t >= 1 ? next.facing : prev.facing,
    };
}
