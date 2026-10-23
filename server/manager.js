const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ff = require('./ffmpeg');
const { Worker } = require('./worker');
const { Relay } = require('./relay');

const { protocolOf, authUrl, maskSecrets, PRESETS } = ff;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const DATA_DIR = path.join(__dirname, '..', 'data');
const SDP_DIR = path.join(DATA_DIR, 'sdp');
const REC_DIR = path.resolve(process.env.RECORD_DIR || path.join(DATA_DIR, 'recordings'));
const LOGO_DIR = path.resolve(process.env.LOGO_DIR || path.join(DATA_DIR, 'logos'));
const REC_EXT = /\.(mkv|mp4|ts)$/i;
const LOGO_EXT = /\.(png|jpe?g|webp)$/i;
const recordDir = (id) => path.join(REC_DIR, id);
const STORE = path.join(DATA_DIR, 'streams.json');

const SERIES_EVERY_MS = 2000;       // long-term sample spacing used by the report
const SERIES_MAX = 43200;           // 24 hours of samples
const HISTORY_LEN = 240;
const LOG_LEN = 1500;
const SAMPLE_MS = 500;
const WARMUP_SAMPLES = 6;

const newReport = () => ({
  startedAt: Date.now(), runningMs: 0, lastTs: 0, lastSeries: 0, stalls: 0, warnings: 0, errors: 0,
  base: { bytesOut: 0, frames: 0, drops: 0, dups: 0, media: 0 },
  series: [], events: [], msgs: new Map(),
});

for (const d of [DATA_DIR, SDP_DIR, LOGO_DIR]) fs.mkdirSync(d, { recursive: true });

const relay = new Relay();

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

const num = (v, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : 0;
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ validation */

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

/* ------------------------------------------------------------------ server video library */

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

function logoPath(name) {
  if (path.basename(name) !== name || !LOGO_EXT.test(name)) throw new Error(`"${name}" is not a valid logo image name`);
  const p = path.join(LOGO_DIR, name);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`Logo "${name}" is not on the server`), { status: 404 });
  return p;
}

function writePlaylist(cfg) {
  const lines = cfg.input.files.map((f) => `file '${mediaPath(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(playlistPath(cfg.id), lines.join('\n') + '\n');
}

/* ------------------------------------------------------------------ configuration */

const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
const newId = () => crypto.randomBytes(4).toString('hex');

function normalizeInput(r, id, existing) {
  const username = str(r.input?.username);
  // An empty password field on edit means "keep the saved one".
  const password = typeof r.input?.password === 'string' && r.input.password
    ? r.input.password
    : (username && existing?.input?.password) || '';
  const type = ['media', 'listen'].includes(r.input?.type) ? r.input.type : 'url';
  const base = {
    type, files: [], playlist: false, url: '', username: '', password: '', listen: null,
    rtspTransport: r.input?.rtspTransport === 'udp' ? 'udp' : 'tcp',
    sdp: str(r.input?.sdp), loop: !!r.input?.loop, extra: str(r.input?.extra),
  };

  if (type === 'media') {
    const files = (Array.isArray(r.input.files) ? r.input.files : []).map(str).filter(Boolean);
    if (!files.length) throw new Error('Choose at least one video from the server library');
    files.forEach(mediaPath);
    // A single video is read directly; several are played in order through a generated concat list.
    return { ...base, files, playlist: files.length > 1, url: files.length === 1 ? mediaPath(files[0]).replace(/\\/g, '/') : playlistPath(id) };
  }

  if (type === 'listen') {
    const l = r.input?.listen || {};
    const protocol = l.protocol === 'srt' ? 'srt' : 'rtmp';
    const port = Math.round(num(l.port));
    if (port < 1 || port > 65535) throw new Error('Enter the port to listen on (1-65535)');
    const key = str(l.key) || 'stream';
    if (protocol === 'rtmp' && !/^[\w-]{1,64}$/.test(key)) throw new Error('The stream key may only contain letters, numbers, - and _');
    const passphrase = typeof l.passphrase === 'string' && l.passphrase ? l.passphrase : (existing?.input?.listen?.passphrase || '');
    if (protocol === 'srt' && passphrase && (passphrase.length < 10 || passphrase.length > 79)) throw new Error('An SRT passphrase must be 10 to 79 characters long');
    return {
      ...base,
      listen: { protocol, port, key: protocol === 'rtmp' ? key : '', passphrase: protocol === 'srt' ? passphrase : '' },
      url: protocol === 'rtmp' ? `rtmp://0.0.0.0:${port}/live/${key}` : `srt://0.0.0.0:${port}`,
    };
  }

  const url = str(r.input?.url);
  if (!url) throw new Error('Input URL is required');
  if (url.startsWith('-')) throw new Error('Invalid input URL');
  if (protocolOf(url) === 'rtp' && !base.sdp) throw new Error('rtp:// inputs need an SDP description');
  checkNetworkUrl(url, 'Input');
  return { ...base, url, username, password: username ? password : '' };
}

