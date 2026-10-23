// A Worker supervises one ffmpeg process: start/stop, restart with backoff, progress statistics,
// input/output format parsing, log lines and stall detection. A stream is made of several workers
// (the source ingest, each destination, the recording, the preview).
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { maskSecrets } = require('./ffmpeg');

const HISTORY_LEN = 240;
const RECENT_LINES = 60;
const STALL_WARN_MS = 6000;
const STALL_KILL_MS = 20000;
const GATE_POLL_MS = 500;
// Messages that mean "this can never work with the current settings" (missing encoder or GPU, port taken),
// so retrying is pointless.
const CONFIG_FATAL_RE = /cannot load (libcuda|nvcuda|libnvidia)|no capable devices|openencodesessionex|error creating a mfx session|libmfx|unknown encoder|encoder .{0,40} not found|error while opening encoder|could not open encoder|address already in use|bind failed/i;
const ERROR_RE = /error|failed|invalid|no such|refused|unable|could not/i;
const PROBLEM_RE = /error|corrupt|missing|discontinuity|non[- ]monotonic|timed out|timeout|invalid|failed|dropp?ed|overrun/i;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
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

class Worker extends EventEmitter {
  // opts: id, kind, ffmpeg (path), build() -> args, ready() -> bool, autoRestart() -> bool,
  //       outKind (tag for the output this process writes), quietUntilData (never kill while waiting for the first data),
  //       onExit({ code, ranFor, worker }) -> undefined | 'finished' | 'immediate'
  constructor(opts) {
    super();
    this.opts = opts;
    this.id = opts.id;
    this.kind = opts.kind;
    this.desired = false;
    this.proc = null;
    this.timer = null;
    this.watchdog = null;
    this.failures = 0;
    this.restarts = 0;
    this.resetReport();
    this.reset();
  }

  // Session-long totals for the report; they survive restarts and start over when the stream is started again.
  resetReport() {
    this.rep = { runningMs: 0, lastTs: 0, errors: 0, warnings: 0, bitrateSum: 0, bitrateN: 0, bitrateMax: 0, fpsSum: 0 };
    this.restarts = 0;
    this.lastError = '';
  }

  reset() {
    this.status = 'stopped';
    this.startedAt = 0;
    this.lastProgress = 0;
    this.stats = { frame: 0, fps: 0, bitrate: 0, speed: 0, size: 0, drop: 0, dup: 0, outTime: 0 };
    this.info = { format: '', bitrate: 0, video: null, audio: null, outputs: [] };
    this.curOut = null;
    this.inInput = true;
    this.history = [];
    this.counters = { warnings: 0, errors: 0 };
    // lastError is kept across automatic restarts so the problem stays visible until the process works again.
    this.configError = '';
    this.command = '';
    this.recent = [];
    this.prevSize = 0;
    this.prevTs = 0;
    this.samples = 0;
    this.stallFlag = false;
  }

