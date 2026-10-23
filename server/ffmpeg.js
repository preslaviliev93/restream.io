// Builds ffmpeg argument arrays. Never goes through a shell.
//
// A stream is split into several ffmpeg processes around an internal relay:
//   ingest      source -> relay            (copy; audio/video re-encoded only if the relay container cannot hold them)
//   destination relay -> conversion -> url (one process per destination)
//   record      relay -> conversion -> files
//   preview     relay -> low-res HLS -> browser
//   snapshot    relay -> one JPEG
const fs = require('fs');

function protocolOf(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url || '');
  return m ? m[1].toLowerCase() : 'file';
}

// Minimal quote-aware tokenizer for user-supplied extra args.
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function withQuery(url, params) {
  const missing = Object.entries(params).filter(([k]) => !new RegExp(`[?&]${k}=`).test(url));
  if (!missing.length) return url;
  return url + (url.includes('?') ? '&' : '?') + missing.map(([k, v]) => `${k}=${v}`).join('&');
}

// Inserts the separately stored username/password into the URL (percent-encoded).
// A URL that already carries credentials is left alone.
function authUrl({ url, username, password }) {
  if (!username || protocolOf(url) === 'file') return url;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)(?![^/?#]*@)/i, (_m, scheme) =>
    `${scheme}${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@`);
}