function normalizePicture(p = {}) {
  const t = p.text || {}, l = p.logo || {}, c = p.crop || {};
  const crop = ['left', 'right', 'top', 'bottom'].reduce((o, k) => ({ ...o, [k]: Math.round(clamp(num(c[k]), 0, 3000)) }), {});
  const picture = {
    rotate: [90, 180, 270].includes(Number(p.rotate)) ? Number(p.rotate) : 0,
    flipH: !!p.flipH,
    flipV: !!p.flipV,
    deinterlace: !!p.deinterlace,
    crop,
    text: {
      enabled: !!t.enabled,
      content: str(t.content).slice(0, 120),
      clock: !!t.clock,
      position: POSITIONS.includes(t.position) ? t.position : 'top-left',
      size: ['small', 'medium', 'large'].includes(t.size) ? t.size : 'medium',
      color: ['white', 'yellow', 'red', 'green', 'cyan', 'black'].includes(t.color) ? t.color : 'white',
      box: t.box !== false,
    },
    logo: {
      enabled: !!l.enabled,
      file: str(l.file),
      position: POSITIONS.includes(l.position) ? l.position : 'top-right',
      sizePercent: Math.round(clamp(num(l.sizePercent) || 12, 3, 40)),
      opacity: Math.round(clamp(num(l.opacity) || 100, 10, 100)),
    },
  };
  if (picture.text.enabled && !picture.text.content && !picture.text.clock) throw new Error('Type the overlay text, or tick "Show date and time"');
  if (picture.logo.enabled) logoPath(picture.logo.file);
  return picture;
}

function normalize(raw, id, existing) {
  const r = raw || {};
  const input = normalizeInput(r, id, existing);
  const outputs = (r.outputs || [])
    .map((o) => ({
      id: /^[a-f0-9]{8}$/.test(o.id || '') ? o.id : newId(),
      url: str(o.url),
      enabled: o.enabled !== false,
      preset: ['inherit', ...Object.keys(PRESETS)].includes(o.preset) ? o.preset : 'inherit',
    }))
    .filter((o) => o.url);
  const seen = new Set();
  for (const o of outputs) {
    if (o.url.startsWith('-')) throw new Error('Invalid output URL');
    checkNetworkUrl(o.url, 'Output');
    while (seen.has(o.id)) o.id = newId();
    seen.add(o.id);
  }
  if (!outputs.length && !r.preview && !r.record?.enabled) {
    throw new Error('Add a destination, or turn on the live preview or recording');
  }
  return {
    id,
    name: str(r.name) || `Stream ${id.slice(0, 4)}`,
    input,
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
    picture: normalizePicture(r.picture),
    audioFx: {
      source: r.audioFx?.source === 'silence' ? 'silence' : 'original',
      gainDb: Math.round(clamp(Number(r.audioFx?.gainDb) || 0, -30, 30) * 10) / 10,
      normalize: !!r.audioFx?.normalize,
    },
    outputs,
    extraOutputArgs: str(r.extraOutputArgs),
    preview: !!r.preview,
    previewQuality: ['low', 'hd', 'copy'].includes(r.previewQuality) ? r.previewQuality : 'low',
    autoRestart: r.autoRestart !== false,
    autoStart: !!r.autoStart,
    record: {
      enabled: !!r.record?.enabled,
      format: ['mkv', 'mp4', 'ts'].includes(r.record?.format) ? r.record.format : 'mkv',
      splitMinutes: [10, 30, 60].includes(Number(r.record?.splitMinutes)) ? Number(r.record.splitMinutes) : 0,
    },
  };
}

// Settings saved by older versions may lack the newer fields; run them through the same cleaning.
function upgrade(cfg) {
  try { return normalize(cfg, cfg.id, cfg); } catch { return { ...normalize({ ...cfg, picture: {}, preview: true }, cfg.id, cfg) }; }
}

/* ------------------------------------------------------------------ a stream */

const STATE_OF = { running: 'running', restarting: 'down', starting: 'connecting', waiting: 'connecting' };