  get active() { return !!this.proc; }
  get stalled() { return !!this.proc && this.status === 'running' && Date.now() - this.lastProgress > STALL_WARN_MS; }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('state', s);
  }

  log(line) {
    if (!line) return;
    line = maskSecrets(line);
    if (CONFIG_FATAL_RE.test(line)) this.configError = line;
    this.recent.push(line);
    if (this.recent.length > RECENT_LINES) this.recent.shift();
    // Errors a reader logs because its source went away are a consequence, not a problem of its own.
    if (this.opts.expectErrors && this.opts.expectErrors()) { this.emit('log', line); return; }
    if (ERROR_RE.test(line)) {
      this.counters.errors++; this.rep.errors++;
      this.lastError = line;
      this.emit('problem', line, 'error');
    } else if (PROBLEM_RE.test(line)) {
      this.counters.warnings++; this.rep.warnings++;
      this.emit('problem', line, 'warning');
    }
    this.emit('log', line);
  }

  // Own lifecycle messages: shown in the log but never counted as problems.
  note(line) { this.emit('log', line); }

  start() {
    this.desired = true;
    this.failures = 0;
    this.tick();
  }

  tick() {
    if (!this.desired || this.proc || this.timer) return;
    if (this.opts.ready && !this.opts.ready()) {
      this.setStatus('waiting');
      this.timer = setTimeout(() => { this.timer = null; this.tick(); }, GATE_POLL_MS);
      return;
    }
    this.spawnProc();
  }

  spawnProc() {
    let args;
    try {
      args = this.opts.build();
    } catch (e) {
      this.lastError = e.message;
      this.desired = false;
      this.setStatus('error');
      this.note(`! cannot start: ${e.message}`);
      this.emit('fatal', e.message);
      return;
    }
    const keepRestarts = this.restarts;
    this.reset();
    this.restarts = keepRestarts;
    this.startedAt = Date.now();
    this.lastProgress = Date.now();
    this.command = maskSecrets([this.opts.ffmpeg, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '));
    this.setStatus('starting');
    this.note(`> starting ffmpeg (restart #${this.restarts})`);

    let proc;
    try {
      proc = spawn(this.opts.ffmpeg, args, { windowsHide: true });
    } catch (e) {
      return this.onExit(-1, e.message);
    }
    this.proc = proc;
    this.pipeLines(proc.stderr, (l) => this.onStderr(l));
    this.pipeLines(proc.stdout, (l) => this.onProgress(l));
    proc.stdin.on('error', () => { /* ffmpeg already gone */ });
    proc.on('error', (e) => { this.log(`spawn error: ${e.message}`); this.lastError = e.message; });
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
    // The preview uploads a new segment every second; ffmpeg announces each one, which would bury everything else.
    if (/^\[hls @ [^\]]+\] Opening '.*' for writing$/.test(line)) return;
    line = maskSecrets(line);
    let m;
    if ((m = /^Input #0, ([^,]+),/.exec(line))) {
      this.info.format = m[1].trim();
    } else if ((m = /^Output #(\d+), ([^,]+), to '(.*)':/.exec(line))) {
      if (this.inInput) this.emit('inputinfo', this.info);   // the source has been fully described by now
      this.inInput = false;
      this.curOut = { index: Number(m[1]), kind: this.opts.outKind || this.kind, format: m[2].trim(), url: m[3], video: null, audio: null };
      this.info.outputs.push(this.curOut);
    } else if (this.inInput && (m = /Duration: .*?bitrate: (\d+) kb\/s/.exec(line))) {
      this.info.bitrate = Number(m[1]);
    } else {
      const st = parseStreamLine(line);
      if (st) {
        const target = this.inInput ? this.info : this.curOut;
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
      case 'progress': if (v !== 'end') this.commit(); break;   // the final block is printed on exit, not a sign of life
      default:
    }
  }

  // One progress block received: update rates and history.
  commit() {
    const now = Date.now();
    const s = this.stats;
    // Bitrate from byte deltas, lightly smoothed because video arrives in bursts (keyframes).
    if (this.prevTs && now > this.prevTs && s.size >= this.prevSize) {
      const kbps = ((s.size - this.prevSize) * 8) / ((now - this.prevTs) / 1000) / 1000;
      s.bitrate = s.bitrate ? s.bitrate * 0.6 + kbps * 0.4 : kbps;
    }
    this.prevSize = s.size;
    this.prevTs = now;
    this.lastProgress = now;
    if (this.status === 'starting') {
      this.failures = 0;
      this.lastError = '';   // it works again
      this.setStatus('running');
    }
    if (this.stallFlag) { this.stallFlag = false; this.emit('resumed'); }
    const r = this.rep;
    if (r.lastTs) r.runningMs += Math.min(now - r.lastTs, 2000);
    r.lastTs = now;
    if (++this.samples > 3) {   // the first samples are still warming up (0 fps, no bytes yet)
      this.history.push({ t: now, bitrate: +s.bitrate.toFixed(1), fps: s.fps, speed: s.speed });
      if (this.history.length > HISTORY_LEN) this.history.shift();
      r.bitrateSum += s.bitrate; r.bitrateN++; r.fpsSum += s.fps;
      if (s.bitrate > r.bitrateMax) r.bitrateMax = s.bitrate;
    }
  }

  checkStall() {
    if (!this.proc) return;
    // A process waiting for something to connect to it (listener) is not stalled.
    if (this.opts.quietUntilData && this.status === 'starting') return;
    const idle = Date.now() - this.lastProgress;
    if (idle > STALL_WARN_MS && this.status === 'running' && !this.stallFlag) {
      this.stallFlag = true;
      this.emit('stalled', Math.round(idle / 1000));
    }
    if (idle > STALL_KILL_MS) {
      this.note(`! no data for ${Math.round(idle / 1000)}s, killing ffmpeg`);
      this.proc.kill();
    }
  }

  onExit(code, msg) {
    clearInterval(this.watchdog);
    this.proc = null;
    this.note(`> ffmpeg exited (code ${code}${msg ? `: ${msg}` : ''})`);
    const ranFor = Date.now() - this.startedAt;
    this.stats.bitrate = 0;
    this.stats.fps = 0;
    this.emit('exit', code, ranFor);
    if (!this.desired) { this.setStatus('stopped'); return; }

    if (this.configError && (this.status === 'starting' || this.stats.frame === 0)) {
      // Failed before any data flowed because of an unusable encoder or port: retrying would loop forever.
      this.desired = false;
      this.lastError = this.configError;
      this.setStatus('error');
      this.emit('fatal', this.configError);
      return;
    }
    const verdict = this.opts.onExit ? this.opts.onExit({ code, ranFor, worker: this }) : undefined;
    if (verdict === 'finished') { this.desired = false; this.setStatus('stopped'); return; }
    if (!this.opts.autoRestart()) {
      this.desired = false;
      this.setStatus('error');
      this.emit('gaveup', code);
      return;
    }
    let delay;
    if (verdict === 'immediate') {
      delay = 300;
    } else {
      if (ranFor > 30000) this.failures = 0;
      delay = Math.min(2000 * 2 ** this.failures, 15000);
      this.failures++;
    }
    if (verdict !== 'immediate') this.restarts++;   // a planned restart is not a failure
    this.setStatus('restarting');
    this.note(`> restarting in ${delay / 1000}s`);
    this.emit('restarting', code, delay);
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, delay);
  }

  stop() {
    this.desired = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.proc) {
      this.setStatus('stopped');
      return Promise.resolve();
    }
    const proc = this.proc;
    this.setStatus('stopping');
    return new Promise((resolve) => {
      const kill = setTimeout(() => proc.kill(), 3000);
      proc.once('close', () => { clearTimeout(kill); resolve(); });
      try { proc.stdin.write('q'); } catch { proc.kill(); }
    });
  }

  async restart() {
    await this.stop();
    this.start();
  }

  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      stalled: this.stalled,
      desired: this.desired,
      startedAt: this.proc ? this.startedAt : 0,
      uptime: this.proc && this.startedAt ? Date.now() - this.startedAt : 0,
      restarts: this.restarts,
      stats: this.stats,
      counters: this.counters,
      lastError: this.lastError,
    };
  }
}

module.exports = { Worker, parseStreamLine, CONFIG_FATAL_RE };
