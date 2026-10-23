export const DAY = 86400000;
export const dayOf = at => new Date(at + 28800000).toISOString().slice(0, 10);
export const shiftDay = (day, offset) => dayOf(Date.parse(`${day}T00:00:00+08:00`) + offset * DAY);
export function ingest(state, batch, hash) {
    const get = day => state.days[day] ||= {users: [], samples: {}, dropped: 0};
    const today = dayOf(batch.at);
    const day = get(today);
    const online = [...new Set(batch.online.map(hash))];
    const minute = Math.floor((batch.at + 28800000) % DAY / 60000);
    day.samples[minute] = online.length;
    day.lastSampleAt = batch.at;
    day.dropped += batch.dropped;
    const userSets = new Map();
    for (const visit of [...batch.visits, ...batch.online.map(key => ({key, at: batch.at}))]) {
        const date = dayOf(visit.at), id = hash(visit.key);
        if (!state.first[id] || date < state.first[id]) state.first[id] = date;
        const entry = get(date);
        if (!userSets.has(date)) userSets.set(date, new Set(entry.users));
        userSets.get(date).add(id);
    }
    for (const [date, users] of userSets) state.days[date].users = [...users];
    for (const date of Object.keys(state.days)) if (date < shiftDay(today, -90)) delete state.days[date];
}
export function report(state, date) {
    const metrics = day => {
        const value = state.days[day];
        if (!value) return null;
        const counts = Object.values(value.samples);
        return {active: value.users.length, newUsers: value.users.filter(id => state.first[id] === day).length,
            peak: counts.length ? Math.max(...counts) : null,
            average: counts.length ? counts.reduce((a,b) => a+b, 0) / counts.length : null,
            sampledMinutes: counts.length, coverage: counts.length / 1440, dropped: value.dropped};
    };
    const current = metrics(date);
    if (!current) return null;
    const comparison = offset => {
        const baseline = metrics(shiftDay(date, offset));
        return {date: shiftDay(date, offset), metrics: baseline,
            activeChange: baseline?.active ? (current.active - baseline.active) / baseline.active : null};
    };
    const retention = age => {
        const cohortDate = shiftDay(date, -age), cohortDay = state.days[cohortDate];
        if (!cohortDay) return {cohortDate, cohort: null, returned: null, rate: null};
        const cohort = cohortDay.users.filter(id => state.first[id] === cohortDate);
        const active = new Set(state.days[date].users);
        const returned = cohort.filter(id => active.has(id)).length;
        return {cohortDate, cohort: cohort.length, returned, rate: cohort.length ? returned / cohort.length : null};
    };
    return {date, lastSampleAt: state.days[date].lastSampleAt ?? null, timezone: 'Asia/Shanghai', metrics: current, previousDay: comparison(-1), previousWeek: comparison(-7),
        retention1: retention(1), retention7: retention(7),
        online: Array.from({length: 1440}, (_, minute) => state.days[date].samples[minute] ?? null)};
}
