const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const report = require('./report');
const { Manager, systemInfo, hlsStore, MEDIA_DIR, MEDIA_EXT } = require('./manager');

const PORT = Number(process.env.PORT) || 3000;
// Local tool that can spawn processes and read files: bind to loopback unless told otherwise.
const HOST = process.env.HOST || '127.0.0.1';

const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const authEnabled = !!(AUTH_USER && AUTH_PASS);

function authorized(header) {
  if (!authEnabled) return true;
  const m = /^Basic (.+)$/.exec(header || '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'base64').toString('utf8');
  const want = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
  const got = Buffer.from(given);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ffmpeg reaches the server over loopback, so the connect address must be loopback unless bound to one interface.
hlsStore.ingestBase = `http://${['0.0.0.0', '::', ''].includes(HOST) ? '127.0.0.1' : HOST}:${PORT}`;

const manager = new Manager();
const app = express();

// Preview upload from ffmpeg (HLS PUT). Guarded by a random per-run token instead of the login.
app.put('/ingest/:token/:id/:name', (req, res) => {
  const { token, id, name } = req.params;
  if (token !== hlsStore.token || !manager.runners.has(id) || !/^[\w.-]+\.(m3u8|ts)$/.test(name)) {
    return res.status(403).end();
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 32 * 1024 * 1024) return req.destroy();
    chunks.push(c);
  });
  req.on('end', () => {
    hlsStore.put(id, name, Buffer.concat(chunks));
    res.status(201).end();
  });
});

// Input-bitrate tap from ffmpeg: bytes are only counted, never stored.
app.put('/tap/:token/:id', (req, res) => {
  const runner = manager.runners.get(req.params.id);
  if (req.params.token !== hlsStore.token || !runner) return res.status(403).end();
  req.on('data', (c) => { runner.inBytes += c.length; });
  req.on('end', () => res.status(201).end());
});

app.use((req, res, next) => {
  if (authorized(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="restream"').status(401).send('Authentication required');
});
app.use(express.json({ limit: '256kb' }));

// Runs fn inside a promise so synchronous throws also become JSON errors (never an HTML page with a stack trace).
const wrap = (fn) => (req, res) =>
  Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(e.status || 400).json({ error: e.message }));

app.get('/api/system', wrap(async (_req, res) => res.json(await systemInfo())));
app.get('/api/streams', wrap((_req, res) => res.json(manager.list())));
app.post('/api/streams', wrap(async (req, res) => res.status(201).json(await manager.create(req.body))));
app.put('/api/streams/:id', wrap(async (req, res) => res.json(await manager.update(req.params.id, req.body))));
app.delete('/api/streams/:id', wrap(async (req, res) => { await manager.remove(req.params.id); res.status(204).end(); }));
app.post('/api/streams/:id/start', wrap((req, res) => { manager.get(req.params.id).start(); res.json({ ok: true }); }));
app.post('/api/streams/:id/stop', wrap(async (req, res) => { await manager.get(req.params.id).stop(); res.json({ ok: true }); }));
app.get('/api/streams/:id/logs', wrap((req, res) => res.json(manager.get(req.params.id).logs)));
app.get('/api/streams/:id/recordings', wrap((req, res) => res.json(manager.recordings(req.params.id))));
app.get('/api/streams/:id/recordings/:file', wrap((req, res) => res.download(manager.recordingPath(req.params.id, req.params.file))));
app.delete('/api/streams/:id/recordings/:file', wrap((req, res) => {
  fs.rmSync(manager.recordingPath(req.params.id, req.params.file));
  res.status(204).end();
}));
// Analytics report: standalone HTML page (shown in the dashboard and downloadable), JSON and CSV.
const reportFor = async (id) => report.build(manager.get(id), await systemInfo());
app.get('/api/streams/:id/report.html', wrap(async (req, res) => {
  const r = await reportFor(req.params.id);
  const download = req.query.download === '1';
  if (download) res.set('Content-Disposition', `attachment; filename="report-${r.stream.name.replace(/[^\w.-]+/g, '_')}.html"`);
  res.type('html').send(report.render(r, { download }));
}));
app.get('/api/streams/:id/report.json', wrap(async (req, res) => res.json(await reportFor(req.params.id))));
app.get('/api/streams/:id/report.csv', wrap((req, res) => {
  res.set('Content-Disposition', 'attachment; filename="samples.csv"').type('text/csv').send(report.csv(manager.get(req.params.id)));
}));
app.get('/api/media', wrap((_req, res) => res.json(manager.mediaList())));
app.delete('/api/media/:name', wrap((req, res) => { manager.mediaDelete(req.params.name); res.status(204).end(); }));
// Raw upload: the request body is the file. Written to a .part file first so a broken upload leaves nothing behind.
app.post('/api/media/:name', (req, res) => {
  const safe = path.basename(req.params.name).replace(/[^\w .()\-]+/g, '_');
  if (!MEDIA_EXT.test(safe)) return res.status(400).json({ error: 'Unsupported file type. Use mp4, mkv, mov, avi, ts, webm, m4v, flv, mpg or wmv.' });
  const ext = path.extname(safe);
  let name = safe, n = 1;
  while (fs.existsSync(path.join(MEDIA_DIR, name))) name = `${path.basename(safe, ext)}-${n++}${ext}`;
  const final = path.join(MEDIA_DIR, name);
  const tmp = `${final}.part`;
  const out = fs.createWriteStream(tmp);
  const fail = (msg) => { out.destroy(); fs.rmSync(tmp, { force: true }); if (!res.headersSent) res.status(500).json({ error: msg }); };
  req.on('aborted', () => fail('Upload cancelled'));
  req.on('error', () => fail('Upload failed'));
  out.on('error', (e) => fail(e.message));
  out.on('finish', () => {
    fs.renameSync(tmp, final);
    res.status(201).json({ name, size: fs.statSync(final).size });
  });
  req.pipe(out);
});
app.post('/api/probe', wrap(async (req, res) => res.json(await manager.probeInput(req.body))));

app.get('/hls/:id/:name', (req, res) => {
  const f = hlsStore.get(req.params.id, req.params.name);
  if (!f) return res.status(404).end();
  res.set({ 'Content-Type': f.type, 'Cache-Control': 'no-store' }).send(f.buf);
});
app.use('/vendor/hls.js', express.static(path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Last resort: any other error is reported as JSON without internals.
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Request failed' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info) => authorized(info.req.headers.authorization),
});

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
  if (!authEnabled && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.warn('WARNING: listening on a non-loopback address without authentication. Set AUTH_USER and AUTH_PASS.');
  }
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