class Stream {
  constructor(cfg) {
    this.cfg = cfg;
    this.started = false;
    this.rep = newReport();
    this.logs = [];
    this.newLogs = [];
    this.fallback = { video: false, audio: false };
    this.workers = new Map();      // worker id -> Worker; 'ingest', 'dest:<id>', 'record', 'preview'
    this.sampler = null;
    this.resetStats();
    this.syncWorkers();
  }

  resetStats() {
    this.stats = { frame: 0, fps: 0, bitrate: 0, inBitrate: 0, speed: 0, size: 0, drop: 0, dup: 0, outTime: 0 };
    this.history = [];
    this.samples = 0;
    this.prevBytes = 0;
    this.prevTs = 0;
    this.lastError = '';
  }

  /* ---- workers ---- */

  get ingest() { return this.workers.get('ingest'); }
  get id() { return this.cfg.id; }
  get sdpPath() { return path.join(SDP_DIR, `${this.cfg.id}.sdp`).replace(/\\/g, '/'); }

  destIds() { return this.cfg.outputs.map((o) => `dest:${o.id}`); }

  label(wid) {
    if (wid === 'ingest') return 'source';
    if (wid === 'record' || wid === 'preview') return wid;
    return `dest ${this.destIds().indexOf(wid) + 1}`;
  }

  // The ffmpeg arguments a worker would use right now. forSig builds without time-dependent parts so two
  // builds can be compared to see whether a settings change affects this worker.
  argsFor(wid, forSig = false) {
    const cfg = this.cfg;
    const ingestWorker = this.workers.get('ingest');
    // Signatures must depend on the settings only, never on what the source turned out to be at run time.
    const srcH = forSig ? 0 : Number((/x(\d+)/.exec(ingestWorker?.info.video?.resolution || '') || [])[1]) || 0;
    const ctx = {
      sdpPath: this.sdpPath,
      relayUrl: relay.url(cfg.id),
      hlsUrl: `${hlsStore.ingestBase}/ingest/${hlsStore.token}/${cfg.id}/index.m3u8`,
      fontFile: ff.findFont(),
      logoPath: cfg.picture.logo.enabled && cfg.picture.logo.file ? logoPath(cfg.picture.logo.file).replace(/\\/g, '/') : '',
      sourceHeight: srcH,
      recDir: recordDir(cfg.id).replace(/\\/g, '/'),
      recName: cfg.name.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'stream',
      recStamp: '0',
    };
    if (!forSig) {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      ctx.recStamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    }
    if (wid === 'ingest') {
      if (!forSig) {
        if (cfg.input.playlist) writePlaylist(cfg);
        if (protocolOf(cfg.input.url) === 'rtp' && cfg.input.type === 'url') fs.writeFileSync(this.sdpPath, cfg.input.sdp.replace(/\r?\n/g, '\r\n') + '\r\n');
      }
      return ff.ingestArgs(cfg, ctx, forSig ? {} : this.fallback);
    }
    if (wid === 'record') {
      if (!forSig) fs.mkdirSync(recordDir(cfg.id), { recursive: true });
      return ff.recordArgs(cfg, ctx);
    }
    if (wid === 'preview') return ff.previewArgs(cfg, ctx);
    const dest = cfg.outputs.find((o) => `dest:${o.id}` === wid);
    if (!dest) throw new Error('This destination was removed');
    return ff.destArgs(cfg, dest, ctx);
  }

  makeWorker(wid) {
    const isIngest = wid === 'ingest';
    const kind = isIngest ? 'ingest' : wid.startsWith('dest:') ? 'dest' : wid;
    const listen = isIngest && this.cfg.input.type === 'listen';
    const w = new Worker({
      id: wid,
      kind,
      ffmpeg: FFMPEG,
      outKind: isIngest ? 'relay' : kind,
      quietUntilData: listen,
      autoRestart: () => this.cfg.autoRestart || (isIngest && this.cfg.input.type === 'listen'),
      build: () => this.argsFor(wid),
      // Everything except the ingest reads the relay, so it waits until the source is delivering.
      ready: isIngest ? null : () => relay.live(this.cfg.id),
      expectErrors: isIngest ? null : () => !relay.live(this.cfg.id) || !this.started,
      onExit: isIngest ? (info) => this.onIngestExit(info) : undefined,
    });
    w.sig = '';
    this.wire(w, wid);
    return w;
  }

