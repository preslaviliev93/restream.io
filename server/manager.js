const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildArgs, protocolOf, authUrl, maskSecrets } = require('./ffmpeg');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const DATA_DIR = path.join(__dirname, '..', 'data');
const SDP_DIR = path.join(DATA_DIR, 'sdp');
const REC_DIR = path.resolve(process.env.RECORD_DIR || path.join(DATA_DIR, 'recordings'));
const REC_EXT = /\.(mkv|mp4|ts)$/i;
const recordDir = (id) => path.join(REC_DIR, id);
const STORE = path.join(DATA_DIR, 'streams.json');

const SERIES_EVERY_MS = 2000;       // long-term sample spacing used by the report
const SERIES_MAX = 43200;           // 24 hours of samples
const newReport = () => ({
  startedAt: Date.now(), runningMs: 0, lastTs: 0, lastSeries: 0, stalls: 0, warnings: 0, errors: 0,
  base: { bytesOut: 0, bytesIn: 0, frames: 0, drops: 0, dups: 0, media: 0 },
  series: [], events: [], msgs: new Map(),
});
const HISTORY_LEN = 120;
const LOG_LEN = 500;
const STALL_WARN_MS = 6000;
const STALL_KILL_MS = 20000;
const PROBLEM_RE = /error|corrupt|missing|discontinuity|non[- ]monotonic|timed out|timeout|invalid|failed|dropp?ed|overrun/i;

for (const d of [DATA_DIR, SDP_DIR]) fs.mkdirSync(d, { recursive: true });

