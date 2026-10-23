const tokenInput = document.querySelector('#token');
const pauseButton = document.querySelector('#pause');
const summary = document.querySelector('#summary');
const machines = document.querySelector('#machines');
const history = document.querySelector('#history');
tokenInput.value = sessionStorage.getItem('presence-admin-token') || '';

function headers() {
    const headers = {'content-type': 'application/json'};
    if (tokenInput.value) headers['x-admin-token'] = tokenInput.value;
    return headers;
}

async function post(body) {
    sessionStorage.setItem('presence-admin-token', tokenInput.value);
    const response = await fetch('/api/admin/action', {method: 'POST', headers: headers(), body: JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) window.alert(data.error || '操作没有执行');
    await refresh();
}

function line(text) {
    const node = document.createElement('strong');
    node.textContent = text;
    return node;
}

function button(label, className, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    if (className) node.className = className;
    node.addEventListener('click', onClick);
    return node;
}

function render(state) {
    summary.replaceChildren();
    const players = state.machines.reduce((sum, machine) => sum + machine.playerCount, 0);
    const instances = state.machines.reduce((sum, machine) => sum + machine.instances.length, 0);
    for (const text of [
        `机器 ${state.machines.length}`,
        `实例 ${instances}`,
        `在线 ${players}`,
        `单实例上限 ${state.limits.instanceMax}`,
        `单服上限 ${state.limits.serverMax ?? 8000}`,
        state.paused ? '自动平衡已暂停' : '自动平衡开启',
    ]) {
        const card = document.createElement('div');
        card.className = 'card';
        card.append(line(text));
        summary.append(card);
    }
    pauseButton.textContent = state.paused ? '恢复自动平衡' : '暂停自动平衡';
    pauseButton.onclick = () => post({op: 'pause', paused: !state.paused});

    machines.replaceChildren();
    for (const room of state.privateRooms || []) {
        const section = document.createElement('section'); section.className = 'machine card';
        section.append(line(`私有房间 · ${room.ownerUsername} · ${room.count} 个客户端`));
        machines.append(section);
    }
    if (!state.machines.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = '还没有游戏服注册。';
        machines.append(empty);
    }
    for (const machine of state.machines) {
        const section = document.createElement('section');
        section.className = 'machine card';
        const head = document.createElement('div');
        head.className = 'machine-head';
        const title = document.createElement('h2');
        title.textContent = `${machine.id} · ${machine.playerCount} 人`;
        const url = document.createElement('span');
        url.textContent = machine.advertiseUrl;
        head.append(title, url);
        section.append(head);

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const label of ['实例', '人数', '房间', '操作']) {
            const cell = document.createElement('th');
            cell.textContent = label;
            headRow.append(cell);
        }
        thead.append(headRow);
        const tbody = document.createElement('tbody');
        for (const instance of machine.instances) {
            const row = document.createElement('tr');
            const idCell = document.createElement('td');
            idCell.textContent = String(instance.id);
            const countCell = document.createElement('td');
            countCell.textContent = String(instance.playerCount);
            const roomCell = document.createElement('td');
            roomCell.textContent = instance.rooms.map(room => `${room.id} ${room.count}`).join('，') || '空';
            const actionCell = document.createElement('td');
            actionCell.append(
                button('拆分', 'quiet', () => post({op: 'split', machineId: machine.id, instanceId: instance.id})),
                button('清空', 'quiet', () => post({op: 'drain', machineId: machine.id, instanceId: instance.id})),
            );
            row.append(idCell, countCell, roomCell, actionCell);
            tbody.append(row);
        }
        table.append(thead, tbody);
        section.append(table);

        const merge = document.createElement('div');
        merge.className = 'row';
        const from = document.createElement('input');
        from.placeholder = '并出实例';
        from.inputMode = 'numeric';
        const to = document.createElement('input');
        to.placeholder = '并入实例';
        to.inputMode = 'numeric';
        merge.append(from, to, button('合并', '', () => post({
            op: 'merge',
            machineId: machine.id,
            fromId: Number(from.value),
            toId: Number(to.value),
        })));
        section.append(merge);
        machines.append(section);
    }

    history.replaceChildren();
    if (!state.lastBalance.length) {
        const item = document.createElement('li');
        item.className = 'empty';
        item.textContent = '还没有自动或手动平衡。';
        history.append(item);
    }
    for (const entry of state.lastBalance) {
        const item = document.createElement('li');
        const when = new Date(entry.at);
        item.textContent = `${Number.isNaN(when.getTime()) ? entry.at : when.toLocaleString()} ${entry.machineId} ${entry.kind} ${entry.text}`;
        history.append(item);
    }
}

async function refresh() {
    const response = await fetch('/api/admin/state', {cache: 'no-store', headers: headers()});
    render(await response.json());
}

document.querySelector('#add-server').addEventListener('click', () => post({op: 'add-server'}));
document.querySelector('#refresh').addEventListener('click', refresh);
tokenInput.addEventListener('change', () => sessionStorage.setItem('presence-admin-token', tokenInput.value));
refresh();
setInterval(refresh, 2000);

document.querySelector('#load-report').addEventListener('click', async () => {
    const output = document.querySelector('#report-summary');
    const canvas = document.querySelector('#online-chart');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const percent = n => n == null ? '暂无基数' : `${(n * 100).toFixed(1)}%`;
    try {
        const date = document.querySelector('#report-date').value || 'today';
        const response = await fetch(`/api/admin/report?date=${encodeURIComponent(date)}`, {headers: headers()});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        const m = data.metrics;
        output.replaceChildren();
        for (const text of [
            `最后采样：${data.lastSampleAt ? new Date(data.lastSampleAt).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) : '未知'}（北京时间）`,
            `${data.date}：活跃账号 ${m.active}，首次观测 ${m.newUsers}，采样峰值 ${m.peak ?? '未知'}，平均在线 ${m.average?.toFixed(1) ?? '未知'}`,
            `与前一天比较：${percent(data.previousDay.activeChange)}；与上周同日比较：${percent(data.previousWeek.activeChange)}（活跃账号变化）`,
            `次日留存：${percent(data.retention1.rate)}（${data.retention1.returned ?? '未知'}/${data.retention1.cohort ?? '未知'}）；7 日留存：${percent(data.retention7.rate)}（${data.retention7.returned ?? '未知'}/${data.retention7.cohort ?? '未知'}）`,
            `全天采样覆盖 ${percent(m.coverage)}，丢弃入场记录 ${m.dropped}。不足全天或存在丢弃时，活跃和留存可能低估。首次观测不等于新注册。`,
        ]) { const p = document.createElement('p'); p.textContent = text; output.append(p); }
        const max = Math.max(1, ...data.online.filter(n => n !== null));
        ctx.fillStyle = '#64748b'; ctx.fillText(String(max), 0, 16); ctx.fillText('0', 0, 220);
        ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.beginPath();
        let connected = false;
        data.online.forEach((value, index) => {
            if (value === null) { connected = false; return; }
            const x = 30 + index / 1439 * 920, y = 220 - value / max * 200;
            if (connected) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            ctx.fillRect(x, y, 2, 2); connected = true;
        });
        ctx.stroke();
    } catch (error) { output.textContent = error.message || '日报加载失败'; }
});