  wire(w, wid) {
    const isIngest = wid === 'ingest';
    w.on('log', (line) => this.addLog(this.label(wid), line));
    w.on('problem', (line, level) => {
      this.rep[level === 'error' ? 'errors' : 'warnings']++;
      this.countMessage(line, level);
      if (isIngest && level === 'error') this.lastError = line;
    });
    w.on('state', (s) => {
      if (isIngest && s === 'running') { this.lastError = ''; this.addEvent('Connected, receiving data', 'running'); }
    });
    if (isIngest) w.on('inputinfo', (info) => this.checkRelayCompat(w, info));
    w.on('stalled', (secs) => {
      if (!isIngest) return;
      this.rep.stalls++;
      this.addEvent(`No data for ${secs} s`, 'down');
    });
    w.on('resumed', () => { if (isIngest) this.addEvent('Data resumed', 'running'); });
    w.on('restarting', (code, delay) => {
      if (isIngest && this.pendingFallback) { this.pendingFallback = false; return; }   // planned restart, not a failure
      if (isIngest) {
        this.addEvent(this.cfg.input.type === 'listen' ? 'Sender disconnected, waiting for a new connection'
          : `Connection lost (code ${code}), reconnecting in ${delay / 1000} s`, 'down');
      } else {
        this.addEvent(`${this.label(wid)} restarted (code ${code})`, this.eventState());
      }
    });
    w.on('exit', () => {
      const b = this.rep.base;
      if (isIngest) { b.media += w.stats.outTime; return; }
      if (w.kind === 'dest') { b.bytesOut += w.stats.size; b.frames += w.stats.frame; b.drops += w.stats.drop; b.dups += w.stats.dup; }
    });
    w.on('fatal', (msg) => {
      if (isIngest) {
        this.lastError = msg;
        this.addEvent('Stopped: the source cannot be used (see the log)', 'stopped');
        this.haltAll();
      } else {
        this.addEvent(`${this.label(wid)} stopped: ${msg.replace(/^\[[^\]]*\]\s*/, '').slice(0, 120)}`, this.eventState());
      }
    });
    w.on('gaveup', () => {
      if (isIngest) { this.addEvent('Stopped after an error', 'stopped'); this.haltAll(); }
    });
  }

  eventState() { return STATE_OF[this.ingest?.status] || 'stopped'; }

  // The relay carries MPEG-TS. Codecs it cannot describe properly (PCM audio, MJPEG video, ...) would be passed as
  // anonymous data and silently lost downstream, so they are converted at the source instead: audio to AAC, video to H.264.
  checkRelayCompat(worker, info) {
    const AUDIO_OK = /^(aac|mp3|mp2|ac3|eac3|dts|opus)$/i;
    const VIDEO_OK = /^(h264|hevc|mpeg2video|mpeg1video|mpeg4)$/i;
    const notes = [];
    if (info.audio && !AUDIO_OK.test(info.audio.codec) && !this.fallback.audio) {
      this.fallback.audio = true;
      notes.push(`the source audio (${info.audio.codec}) is converted to AAC`);
    }
    if (info.video && !VIDEO_OK.test(info.video.codec) && !this.fallback.video) {
      this.fallback.video = true;
      notes.push(`the source video (${info.video.codec}) is converted to H.264`);
    }
    if (!notes.length) return;
    worker.note(`> ${notes.join(' and ')} so that every part of the stream can use it; restarting the source`);
    this.pendingFallback = true;
    worker.proc?.kill();
  }

  // Decides what happens when the source process ends.
  onIngestExit({ code, worker }) {
    const cfg = this.cfg;
    if (this.pendingFallback) return 'immediate';
    // The relay is MPEG-TS, which cannot hold some codecs (PCM audio, MJPEG video, ...): convert just that part and retry.
    const tail = worker.recent.slice(-25).join('\n');
    if (/could not find tag for codec|not currently supported in container|could not write header/i.test(tail)) {
      const audio = worker.info.audio?.codec, video = worker.info.video?.codec;
      const mentions = (c) => c && new RegExp(`\\b${c}\\b`, 'i').test(tail);
      const compatibleAudio = /^(aac|mp3|mp2|ac3|eac3|opus|dts)$/i;
      if (!this.fallback.audio && audio && (mentions(audio) || (!mentions(video) && !compatibleAudio.test(audio)))) {
        this.fallback.audio = true;
        worker.note(`> the source audio (${audio}) cannot go through the relay as-is, converting it to AAC`);
        return 'immediate';
      }
      if (!this.fallback.video && video) {
        this.fallback.video = true;
        worker.note(`> the source video (${video}) cannot go through the relay as-is, converting it to H.264`);
        return 'immediate';
      }
    }
    if (cfg.input.type === 'listen') return 'immediate';
    const finite = (cfg.input.type === 'media' && !cfg.input.loop)
      || (cfg.input.type === 'url' && !cfg.input.loop && ['file', 'http', 'https'].includes(protocolOf(cfg.input.url)));
    if (code === 0 && finite) {
      this.addEvent('Finished (end of source)', 'stopped');
      this.haltAll();
      return 'finished';
    }
    return undefined;
  }