// In-memory HLS preview files, uploaded by ffmpeg over loopback HTTP and served to the browser.
const hlsStore = {
  token: crypto.randomBytes(16).toString('hex'),
  ingestBase: '',
  files: new Map(), // `${id}/${name}` -> { buf, type }
  maxSegments: 12,
  put(id, name, buf) {
    const isPlaylist = name.endsWith('.m3u8');
    this.files.set(`${id}/${name}`, { buf, type: isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
    if (isPlaylist) return;
    const segs = [...this.files.keys()].filter((k) => k.startsWith(`${id}/`) && k.endsWith('.ts'));
    for (const k of segs.slice(0, -this.maxSegments)) this.files.delete(k);
  },
  get(id, name) { return this.files.get(`${id}/${name}`); },
  clear(id) {
    for (const k of this.files.keys()) if (k.startsWith(`${id}/`)) this.files.delete(k);
  },
};

// Parses an ffmpeg "Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 25 fps ..." report line.
function parseStreamLine(line) {
  const m = /Stream #\d+:\d+[^:]*: (Video|Audio): ([^,\s(]+)(.*)$/.exec(line);
  if (!m) return null;
  const [, type, codec, rest] = m;
  const bitrate = Number((/(\d+) kb\/s/.exec(rest) || [])[1]) || 0;
  if (type === 'Video') {
    return {
      kind: 'video',
      data: {
        codec,
        // Only a real profile name; containers sometimes put a raw codec tag in the same brackets.
        profile: ((/^\s*\(([^)]*)\)/.exec(rest) || [])[1] || '').replace(/^.*0x[0-9a-f]+.*$/i, ''),
        pixFmt: (/,\s*((?:yuvj?|nv|gray|rgb|bgr|gbr|p0)\w*)/.exec(rest) || [])[1] || '',
        resolution: (/\b(\d{2,5}x\d{2,5})\b/.exec(rest) || [])[1] || '',
        aspect: (/DAR (\d+:\d+)/.exec(rest) || [])[1] || '',
        fps: Number((/([\d.]+) fps/.exec(rest) || [])[1]) || 0,
        bitrate,
      },
    };
  }
  return {
    kind: 'audio',
    data: {
      codec,
      sampleRate: Number((/(\d+) Hz/.exec(rest) || [])[1]) || 0,
      channels: (/Hz, ([^,]+)/.exec(rest) || [])[1] || '',
      bitrate,
    },
  };
}

const num = (v, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : 0;
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Catches typos ffmpeg would only report at start time, e.g. udp://239.100.100:5000 (3-part address).
function checkNetworkUrl(url, label) {
  const m = /^(udp|rtp|srt):\/\/@?([^/?#:]*)(?::(\d+))?/i.exec(url);
  if (!m) return;
  const [, scheme, host, port] = m;
  if (/^[\d.]+$/.test(host) && !(host.split('.').length === 4 && host.split('.').every((p) => p !== '' && +p <= 255))) {
    throw new Error(`${label} "${url}": "${host}" is not a valid IPv4 address (needs 4 numbers, e.g. 239.100.100.1)`);
  }
  if (!port && !(label === 'Input' && !host)) throw new Error(`${label} "${url}": ${scheme}:// needs a port, e.g. ${scheme}://${host || '0.0.0.0'}:5000`);
  if (port && (+port < 1 || +port > 65535)) throw new Error(`${label} "${url}": port must be 1-65535`);
}

// ---- server video library ----
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(DATA_DIR, 'media'));
const PLAYLIST_DIR = path.join(DATA_DIR, 'playlists');
const MEDIA_EXT = /\.(mp4|mkv|mov|avi|ts|webm|m4v|flv|mpg|mpeg|wmv)$/i;
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

const playlistPath = (id) => path.join(PLAYLIST_DIR, `${id}.txt`).replace(/\\/g, '/');

function mediaPath(name) {
  if (path.basename(name) !== name || !MEDIA_EXT.test(name)) throw new Error(`"${name}" is not a valid video file name`);
  const p = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`Video "${name}" is not in the server library`), { status: 404 });
  return p;
}

function writePlaylist(cfg) {
  const lines = cfg.input.files.map((f) => `file '${mediaPath(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(playlistPath(cfg.id), lines.join('\n') + '\n');
}

function normalize(raw, id, existing) {
  const r = raw || {};
  const username = str(r.input?.username);
  // An empty password field on edit means "keep the saved one".
  const password = typeof r.input?.password === 'string' && r.input.password
    ? r.input.password
    : (username && existing?.input?.password) || '';
  const isMedia = r.input?.type === 'media';
  const files = isMedia ? (Array.isArray(r.input.files) ? r.input.files : []).map(str).filter(Boolean) : [];
  if (isMedia) {
    if (!files.length) throw new Error('Choose at least one video from the server library');
    files.forEach(mediaPath);
  }
  // A single video is read directly; several are played in order through a generated concat list.
  const url = isMedia ? (files.length === 1 ? mediaPath(files[0]).replace(/\\/g, '/') : playlistPath(id)) : str(r.input?.url);
  if (!url) throw new Error('Input URL is required');
  if (url.startsWith('-')) throw new Error('Invalid input URL');
  if (protocolOf(url) === 'rtp' && !str(r.input?.sdp)) throw new Error('rtp:// inputs need an SDP description');
  const outputs = (r.outputs || [])
    .map((o) => ({ url: str(o.url), enabled: o.enabled !== false }))
    .filter((o) => o.url);
  for (const o of outputs) {
    if (o.url.startsWith('-')) throw new Error('Invalid output URL');
    checkNetworkUrl(o.url, 'Output');
  }
  checkNetworkUrl(url, 'Input');
  if (!outputs.length && !r.preview && !r.record?.enabled) {
    throw new Error('Add a destination, or turn on the live preview or recording');
  }
  return {
    id,
    name: str(r.name) || `Stream ${id.slice(0, 4)}`,
    input: {
      type: isMedia ? 'media' : 'url',
      files,
      playlist: isMedia && files.length > 1,
      url,
      username,
      password: username ? password : '',
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
    record: {
      enabled: !!r.record?.enabled,
      format: ['mkv', 'mp4', 'ts'].includes(r.record?.format) ? r.record.format : 'mkv',
      splitMinutes: [10, 30, 60].includes(Number(r.record?.splitMinutes)) ? Number(r.record.splitMinutes) : 0,
    },
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
    this.rep = newReport();
    this.resetRuntime();
    this.restarts = 0;
    this.logs = [];
    this.newLogs = [];
  }

  resetRuntime() {
    this.status = 'stopped';
    this.startedAt = 0;
    this.lastProgress = 0;
    this.stats = { frame: 0, fps: 0, bitrate: 0, inBitrate: 0, speed: 0, size: 0, drop: 0, dup: 0, outTime: 0 };
    this.inBytes = 0;
    this.prevIn = 0;
    this.stallFlag = false;
    this.sampleCount = 0;
    this.info = { format: '', bitrate: 0, video: null, audio: null, outputs: [] };
    this.curOut = null;
    this.history = [];
    this.counters = { warnings: 0, errors: 0 };
    this.lastError = '';
    this.command = '';
    this.inInputSection = true;
    this.prevSize = 0;
    this.prevTs = 0;
  }

  get sdpPath() { return path.join(SDP_DIR, `${this.cfg.id}.sdp`); }

  log(line) {
    if (!line) return;
    line = maskSecrets(line);
    const entry = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.logs.push(entry);
    if (this.logs.length > LOG_LEN) this.logs.shift();
    this.newLogs.push(entry);
    if (/error|failed|invalid|no such|refused|unable|could not/i.test(line)) {
      this.counters.errors++;
      this.rep.errors++;
      this.lastError = line;
      this.countMessage(line, 'error');
    } else if (PROBLEM_RE.test(line)) {
      this.counters.warnings++;
      this.rep.warnings++;
      this.countMessage(line, 'warning');
    }
  }

  // Groups repeated problem lines (numbers and addresses stripped) so the report can show the noisy ones.
  countMessage(line, level) {
    const key = line
      .replace(/\b[0-9a-f]{10,16}\b/gi, '#')
      .replace(/0x[0-9a-f]+/gi, '0x#')
      .replace(/\d+/g, 'N');
    const m = this.rep.msgs;
    const hit = m.get(key);
    if (hit) hit.count++;
    else if (m.size < 200) m.set(key, { count: 1, level, sample: line });
  }

  addEvent(text, state) {
    this.rep.events.push({ t: Date.now(), text, state });
    if (this.rep.events.length > 300) this.rep.events.shift();
  }

  start() {
    this.desired = true;
    if (this.proc || this.timer) return;
    this.failures = 0;
    this.rep = newReport();
    this.addEvent('Started', 'connecting');
    this.spawnProc();
  }

  spawnProc() {
    this.timer = null;
    const cfg = this.cfg;
    hlsStore.clear(cfg.id);
    if (cfg.input.playlist) writePlaylist(cfg);
    if (protocolOf(cfg.input.url) === 'rtp') fs.writeFileSync(this.sdpPath, cfg.input.sdp.replace(/\r?\n/g, '\r\n') + '\r\n');

    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    if (cfg.record?.enabled) fs.mkdirSync(recordDir(cfg.id), { recursive: true });
    const args = buildArgs(cfg, {
      hlsUrl: `${hlsStore.ingestBase}/ingest/${hlsStore.token}/${cfg.id}/index.m3u8`,
      tapUrl: `${hlsStore.ingestBase}/tap/${hlsStore.token}/${cfg.id}`,
      sdpPath: this.sdpPath.replace(/\\/g, '/'),
      recDir: recordDir(cfg.id).replace(/\\/g, '/'),
      recName: cfg.name.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'stream',
      recStamp: `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`,
    });
    const prevRestarts = this.restarts;
    this.resetRuntime();
    this.restarts = prevRestarts;
    this.status = 'starting';
    this.startedAt = Date.now();
    this.lastProgress = Date.now();
    this.command = maskSecrets([FFMPEG, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '));
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
    line = maskSecrets(line);
    let m;
    if ((m = /^Input #0, ([^,]+),/.exec(line))) {
      this.info.format = m[1].trim();
    } else if ((m = /^Output #(\d+), ([^,]+), to '(.*)':/.exec(line))) {
      this.inInputSection = false;
      // ffmpeg does not always print outputs in command order, so keep its own number and sort by it.
      // Internal outputs (preview, recording, bitrate tap) are tagged so the UI can label or hide them.
      const url = m[3], norm = url.replace(/\\/g, '/');
      const kind = url.includes('/tap/') ? 'tap' : url.includes('/ingest/') ? 'preview'
        : norm.startsWith(recordDir(this.cfg.id).replace(/\\/g, '/')) ? 'record' : 'dest';
      this.curOut = { index: Number(m[1]), kind, format: m[2].trim(), url, video: null, audio: null };
      this.info.outputs.push(this.curOut);
      this.info.outputs.sort((a, b) => a.index - b.index);
    } else if (this.inInputSection && (m = /Duration: .*?bitrate: (\d+) kb\/s/.exec(line))) {
      this.info.bitrate = Number(m[1]);
    } else {
      const st = parseStreamLine(line);
      if (st) {
        const target = this.inInputSection ? this.info : this.curOut;
        if (target && !target[st.kind]) target[st.kind] = st.data;
      }
    }
    this.log(line);
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
    // Bitrates come from byte deltas, lightly smoothed because video arrives in bursts (keyframes).
    // Output: ffmpeg's total_size covers its first output only. Input: bytes counted from the copy tap.
    if (this.prevTs && now > this.prevTs) {
      const secs = (now - this.prevTs) / 1000;
      const smooth = (old, next) => (old ? old * 0.6 + next * 0.4 : next);
      if (s.size >= this.prevSize) s.bitrate = smooth(s.bitrate, ((s.size - this.prevSize) * 8) / secs / 1000);
      s.inBitrate = smooth(s.inBitrate, ((this.inBytes - this.prevIn) * 8) / secs / 1000);
    }
    this.prevSize = s.size;
    this.prevIn = this.inBytes;
    this.prevTs = now;
    this.lastProgress = now;
    if (this.status === 'starting') {
      this.status = 'running';
      this.failures = 0;
      this.addEvent('Connected, receiving data', 'running');
    }
    const rep = this.rep;
    if (this.stallFlag) { this.stallFlag = false; this.addEvent('Data resumed', 'running'); }
    if (rep.lastTs) rep.runningMs += Math.min(now - rep.lastTs, 2000);
    rep.lastTs = now;
    // The first samples after a (re)start are still warming up (0 fps, no bytes yet), so keep them out of the statistics.
    if (++this.sampleCount > 3 && now - rep.lastSeries >= SERIES_EVERY_MS) {
      rep.lastSeries = now;
      rep.series.push({ t: now, i: +s.inBitrate.toFixed(1), o: +s.bitrate.toFixed(1), f: s.fps, s: s.speed });
      if (rep.series.length > SERIES_MAX) rep.series.shift();
    }
    if (this.sampleCount > 3) {
      this.history.push({ t: now, bitrate: +s.bitrate.toFixed(1), inBitrate: +s.inBitrate.toFixed(1), fps: s.fps, speed: s.speed });
      if (this.history.length > HISTORY_LEN) this.history.shift();
    }
  }

  checkStall() {
    if (!this.proc) return;
    const idle = Date.now() - this.lastProgress;
    if (idle > STALL_WARN_MS && this.status === 'running' && !this.stallFlag) {
      this.stallFlag = true;
      this.rep.stalls++;
      this.addEvent(`No data for ${Math.round(idle / 1000)} s`, 'down');
    }
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
    this.stats.inBitrate = 0;
    this.stats.fps = 0;
    hlsStore.clear(this.cfg.id);
    const b = this.rep.base, st = this.stats;
    b.bytesOut += st.size; b.bytesIn += this.inBytes; b.frames += st.frame; b.drops += st.drop; b.dups += st.dup; b.media += st.outTime;
    if (!this.desired) {
      this.status = 'stopped';
      this.addEvent('Stopped', 'stopped');
      return;
    }
    if (code === 0) {
      // Finite source (file) reached its end.
      this.desired = false;
      this.status = 'stopped';
      this.addEvent('Finished (end of source)', 'stopped');
      return;
    }
    if (!this.cfg.autoRestart) {
      this.desired = false;
      this.status = 'error';
      this.addEvent(`Stopped after an error (code ${code})`, 'stopped');
      return;
    }
    if (ranFor > 30000) this.failures = 0;
    const delay = Math.min(2000 * 2 ** this.failures, 15000);
    this.failures++;
    this.restarts++;
    this.status = 'restarting';
    this.log(`> restarting in ${delay / 1000}s`);
    this.addEvent(`Connection lost (code ${code}), reconnecting in ${delay / 1000} s`, 'down');
    this.timer = setTimeout(() => this.spawnProc(), delay);
  }

  stop() {
    this.desired = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.proc) {
      if (this.status !== 'stopped') this.addEvent('Stopped', 'stopped');
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
      // The saved password never leaves the server; the form only learns that one is set.
      input: { ...this.cfg.input, password: '', passwordSet: !!this.cfg.input.password },
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

  probeInput(body = {}) {
    const saved = body.streamId && this.runners.get(body.streamId)?.cfg.input;
    const password = body.password || (saved && body.username ? saved.password : '');
    return probe({ ...body, password });
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
    const cfg = normalize(body, id, runner.cfg);
    const wasRunning = runner.desired;
    await runner.stop();
    runner.cfg = cfg;
    this.save();
    if (wasRunning) runner.start();
    return runner.snapshot();
  }

  mediaList() {
    const files = fs.readdirSync(MEDIA_DIR)
      .filter((n) => MEDIA_EXT.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(MEDIA_DIR, name));
        const usedBy = [...this.runners.values()].filter((r) => r.cfg.input.files?.includes(name)).map((r) => r.cfg.name);
        return { name, size: st.size, mtime: st.mtimeMs, usedBy };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { dir: MEDIA_DIR, files, total: files.reduce((t, f) => t + f.size, 0) };
  }

  mediaDelete(name) {
    const p = mediaPath(name);
    const user = [...this.runners.values()].find((r) => r.cfg.input.files?.includes(name));
    if (user) throw new Error(`"${name}" is used by the stream "${user.cfg.name}". Remove it from that stream first.`);
    fs.rmSync(p);
  }

  recordings(id) {
    const runner = this.get(id);
    const dir = recordDir(id);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => REC_EXT.test(n)); } catch { /* nothing recorded yet */ }
    const recording = runner.cfg.record.enabled && runner.status === 'running';
    // Windows reports stale size/mtime for a file that is still open, so the newest file of a running
    // recording is simply treated as the active one instead of guessing from timestamps.
    const files = names
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, size: st.size, mtime: st.mtimeMs, active: false };
      })
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    if (recording && files.length) files[0].active = true;
    return { dir, files, total: files.reduce((t, f) => t + f.size, 0) };
  }

  recordingPath(id, file) {
    this.get(id);
    if (path.basename(file) !== file || !REC_EXT.test(file)) throw new Error('Invalid file name');
    const p = path.join(recordDir(id), file);
    if (!fs.existsSync(p)) throw Object.assign(new Error('File not found'), { status: 404 });
    return p;
  }

  async remove(id) {
    const runner = this.get(id);
    await runner.stop();
    this.runners.delete(id);
    hlsStore.clear(id);
    fs.rmSync(runner.sdpPath, { force: true });
    fs.rmSync(playlistPath(id), { force: true });
    this.save();
  }

  async shutdown() {
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
  }
}

function run(bin, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(maskSecrets((stderr || err.message).trim().split('\n').slice(-3).join(' | '))));
      resolve(stdout);
    });
  });
}

async function probe({ url, sdp, rtspTransport, username, password }) {
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
    args.push('-i', authUrl({ url, username: str(username), password }));
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

module.exports = { Manager, probe, systemInfo, hlsStore, MEDIA_DIR, MEDIA_EXT };
