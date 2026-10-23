// Builds ffmpeg argument arrays from a stream config. Never goes through a shell.

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
    .replace(/(passphrase=)[^&\s]+/gi, '$1****');
}

function inputArgs(cfg, ctx) {
  const { input } = cfg;
  const proto = protocolOf(input.url);
  const a = [];
  a.push(...splitArgs(input.extra));
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

  if (proto === 'rtp') {
    a.push('-protocol_whitelist', 'file,udp,rtp,crypto', '-i', ctx.sdpPath);
  } else if (proto === 'udp') {
    a.push('-i', withQuery(input.url, { fifo_size: 5000000, overrun_nonfatal: 1 }));
  } else {
    a.push('-i', authUrl(input));
  }
  return a;
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

function videoArgs(v) {
  if (v.mode !== 'transcode') return ['-c:v', 'copy'];
  const a = ['-c:v', v.codec || 'libx264'];
  if (/^lib(x264|x265)$/.test(a[1])) {
    if (v.preset) a.push('-preset', v.preset);
    if (a[1] === 'libx264') a.push('-tune', 'zerolatency');
  }
  if (v.bitrate) a.push('-b:v', `${v.bitrate}k`, '-maxrate', `${v.bitrate}k`, '-bufsize', `${v.bitrate * 2}k`);
  if (v.width || v.height) a.push('-vf', `scale=${v.width || -2}:${v.height || -2}`);
  if (v.fps) a.push('-r', String(v.fps));
  if (v.gop) a.push('-g', String(v.gop));
  a.push('-pix_fmt', 'yuv420p');
  return a;
}

function audioArgs(au) {
  if (au.mode === 'none') return ['-an'];
  if (au.mode !== 'transcode') return ['-c:a', 'copy'];
  const a = ['-c:a', au.codec || 'aac'];
  if (au.bitrate) a.push('-b:a', `${au.bitrate}k`);
  if (au.sampleRate) a.push('-ar', String(au.sampleRate));
  return a;
}

function outputUrl(url) {
  return protocolOf(url) === 'udp' ? withQuery(url, { pkt_size: 1316 }) : url;
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
  const a = ['-map', '0:v?', '-map', '0:a?', ...videoArgs(cfg.video), ...audioArgs(cfg.audio)];
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

function buildArgs(cfg, ctx) {
  const a = ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', '-y'];
  a.push(...inputArgs(cfg, ctx));

  for (const out of cfg.outputs.filter((o) => o.enabled && o.url)) {
    a.push('-map', '0:v?', '-map', '0:a?');
    a.push(...videoArgs(cfg.video), ...audioArgs(cfg.audio));
    a.push(...splitArgs(cfg.extraOutputArgs));
    a.push(...outputFormat(out.url), outputUrl(out.url));
  }

  if (cfg.record?.enabled) a.push(...recordArgs(cfg, ctx));

  // Bare copy of the incoming packets, only used by the server to measure the input bitrate.
  // Must come after the real outputs: ffmpeg's progress size refers to the first output.
  a.push('-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'matroska', '-live', '1', '-method', 'PUT', ctx.tapUrl);

  if (cfg.preview) {
    a.push(
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-vf', 'scale=-2:360', '-pix_fmt', 'yuv420p', '-b:v', '700k', '-g', '30',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
      '-hls_flags', 'omit_endlist+independent_segments',
      // The preview is uploaded to this server and kept in memory (no playlist renames on disk,
      // which Windows refuses while a browser is reading the file).
      '-method', 'PUT',
      ctx.hlsUrl
    );
  }
  return a;
}

module.exports = { buildArgs, protocolOf, splitArgs, authUrl, maskSecrets };