  // Stops every worker without touching the ingest that is calling us.
  haltAll() {
    this.started = false;
    for (const w of this.workers.values()) if (w.id !== 'ingest') w.stop();
    this.stopSampler();
  }

  // Creates or removes workers so they match the current settings. Returns the ids that need a restart.
  syncWorkers() {
    const want = ['ingest', ...this.destIds()];
    if (this.cfg.record.enabled) want.push('record');
    if (this.cfg.preview) want.push('preview');
    const restart = [];
    for (const wid of [...this.workers.keys()]) {
      if (!want.includes(wid)) {
        this.workers.get(wid).stop();
        this.workers.delete(wid);
      }
    }
    for (const wid of want) {
      let w = this.workers.get(wid);
      if (!w) {
        w = this.makeWorker(wid);
        this.workers.set(wid, w);
        if (this.started && wid !== 'ingest' && this.autoWorker(wid)) w.start();
      }
      // A listener behaves differently from other sources (no stall kill, restarts quickly), so rebuild it if the type changed.
      if (wid === 'ingest' && w.opts.quietUntilData !== (this.cfg.input.type === 'listen')) {
        w.opts.quietUntilData = this.cfg.input.type === 'listen';
      }
      let sig = '';
      try { sig = JSON.stringify(this.argsFor(wid, true)); } catch (e) { sig = `error:${e.message}`; }
      if (w.sig && w.sig !== sig && w.desired) restart.push(wid);
      w.sig = sig;
    }
    return restart;
  }

  // Whether a worker starts together with the stream (disabled destinations stay off until switched on by hand).
  autoWorker(wid) {
    if (wid.startsWith('dest:')) return this.cfg.outputs.find((o) => `dest:${o.id}` === wid)?.enabled;
    return true;
  }

  async applyConfig(cfg) {
    const prevInput = JSON.stringify(this.cfg.input);
    const wasOn = new Map(this.cfg.outputs.map((o) => [`dest:${o.id}`, o.enabled]));
    this.cfg = cfg;
    if (prevInput !== JSON.stringify(cfg.input)) this.fallback = { video: false, audio: false };
    const restart = this.syncWorkers();
    if (!this.started) return;
    // Ticking or unticking "On" for an existing destination starts or stops it straight away.
    for (const o of cfg.outputs) {
      const wid = `dest:${o.id}`;
      if (wasOn.has(wid) && wasOn.get(wid) !== o.enabled) {
        if (o.enabled) this.workers.get(wid).start(); else this.workers.get(wid).stop();
      }
    }
    // The source restarts first when it changed: that also disconnects every reader, which then reconnect on their own.
    const ordered = restart.includes('ingest') ? ['ingest'] : restart;
    for (const wid of ordered) {
      this.addEvent(`Settings changed: restarting ${this.label(wid)}`, this.eventState());
      this.workers.get(wid).restart();
    }
  }

  /* ---- control ---- */

  start() {
    if (this.started) return;
    this.started = true;
    this.rep = newReport();
    this.resetStats();
    this.fallback = { video: false, audio: false };
    relay.reset(this.id);
    hlsStore.clear(this.id);
    for (const w of this.workers.values()) w.resetReport();
    this.addEvent('Started', 'connecting');
    this.syncWorkers();
    this.ingest.start();
    for (const [wid, w] of this.workers) if (wid !== 'ingest' && this.autoWorker(wid)) w.start();
    this.startSampler();
  }

  async stop() {
    const wasStarted = this.started;
    this.started = false;
    this.stopSampler();
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
    relay.reset(this.id);
    hlsStore.clear(this.id);
    if (wasStarted) this.addEvent('Stopped', 'stopped');
  }

  async control(wid, action) {
    const w = this.workers.get(wid);
    if (!w) throw Object.assign(new Error('Unknown part of the stream'), { status: 404 });
    if (!this.started) throw new Error('Start the stream first');
    if (action === 'start') w.start();
    else if (action === 'stop') await w.stop();
    else if (action === 'restart') {
      // Restarting the source restarts everything that reads it, which is what the user expects.
      await w.restart();
    } else throw new Error('Unknown action');
    this.addEvent(`${this.label(wid)}: ${action} requested`, this.eventState());
  }

