const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildArgs, protocolOf } = require('./ffmpeg');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const DATA_DIR = path.join(__dirname, '..', 'data');
const HLS_DIR = path.join(DATA_DIR, 'hls');
const SDP_DIR = path.join(DATA_DIR, 'sdp');
const STORE = path.join(DATA_DIR, 'streams.json');

const HISTORY_LEN = 120;
const LOG_LEN = 500;
const STALL_WARN_MS = 6000;
const STALL_KILL_MS = 20000;
const PROBLEM_RE = /error|corrupt|missing|discontinuity|non[- ]monotonic|timed out|timeout|invalid|failed|dropp?ed|overrun/i;

for (const d of [DATA_DIR, HLS_DIR, SDP_DIR]) fs.mkdirSync(d, { recursive: true });

const num = (v, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : 0;
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function normalize(raw, id) {
  const r = raw || {};
  const url = str(r.input?.url);
  if (!url) throw new Error('Input URL is required');
  if (url.startsWith('-')) throw new Error('Invalid input URL');
  if (protocolOf(url) === 'rtp' && !str(r.input?.sdp)) throw new Error('rtp:// inputs need an SDP description');
  const outputs = (r.outputs || [])
    .map((o) => ({ url: str(o.url), enabled: o.enabled !== false }))
    .filter((o) => o.url);
  for (const o of outputs) if (o.url.startsWith('-')) throw new Error('Invalid output URL');
  if (!outputs.length && !r.preview) throw new Error('Add at least one output or enable the preview');
  return {
    id,
    name: str(r.name) || `Stream ${id.slice(0, 4)}`,
    input: {
      url,
      rtspTransport: r.input?.rtspTransport === 'udp' ? 'udp' : 'tcp',
      sdp: str(r.input?.sdp),
      loop: !!r.input?.loop,
      extra: str(r.input?.extra),
    },
    video: {
      mode: r.video?.mode === 'transcode' ? 'transcode' : 'copy',
      codec: str(r.video?.codec) || 'libx264',
      bitrate: num(r.video?.bitrate),
      width: num(r.video?.width),
      height: num(r.video?.height),
      fps: num(r.video?.fps),
      gop: num(r.video?.gop),
      preset: str(r.video?.preset) || 'veryfast',
    },
    audio: {
      mode: ['copy', 'transcode', 'none'].includes(r.audio?.mode) ? r.audio.mode : 'copy',
      codec: str(r.audio?.codec) || 'aac',
      bitrate: num(r.audio?.bitrate),
      sampleRate: num(r.audio?.sampleRate),
    },
    outputs,
    extraOutputArgs: str(r.extraOutputArgs),
    preview: !!r.preview,
    autoRestart: r.autoRestart !== false,
    autoStart: !!r.autoStart,
  };
}

class Runner {
  constructor(cfg) {
    this.cfg = cfg;
    this.desired = false;
    this.proc = null;
    this.timer = null;
    this.watchdog = null;
    this.failures = 0;
    this.resetRuntime();
    this.restarts = 0;
    this.logs = [];
    this.newLogs = [];
  }

  resetRuntime() {
    this.status = 'stopped';
    this.startedAt = 0;
    this.lastProgress = 0;
    this.stats = { frame: 0, fps: 0, bitrate: 0, speed: 0, size: 0, drop: 0, dup: 0, outTime: 0 };
    this.info = { video: null, audio: null };
    this.history = [];
    this.counters = { warnings: 0, errors: 0 };
    this.lastError = '';
    this.command = '';
    this.inInputSection = true;
    this.prevSize = 0;
    this.prevTs = 0;
  }

  get hlsDir() { return path.join(HLS_DIR, this.cfg.id); }
  get sdpPath() { return path.join(SDP_DIR, `${this.cfg.id}.sdp`); }

  log(line) {
    if (!line) return;
    const entry = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.logs.push(entry);
    if (this.logs.length > LOG_LEN) this.logs.shift();
    this.newLogs.push(entry);
    if (/error|failed|invalid|no such|refused|unable|could not/i.test(line)) {
      this.counters.errors++;
      this.lastError = line;
    } else if (PROBLEM_RE.test(line)) {
      this.counters.warnings++;
    }
  }

  start() {
    this.desired = true;
    if (this.proc || this.timer) return;
    this.failures = 0;
    this.spawnProc();
  }

  spawnProc() {
    this.timer = null;
    const cfg = this.cfg;
    fs.rmSync(this.hlsDir, { recursive: true, force: true });
    fs.mkdirSync(this.hlsDir, { recursive: true });
    if (protocolOf(cfg.input.url) === 'rtp') fs.writeFileSync(this.sdpPath, cfg.input.sdp.replace(/\r?\n/g, '\r\n') + '\r\n');

    const args = buildArgs(cfg, { hlsDir: this.hlsDir.replace(/\\/g, '/'), sdpPath: this.sdpPath.replace(/\\/g, '/') });
    const prevRestarts = this.restarts;
    this.resetRuntime();
    this.restarts = prevRestarts;
    this.status = 'starting';
    this.startedAt = Date.now();
    this.lastProgress = Date.now();
    this.command = [FFMPEG, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
    this.log(`> starting ffmpeg (restart #${this.restarts})`);

    let proc;
    try {
      proc = spawn(FFMPEG, args, { windowsHide: true });
    } catch (e) {
      return this.onExit(-1, e.message);
    }
    this.proc = proc;
    this.pipeLines(proc.stderr, (l) => this.onStderr(l));
    this.pipeLines(proc.stdout, (l) => this.onProgress(l));
    proc.on('error', (e) => { this.log(`spawn error: ${e.message}`); this.lastError = e.message; this.counters.errors++; });
    proc.on('close', (code) => this.onExit(code));
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.checkStall(), 2000);
  }

  pipeLines(stream, cb) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString('utf8');
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      parts.forEach((l) => cb(l.trim()));
    });
  }

  onStderr(line) {
    if (!line) return;
    if (/^Output #/.test(line)) this.inInputSection = false;
    if (this.inInputSection) this.parseInputInfo(line);
    this.log(line);
  }

  parseInputInfo(line) {
    const m = /Stream #\d+:\d+[^:]*: (Video|Audio): ([^,\s(]+)(.*)$/.exec(line);
    if (!m) return;
    const [, kind, codec, rest] = m;
    if (kind === 'Video' && !this.info.video) {
      this.info.video = {
        codec,
        resolution: (/(\d{2,5}x\d{2,5})/.exec(rest) || [])[1] || '',
        fps: Number((/([\d.]+) fps/.exec(rest) || [])[1]) || 0,
        bitrate: Number((/(\d+) kb\/s/.exec(rest) || [])[1]) || 0,
        desc: rest.replace(/^[\s,]+/, ''),
      };
    } else if (kind === 'Audio' && !this.info.audio) {
      this.info.audio = {
        codec,
        sampleRate: Number((/(\d+) Hz/.exec(rest) || [])[1]) || 0,
        bitrate: Number((/(\d+) kb\/s/.exec(rest) || [])[1]) || 0,
        desc: rest.replace(/^[\s,]+/, ''),
      };
    }
  }

  onProgress(line) {
    const i = line.indexOf('=');
    if (i < 0) return;
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    const s = this.stats;
    switch (k) {
      case 'frame': s.frame = num(v); break;
      case 'fps': s.fps = num(v); break;
      case 'total_size': s.size = num(v); break;
      case 'out_time_us': s.outTime = num(v) / 1e6; break;
      case 'drop_frames': s.drop = num(v); break;
      case 'dup_frames': s.dup = num(v); break;
      case 'speed': s.speed = parseFloat(v) || 0; break;
      case 'progress': this.commitSample(); break;
      default:
    }
  }

  commitSample() {
    const now = Date.now();
    const s = this.stats;
    // Output bitrate computed from byte deltas (ffmpeg's own value lags and is cumulative).
    if (this.prevTs && now > this.prevTs && s.size >= this.prevSize) {
      s.bitrate = ((s.size - this.prevSize) * 8) / ((now - this.prevTs) / 1000) / 1000;
    }
    this.prevSize = s.size;
    this.prevTs = now;
    this.lastProgress = now;
    if (this.status === 'starting') {
      this.status = 'running';
      this.failures = 0;
    }
    this.history.push({ t: now, bitrate: +s.bitrate.toFixed(1), fps: s.fps, speed: s.speed });
    if (this.history.length > HISTORY_LEN) this.history.shift();
  }

  checkStall() {
    if (!this.proc) return;
    const idle = Date.now() - this.lastProgress;
    if (idle > STALL_KILL_MS) {
      this.log(`! no data for ${Math.round(idle / 1000)}s, killing ffmpeg`);
      this.proc.kill();
    }
  }

  get stalled() {
    return !!this.proc && this.status === 'running' && Date.now() - this.lastProgress > STALL_WARN_MS;
  }

  onExit(code, msg) {
    clearInterval(this.watchdog);
    this.proc = null;
    this.log(`> ffmpeg exited (code ${code}${msg ? `: ${msg}` : ''})`);
    const ranFor = Date.now() - this.startedAt;
    this.stats.bitrate = 0;
    this.stats.fps = 0;
    if (!this.desired) {
      this.status = 'stopped';
      return;
    }
    if (code === 0) {
      // Finite source (file) reached its end.
      this.desired = false;
      this.status = 'stopped';
      return;
    }
    if (!this.cfg.autoRestart) {
      this.desired = false;
      this.status = 'error';
      return;
    }
    if (ranFor > 30000) this.failures = 0;
    const delay = Math.min(2000 * 2 ** this.failures, 15000);
    this.failures++;
    this.restarts++;
    this.status = 'restarting';
    this.log(`> restarting in ${delay / 1000}s`);
    this.timer = setTimeout(() => this.spawnProc(), delay);
  }

  stop() {
    this.desired = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.proc) {
      this.status = 'stopped';
      return Promise.resolve();
    }
    const proc = this.proc;
    this.status = 'stopping';
    return new Promise((resolve) => {
      const kill = setTimeout(() => proc.kill(), 3000);
      proc.once('close', () => { clearTimeout(kill); resolve(); });
      try { proc.stdin.write('q'); } catch { proc.kill(); }
    });
  }

  snapshot() {
    const up = this.proc && this.startedAt ? Date.now() - this.startedAt : 0;
    return {
      ...this.cfg,
      runtime: {
        status: this.status,
        stalled: this.stalled,
        startedAt: this.proc ? this.startedAt : 0,
        uptime: up,
        restarts: this.restarts,
        stats: this.stats,
        info: this.info,
        history: this.history,
        counters: this.counters,
        lastError: this.lastError,
        command: this.command,
      },
    };
  }

  drainLogs() {
    const l = this.newLogs;
    this.newLogs = [];
    return l;
  }
}