// Hides passwords before text is logged or shown.
function maskSecrets(text) {
  return String(text)
    .replace(/(:\/\/[^/\s:@]+:)[^@/\s]+@/g, '$1****@')
    .replace(/(passphrase=)[^&\s]+/gi, '$1****')
    .replace(/(\/(?:relay|ingest)\/)[0-9a-f]{32}\//g, '$1****/');   // the internal relay and preview upload tokens
}

/* ------------------------------------------------------------------ conversion presets */

// Same presets the dashboard offers; a destination can pick one to override the stream's own conversion.
const PRESETS = {
  audio_fix: { video: { mode: 'copy' }, audio: { mode: 'transcode', codec: 'aac', bitrate: 128 } },
  original: { video: { mode: 'copy' }, audio: { mode: 'copy' } },
  hd720: {
    video: { mode: 'transcode', codec: 'libx264', preset: 'veryfast', bitrate: 2500, width: 1280, height: 720 },
    audio: { mode: 'transcode', codec: 'aac', bitrate: 128 },
  },
  hd1080: {
    video: { mode: 'transcode', codec: 'libx264', preset: 'veryfast', bitrate: 5000, width: 1920, height: 1080 },
    audio: { mode: 'transcode', codec: 'aac', bitrate: 128 },
  },
};

const cropActive = (c) => !!(c && (c.left || c.right || c.top || c.bottom));
const pictureActive = (p) => !!(p && (p.rotate || p.flipH || p.flipV || p.deinterlace || cropActive(p.crop) || p.text?.enabled || p.logo?.enabled));
const audioFxActive = (a) => !!(a && (a.source === 'silence' || a.gainDb || a.normalize));

// The video/audio settings a destination really uses: its own preset, else the stream's. Picture and sound
// adjustments cannot be applied to copied streams, so they force a re-encode.
function effective(cfg, dest) {
  const preset = dest && dest.preset && dest.preset !== 'inherit' ? PRESETS[dest.preset] : null;
  let video = { ...(preset ? preset.video : cfg.video) };
  let audio = { ...(preset ? preset.audio : cfg.audio) };
  if (pictureActive(cfg.picture) && video.mode !== 'transcode') {
    video = { mode: 'transcode', codec: 'libx264', preset: 'veryfast', bitrate: 0, width: 0, height: 0, fps: 0, gop: 0 };
  }
  if (audioFxActive(cfg.audioFx) && audio.mode === 'copy') audio = { mode: 'transcode', codec: 'aac', bitrate: 128 };
  return { video, audio };
}

/* ------------------------------------------------------------------ picture and sound filters */

let fontCache;
function findFont() {
  if (fontCache !== undefined) return fontCache;
  const candidates = [
    process.env.FONT_FILE,
    'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
  ].filter(Boolean);
  fontCache = candidates.find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || '';
  return fontCache;
}

const COLORS = { white: 'white', yellow: 'yellow', red: 'red', green: 'lime', cyan: 'cyan', black: 'black' };
const TEXT_SIZES = { small: 'h/36', medium: 'h/24', large: 'h/14' };
const TEXT_POS = {
  'top-left': 'x=w*0.02:y=h*0.03',
  'top-right': 'x=w-tw-w*0.02:y=h*0.03',
  'bottom-left': 'x=w*0.02:y=h-th-h*0.03',
  'bottom-right': 'x=w-tw-w*0.02:y=h-th-h*0.03',
  center: 'x=(w-tw)/2:y=(h-th)/2',
};
const LOGO_POS = {
  'top-left': 'x=20:y=20',
  'top-right': 'x=W-w-20:y=20',
  'bottom-left': 'x=20:y=H-h-20',
  'bottom-right': 'x=W-w-20:y=H-h-20',
  center: 'x=(W-w)/2:y=(H-h)/2',
};

// Characters that mean something to the filter parser or to drawtext's own %{...} expansion are replaced.
const plainText = (s) => String(s).replace(/['\\%{}]/g, ' ').replace(/:/g, '\\:').trim();

function drawtext(t, fontFile) {
  const parts = [];
  const text = plainText(t.content || '');
  if (text) parts.push(text);
  if (t.clock) parts.push('%{localtime}');
  if (!parts.length) return null;
  const font = fontFile ? `fontfile='${fontFile.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : '';
  return `drawtext=${font}text='${parts.join('  ')}':fontsize=${TEXT_SIZES[t.size] || TEXT_SIZES.medium}`
    + `:fontcolor=${COLORS[t.color] || 'white'}${t.box ? ':box=1:boxcolor=black@0.55:boxborderw=8' : ''}:${TEXT_POS[t.position] || TEXT_POS['top-left']}`;
}

// Filters that run on the decoded video, in a sensible order: clean up, reshape, size, then draw on top.
function videoFilters(cfg, video, ctx) {
  const p = cfg.picture || {};
  const f = [];
  if (p.deinterlace) f.push('yadif');
  if (cropActive(p.crop)) {
    const c = p.crop;
    f.push(`crop=trunc((iw-${c.left + c.right})/2)*2:trunc((ih-${c.top + c.bottom})/2)*2:${c.left}:${c.top}`);
  }
  if (p.rotate === 90) f.push('transpose=1');
  else if (p.rotate === 270) f.push('transpose=2');
  else if (p.rotate === 180) f.push('hflip', 'vflip');
  if (p.flipH) f.push('hflip');
  if (p.flipV) f.push('vflip');
  if (video.width || video.height) f.push(`scale=${video.width || -2}:${video.height || -2}`);
  if (p.text?.enabled) {
    const d = drawtext(p.text, ctx.fontFile);
    if (d) f.push(d);
  }
  return f;
}

function audioFilters(fx) {
  const f = [];
  if (fx && fx.gainDb) f.push(`volume=${fx.gainDb}dB`);
  if (fx && fx.normalize) f.push('dynaudnorm=f=150:g=15');
  return f;
}

/* ------------------------------------------------------------------ codec options */

function videoCodecArgs(v) {
  if (v.mode !== 'transcode') return ['-c:v', 'copy'];
  const a = ['-c:v', v.codec || 'libx264'];
  if (/^lib(x264|x265)$/.test(a[1])) {
    if (v.preset) a.push('-preset', v.preset);
    if (a[1] === 'libx264') a.push('-tune', 'zerolatency');
  }
  if (v.bitrate) a.push('-b:v', `${v.bitrate}k`, '-maxrate', `${v.bitrate}k`, '-bufsize', `${v.bitrate * 2}k`);
  if (v.fps) a.push('-r', String(v.fps));
  if (v.gop) a.push('-g', String(v.gop));
  a.push('-pix_fmt', 'yuv420p');
  return a;
}

function audioCodecArgs(au) {
  if (au.mode === 'none') return [];
  if (au.mode !== 'transcode') return ['-c:a', 'copy'];
  const a = ['-c:a', au.codec || 'aac'];
  if (au.bitrate) a.push('-b:a', `${au.bitrate}k`);
  if (au.sampleRate) a.push('-ar', String(au.sampleRate));
  return a;
}

/* ------------------------------------------------------------------ inputs */

function sourceInputArgs(cfg, ctx) {
  const { input } = cfg;
  const a = [...splitArgs(input.extra)];

  if (input.type === 'listen') {
    // Wait for an encoder or camera to push to us. ffmpeg exits when the sender disconnects and is started again.
    const l = input.listen;
    a.push('-fflags', '+genpts+discardcorrupt');
    if (l.protocol === 'srt') {
      let url = `srt://0.0.0.0:${l.port}?mode=listener`;
      if (l.passphrase) url += `&passphrase=${encodeURIComponent(l.passphrase)}&pbkeylen=16`;
      a.push('-i', url);
    } else {
      a.push('-listen', '1', '-i', `rtmp://0.0.0.0:${l.port}/live/${l.key}`);
    }
    return a;
  }

  const proto = protocolOf(input.url);
  switch (proto) {
    case 'rtsp':
    case 'rtsps':
      a.push('-rtsp_transport', input.rtspTransport || 'tcp');
      break;
    case 'file':
      a.push('-re');
      if (input.loop) a.push('-stream_loop', '-1');
      if (input.playlist) a.push('-f', 'concat', '-safe', '0');
      break;
    default:
  }
  a.push('-fflags', '+genpts+discardcorrupt');

  if (proto === 'rtp') a.push('-protocol_whitelist', 'file,udp,rtp,crypto', '-i', ctx.sdpPath);
  else if (proto === 'udp') a.push('-i', withQuery(input.url, { fifo_size: 5000000, overrun_nonfatal: 1 }));
  else a.push('-i', authUrl(input));
  return a;
}

// How every other process reads the relay. The relay replays the latest keyframe to a new reader, so very
// short probing is enough and a destination starts producing output in about a second.
function relayInput(ctx) {
  return ['-fflags', '+genpts+discardcorrupt+nobuffer', '-analyzeduration', '500000', '-probesize', '2000000',
    '-seekable', '0', '-rw_timeout', '20000000', '-i', ctx.relayUrl];
}

const HEAD = ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', '-y'];

/* ------------------------------------------------------------------ ingest */

// fallback: { video, audio } set when the relay's MPEG-TS cannot carry the source codec (PCM audio, MJPEG video, ...).
function ingestArgs(cfg, ctx, fallback = {}) {
  const a = [...HEAD, ...sourceInputArgs(cfg, ctx), '-map', '0:v:0?', '-map', '0:a:0?'];
  if (fallback.video) a.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50');
  else a.push('-c:v', 'copy');
  if (fallback.audio) a.push('-c:a', 'aac', '-b:a', '128k');
  else a.push('-c:a', 'copy');
  a.push('-f', 'mpegts', '-flush_packets', '1', '-method', 'PUT', ctx.relayUrl);
  return a;
}

/* ------------------------------------------------------------------ readers */

// Inputs, maps, filters and codecs for one converted output. Several inputs may be involved: the relay (0),
// an optional silent audio track and an optional logo image.
function composeMedia(cfg, conv, ctx) {
  const inputs = relayInput(ctx);
  const out = [];
  const fx = cfg.audioFx || {};
  let next = 1;

  let silence = -1;
  if (conv.audio.mode !== 'none' && fx.source === 'silence') {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    silence = next++;
  }
  const logo = cfg.picture?.logo;
  const logoOn = !!(logo?.enabled && ctx.logoPath && conv.video.mode === 'transcode');
  let logoIdx = -1;
  if (logoOn) {
    inputs.push('-loop', '1', '-framerate', '25', '-i', ctx.logoPath);
    logoIdx = next++;
  }

  if (conv.video.mode === 'transcode') {
    const chain = videoFilters(cfg, conv.video, ctx);
    if (logoOn) {
      const outH = conv.video.height || ctx.sourceHeight || 1080;
      const logoH = Math.max(16, Math.round((outH * (logo.sizePercent || 12)) / 100 / 2) * 2);
      const opacity = Math.min(1, Math.max(0.1, (logo.opacity || 100) / 100));
      out.push('-filter_complex',
        `[0:v:0]${chain.length ? chain.join(',') : 'null'}[base];`
        + `[${logoIdx}:v]scale=-2:${logoH},format=rgba,colorchannelmixer=aa=${opacity}[lg];`
        + `[base][lg]overlay=${LOGO_POS[logo.position] || LOGO_POS['top-right']}:format=auto[vout]`,
        '-map', '[vout]');
    } else {
      out.push('-map', '0:v:0?');
      if (chain.length) out.push('-vf', chain.join(','));
    }
  } else {
    out.push('-map', '0:v:0?');
  }

  if (conv.audio.mode === 'none') {
    out.push('-an');
  } else {
    out.push('-map', silence >= 0 ? `${silence}:a` : '0:a:0?');
    const af = audioFilters(fx);
    if (af.length) out.push('-af', af.join(','));
  }
  out.push(...videoCodecArgs(conv.video), ...audioCodecArgs(conv.audio));
  return { inputs, out };
}

function outputFormat(url) {
  switch (protocolOf(url)) {
    case 'udp':
    case 'srt':
    case 'tcp':
      return ['-f', 'mpegts'];
    case 'rtp':
      return ['-f', 'rtp_mpegts'];
    case 'rtmp':
    case 'rtmps':
      return ['-f', 'flv'];
    case 'rtsp':
      return ['-f', 'rtsp', '-rtsp_transport', 'tcp'];
    default:
      return [];
  }
}

function outputUrl(url) {
  return protocolOf(url) === 'udp' ? withQuery(url, { pkt_size: 1316 }) : url;
}

function destArgs(cfg, dest, ctx) {
  const m = composeMedia(cfg, effective(cfg, dest), ctx);
  return [...HEAD, ...m.inputs, ...m.out, ...splitArgs(cfg.extraOutputArgs), ...outputFormat(dest.url), outputUrl(dest.url)];
}

const REC_FORMATS = {
  // MKV survives a crash or power loss; fragmented MP4 is the playable-anywhere alternative.
  mkv: { muxer: 'matroska', opts: [] },
  mp4: { muxer: 'mp4', opts: ['movflags=+frag_keyframe+empty_moov+default_base_moof'] },
  ts: { muxer: 'mpegts', opts: [] },
};

function recordArgs(cfg, ctx) {
  const ext = REC_FORMATS[cfg.record.format] ? cfg.record.format : 'mkv';
  const fmt = REC_FORMATS[ext];
  const m = composeMedia(cfg, effective(cfg, null), ctx);
  const a = [...HEAD, ...m.inputs, ...m.out];
  const base = `${ctx.recDir}/${ctx.recName}`;
  if (cfg.record.splitMinutes > 0) {
    a.push('-f', 'segment', '-segment_time', String(cfg.record.splitMinutes * 60), '-segment_format', fmt.muxer);
    if (fmt.opts.length) a.push('-segment_format_options', fmt.opts.join(':'));
    a.push('-reset_timestamps', '1', '-strftime', '1', `${base}_%Y%m%d-%H%M%S.${ext}`);
  } else {
    a.push('-f', fmt.muxer);
    for (const o of fmt.opts) a.push('-movflags', o.split('=')[1]);
    a.push(`${base}_${ctx.recStamp}.${ext}`);
  }
  return a;
}

function previewArgs(cfg, ctx) {
  let q = cfg.previewQuality;
  // Original quality only repackages the video, so it cannot show picture adjustments.
  if (q === 'copy' && pictureActive(cfg.picture)) q = 'hd';
  const hd = q === 'hd';
  const conv = q === 'copy'
    ? { video: { mode: 'copy' }, audio: { mode: 'transcode', codec: 'aac', bitrate: 128 } }
    : {
      video: { mode: 'transcode', codec: 'libx264', preset: 'ultrafast', bitrate: hd ? 2500 : 700, width: 0, height: hd ? 720 : 360 },
      audio: { mode: 'transcode', codec: 'aac', bitrate: hd ? 128 : 64 },
    };
  const m = composeMedia(cfg, conv, ctx);
  const a = [...HEAD, ...m.inputs, ...m.out, '-ac', '2'];
  if (q === 'copy') a.push('-f', 'hls', '-hls_time', '2', '-hls_list_size', '6');
  else a.push('-force_key_frames', 'expr:gte(t,n_forced*1)', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5');
  a.push(
    '-hls_flags', 'omit_endlist+independent_segments',
    // The preview is uploaded to this server and kept in memory (no playlist renames on disk,
    // which Windows refuses while a browser is reading the file).
    '-method', 'PUT',
    ctx.hlsUrl,
  );
  return a;
}

// One JPEG of the live picture, written to stdout.
function snapshotArgs(ctx) {
  return ['-hide_banner', '-loglevel', 'error', ...relayInput(ctx), '-map', '0:v:0?', '-an', '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
}

module.exports = {
  protocolOf, splitArgs, authUrl, maskSecrets, PRESETS, effective, pictureActive, audioFxActive,
  findFont, ingestArgs, destArgs, recordArgs, previewArgs, snapshotArgs,
};