  /* ---- sampling ---- */

  startSampler() {
    this.stopSampler();
    this.sampler = setInterval(() => this.sample(), SAMPLE_MS);
  }

  stopSampler() {
    clearInterval(this.sampler);
    this.sampler = null;
  }

  // The destination whose numbers represent the stream: the first one that is delivering.
  primary() {
    for (const wid of this.destIds()) {
      const w = this.workers.get(wid);
      if (w && w.status === 'running') return w;
    }
    for (const wid of ['record', 'preview']) {
      const w = this.workers.get(wid);
      if (w && w.status === 'running') return w;
    }
    return null;
  }

  sample() {
    const now = Date.now();
    const ing = this.ingest;
    const s = this.stats;
    const bytes = relay.bytes(this.id);
    if (this.prevTs && now > this.prevTs) {
      const kbps = ((bytes - this.prevBytes) * 8) / ((now - this.prevTs) / 1000) / 1000;
      s.inBitrate = s.inBitrate ? s.inBitrate * 0.6 + kbps * 0.4 : kbps;
    }
    this.prevBytes = bytes;
    this.prevTs = now;
    if (ing.status !== 'running' || !relay.live(this.id)) { if (ing.status !== 'running') s.inBitrate = 0; return; }

    const p = this.primary();
    const src = p || ing;
    s.frame = src.stats.frame; s.size = src.stats.size; s.drop = src.stats.drop; s.dup = src.stats.dup; s.outTime = src.stats.outTime;
    s.bitrate = p ? p.stats.bitrate : 0;
    s.fps = p ? p.stats.fps : ing.stats.fps;
    // Speed: the slowest running process decides whether the server keeps up with real time.
    const speeds = [...this.workers.values()].filter((w) => w.status === 'running' && w.stats.speed > 0).map((w) => w.stats.speed);
    s.speed = speeds.length ? Math.min(...speeds) : 0;

    const rep = this.rep;
    if (rep.lastTs) rep.runningMs += Math.min(now - rep.lastTs, 2000);
    rep.lastTs = now;
    if (++this.samples <= WARMUP_SAMPLES) return;
    if (now - rep.lastSeries >= SERIES_EVERY_MS) {
      rep.lastSeries = now;
      rep.series.push({ t: now, i: +s.inBitrate.toFixed(1), o: +s.bitrate.toFixed(1), f: s.fps, s: s.speed });
      if (rep.series.length > SERIES_MAX) rep.series.shift();
    }
    this.history.push({ t: now, bitrate: +s.bitrate.toFixed(1), inBitrate: +s.inBitrate.toFixed(1), fps: s.fps, speed: s.speed });
    if (this.history.length > HISTORY_LEN) this.history.shift();
  }

  /* ---- logs and events ---- */

  addLog(label, line) {
    const entry = `${new Date().toISOString().slice(11, 19)} [${label}] ${line}`;
    this.logs.push(entry);
    if (this.logs.length > LOG_LEN) this.logs.shift();
    this.newLogs.push(entry);
  }