class Manager {
  constructor() {
    this.runners = new Map();
    this.load();
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      for (const cfg of list) this.runners.set(cfg.id, new Runner(cfg));
    } catch { /* first run */ }
  }

  save() {
    fs.writeFileSync(STORE, JSON.stringify([...this.runners.values()].map((r) => r.cfg), null, 2));
  }

  autoStart() {
    for (const r of this.runners.values()) if (r.cfg.autoStart) r.start();
  }

  list() { return [...this.runners.values()].map((r) => r.snapshot()); }

  get(id) {
    const r = this.runners.get(id);
    if (!r) throw Object.assign(new Error('Stream not found'), { status: 404 });
    return r;
  }

  async create(body) {
    const id = crypto.randomUUID();
    const runner = new Runner(normalize(body, id));
    this.runners.set(id, runner);
    this.save();
    return runner.snapshot();
  }

  async update(id, body) {
    const runner = this.get(id);
    const cfg = normalize(body, id);
    const wasRunning = runner.desired;
    await runner.stop();
    runner.cfg = cfg;
    this.save();
    if (wasRunning) runner.start();
    return runner.snapshot();
  }

  async remove(id) {
    const runner = this.get(id);
    await runner.stop();
    this.runners.delete(id);
    fs.rmSync(runner.hlsDir, { recursive: true, force: true });
    fs.rmSync(runner.sdpPath, { force: true });
    this.save();
  }

  async shutdown() {
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
  }
}

