const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Manager, probe, systemInfo, HLS_DIR } = require('./manager');

const PORT = Number(process.env.PORT) || 3000;
// Local tool that can spawn processes and read files: bind to loopback unless told otherwise.
const HOST = process.env.HOST || '127.0.0.1';

const manager = new Manager();
const app = express();
app.use(express.json({ limit: '256kb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 400).json({ error: e.message }));

app.get('/api/system', wrap(async (_req, res) => res.json(await systemInfo())));
app.get('/api/streams', wrap((_req, res) => res.json(manager.list())));
app.post('/api/streams', wrap(async (req, res) => res.status(201).json(await manager.create(req.body))));
app.put('/api/streams/:id', wrap(async (req, res) => res.json(await manager.update(req.params.id, req.body))));
app.delete('/api/streams/:id', wrap(async (req, res) => { await manager.remove(req.params.id); res.status(204).end(); }));
app.post('/api/streams/:id/start', wrap((req, res) => { manager.get(req.params.id).start(); res.json({ ok: true }); }));
app.post('/api/streams/:id/stop', wrap(async (req, res) => { await manager.get(req.params.id).stop(); res.json({ ok: true }); }));
app.get('/api/streams/:id/logs', wrap((req, res) => res.json(manager.get(req.params.id).logs)));
app.post('/api/probe', wrap(async (req, res) => res.json(await probe(req.body || {}))));

app.use('/hls', express.static(HLS_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));
app.use('/vendor/hls.js', express.static(path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js')));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function tick() {
  if (!wss.clients.size) {
    for (const r of manager.runners.values()) r.drainLogs();
    return;
  }
  const logs = {};
  for (const [id, r] of manager.runners) {
    const l = r.drainLogs();
    if (l.length) logs[id] = l;
  }
  const msg = JSON.stringify({ type: 'state', streams: manager.list(), logs });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
setInterval(tick, 1000);

server.listen(PORT, HOST, () => {
  console.log(`restream.io running at http://${HOST}:${PORT}`);
  manager.autoStart();
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