  drainLogs() {
    const l = this.newLogs;
    this.newLogs = [];
    return l;
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

  /* ---- views used by the dashboard and the report ---- */

  get status() {
    const ing = this.ingest.status;
    if (ing === 'error') return 'error';
    if (!this.started) return ing === 'stopping' ? 'stopping' : 'stopped';
    if (ing === 'starting' && this.cfg.input.type === 'listen') return 'waiting';
    return ing;
  }

  get proc() { return this.started ? this.ingest.proc : null; }
  get inBytes() { return relay.bytes(this.id); }
  get restarts() { return this.ingest.restarts; }
  get startedAt() { return this.ingest.startedAt; }

  get info() {
    const ing = this.ingest.info;
    const outputs = [];
    for (const [wid, w] of this.workers) {
      if (wid === 'ingest') continue;
      const o = w.info.outputs[0];
      if (o) outputs.push({ ...o, id: wid, index: outputs.length, url: wid.startsWith('dest:') ? maskSecrets(o.url) : o.url });
    }
    return { format: ing.format, bitrate: ing.bitrate, video: ing.video, audio: ing.audio, outputs };
  }

  get command() {
    const parts = [];
    for (const [wid, w] of this.workers) if (w.command) parts.push(`# ${this.label(wid)}\n${w.command}`);
    return parts.join('\n\n');
  }

  get counters() {
    return { warnings: this.rep.warnings, errors: this.rep.errors };
  }

  // What the destinations have delivered so far in this session (finished runs plus the ones still running).
  currentTotals() {
    const t = { bytesOut: 0, frames: 0, drops: 0, dups: 0, media: this.ingest.proc ? this.ingest.stats.outTime : 0 };
    for (const [wid, w] of this.workers) {
      if (!wid.startsWith('dest:') || !w.proc) continue;
      t.bytesOut += w.stats.size; t.frames += w.stats.frame; t.drops += w.stats.drop; t.dups += w.stats.dup;
    }
    return t;
  }

  destinationReport() {
    const rows = [];
    for (const wid of [...this.destIds(), 'record', 'preview']) {
      const w = this.workers.get(wid);
      if (!w) continue;
      const dest = wid.startsWith('dest:') ? this.cfg.outputs.find((o) => `dest:${o.id}` === wid) : null;
      rows.push({
        id: wid, kind: w.kind, label: this.label(wid), url: dest ? maskSecrets(dest.url) : '', preset: dest ? dest.preset : '',
        status: w.status, restarts: w.restarts, runningMs: w.rep.runningMs, errors: w.rep.errors, warnings: w.rep.warnings,
        avgBitrate: w.rep.bitrateN ? w.rep.bitrateSum / w.rep.bitrateN : 0, maxBitrate: w.rep.bitrateMax,
        avgFps: w.rep.bitrateN ? w.rep.fpsSum / w.rep.bitrateN : 0,
      });
    }
    return rows;
  }

  workerViews() {
    const rows = [];
    for (const [wid, w] of this.workers) {
      const dest = wid.startsWith('dest:') ? this.cfg.outputs.find((o) => `dest:${o.id}` === wid) : null;
      rows.push({
        ...w.snapshot(),
        label: this.label(wid),
        url: dest ? maskSecrets(dest.url) : wid === 'ingest' ? maskSecrets(this.cfg.input.url) : '',
        preset: dest ? dest.preset : '',
        enabled: dest ? dest.enabled : true,
        history: w.history.slice(-60).map((h) => h.bitrate),
      });
    }
    return rows;
  }

  snapshot() {
    const ing = this.ingest;
    return {
      ...this.cfg,
      // Saved secrets never leave the server; the form only learns that they are set.
      input: {
        ...this.cfg.input,
        password: '',
        passwordSet: !!this.cfg.input.password,
        listen: this.cfg.input.listen ? { ...this.cfg.input.listen, passphrase: '', passphraseSet: !!this.cfg.input.listen.passphrase } : null,
      },
      runtime: {
        status: this.status,
        stalled: this.started && ing.stalled,
        startedAt: this.proc ? ing.startedAt : 0,
        uptime: this.proc && ing.startedAt ? Date.now() - ing.startedAt : 0,
        restarts: this.restarts,
        stats: this.stats,
        info: this.info,
        history: this.history,
        counters: this.counters,
        lastError: this.lastError,
        command: this.command,
        fallback: this.fallback,
        relay: { live: relay.live(this.id), readers: relay.readers(this.id), bytes: relay.bytes(this.id) },
        workers: this.workerViews(),
      },
    };
  }

  // One JPEG of the live picture.
  snapshotJpeg() {
    if (!relay.live(this.id)) return Promise.reject(Object.assign(new Error('The stream is not delivering video right now'), { status: 409 }));
    return new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ff.snapshotArgs({ relayUrl: relay.url(this.id) }), { windowsHide: true });
      const chunks = [];
      const timer = setTimeout(() => p.kill(), 15000);
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (buf.length > 100) resolve(buf);
        else reject(new Error('Could not capture a picture (no video yet?)'));
      });
    });
  }
}

/* ------------------------------------------------------------------ manager */