function run(bin, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' | ')));
      resolve(stdout);
    });
  });
}

async function probe({ url, sdp, rtspTransport }) {
  url = str(url);
  if (!url || url.startsWith('-')) throw new Error('Invalid URL');
  const proto = protocolOf(url);
  const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json'];
  let tmp;
  if (proto === 'rtp') {
    if (!str(sdp)) throw new Error('SDP required for rtp://');
    tmp = path.join(SDP_DIR, `probe-${Date.now()}.sdp`);
    fs.writeFileSync(tmp, sdp.replace(/\r?\n/g, '\r\n') + '\r\n');
    args.push('-protocol_whitelist', 'file,udp,rtp,crypto', '-i', tmp.replace(/\\/g, '/'));
  } else {
    if (proto === 'rtsp') args.push('-rtsp_transport', rtspTransport === 'udp' ? 'udp' : 'tcp');
    args.push('-i', url);
  }
  try {
    return JSON.parse(await run(FFPROBE, args));
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

async function systemInfo() {
  try {
    const out = await run(FFMPEG, ['-version'], 5000);
    return { ok: true, version: out.split('\n')[0] };
  } catch (e) {
    return { ok: false, error: `ffmpeg not found (${FFMPEG}). Install it or set FFMPEG_PATH.` };
  }
}

module.exports = { Manager, probe, systemInfo, HLS_DIR };