class Manager {
  constructor() {
    this.runners = new Map();
    this.load();
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      for (const cfg of list) this.runners.set(cfg.id, new Stream(upgrade(cfg)));
      this.save();   // settings from an older version now have the newer fields and stable destination ids
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

  // Rejects an encoder that was tested and does not work here, so it fails on save instead of in a restart loop.
  checkEncoders(cfg) {
    const bad = (name, what) => {
      if (encoders[name] === false) {
        const hw = /nvenc|qsv|amf/.test(name);
        throw new Error(`The ${what} encoder "${name}" does not work on this server.${hw ? ' Hardware encoders need a GPU that the machine can use, which a virtual machine usually does not have. Use libx264 (software) or one of the conversion presets.' : ' Choose a different codec.'}`);
      }
    };
    if (cfg.video.mode === 'transcode') bad(cfg.video.codec, 'video');
    if (cfg.audio.mode === 'transcode') bad(cfg.audio.codec, 'audio');
  }

  // Two streams cannot listen on the same port.
  checkListenPorts(cfg) {
    if (cfg.input.type !== 'listen') return;
    for (const r of this.runners.values()) {
      const l = r.cfg.input.listen;
      if (r.cfg.id !== cfg.id && r.cfg.input.type === 'listen' && l.port === cfg.input.listen.port && l.protocol === cfg.input.listen.protocol) {
        throw new Error(`The stream "${r.cfg.name}" already listens on ${l.protocol.toUpperCase()} port ${l.port}. Choose another port.`);
      }
    }
  }

  async create(body) {
    const id = crypto.randomUUID();
    const cfg = normalize(body, id);
    this.checkEncoders(cfg);
    this.checkListenPorts(cfg);
    const stream = new Stream(cfg);
    this.runners.set(id, stream);
    this.save();
    return stream.snapshot();
  }

  async update(id, body) {
    const stream = this.get(id);
    const cfg = normalize(body, id, stream.cfg);
    this.checkEncoders(cfg);
    this.checkListenPorts(cfg);
    await stream.applyConfig(cfg);
    this.save();
    return stream.snapshot();
  }

  async control(id, wid, action) {
    await this.get(id).control(wid, action);
  }

  /* ---- media library ---- */

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

  /* ---- logo images ---- */

  logoList() {
    const files = fs.readdirSync(LOGO_DIR)
      .filter((n) => LOGO_EXT.test(n))
      .map((name) => ({ name, size: fs.statSync(path.join(LOGO_DIR, name)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { files };
  }

  logoDelete(name) {
    const p = logoPath(name);
    const user = [...this.runners.values()].find((r) => r.cfg.picture.logo.enabled && r.cfg.picture.logo.file === name);
    if (user) throw new Error(`"${name}" is used by the stream "${user.cfg.name}". Remove it from that stream first.`);
    fs.rmSync(p);
  }

  /* ---- recordings ---- */

  recordings(id) {
    const stream = this.get(id);
    const dir = recordDir(id);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => REC_EXT.test(n)); } catch { /* nothing recorded yet */ }
    const rec = stream.workers.get('record');
    const recording = !!rec && rec.status === 'running';
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
    const stream = this.get(id);
    await stream.stop();
    this.runners.delete(id);
    relay.reset(id);
    hlsStore.clear(id);
    fs.rmSync(stream.sdpPath, { force: true });
    fs.rmSync(playlistPath(id), { force: true });
    this.save();
  }

  async shutdown() {
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
  }
}

/* ------------------------------------------------------------------ probing and system */

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

// ffmpeg lists hardware encoders (NVENC, QSV, AMF) even on machines without the hardware, so each one is
// tried on a tiny test clip. true = works, false = fails, null = still being tested.
const ENCODER_LIST = {
  video: ['libx264', 'libx265', 'mpeg2video', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'h264_amf'],
  audio: ['aac', 'mp2', 'ac3', 'libopus'],
};
const encoders = {};

function testEncoder(name, kind) {
  const src = kind === 'video' ? ['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25', '-frames:v', '5', '-c:v', name]
    : ['-f', 'lavfi', '-i', 'sine=frequency=440:d=0.3', '-c:a', name];
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-v', 'error', ...src, '-f', 'null', '-'], { timeout: 20000, windowsHide: true }, (err) => resolve(!err));
  });
}

async function detectEncoders() {
  const all = Object.entries(ENCODER_LIST).flatMap(([kind, names]) => names.map((n) => [n, kind]));
  all.forEach(([n]) => { encoders[n] = null; });
  for (const [name, kind] of all) encoders[name] = await testEncoder(name, kind);
}

async function systemInfo() {
  try {
    const out = await run(FFMPEG, ['-version'], 5000);
    return { ok: true, version: out.split('\n')[0], encoders: { ...encoders }, font: !!ff.findFont() };
  } catch (e) {
    return { ok: false, error: `ffmpeg not found (${FFMPEG}). Install it or set FFMPEG_PATH.` };
  }
}

module.exports = { Manager, probe, systemInfo, detectEncoders, hlsStore, relay, MEDIA_DIR, MEDIA_EXT, LOGO_DIR, LOGO_EXT };
