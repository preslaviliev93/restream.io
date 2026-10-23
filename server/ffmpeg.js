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
      break;
    default:
  }
  a.push('-fflags', '+genpts+discardcorrupt');

  if (proto === 'rtp') {
    a.push('-protocol_whitelist', 'file,udp,rtp,crypto', '-i', ctx.sdpPath);
  } else if (proto === 'udp') {
    a.push('-i', withQuery(input.url, { fifo_size: 5000000, overrun_nonfatal: 1 }));
  } else {
    a.push('-i', input.url);
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

function buildArgs(cfg, ctx) {
  const a = ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', '-y'];
  a.push(...inputArgs(cfg, ctx));

  for (const out of cfg.outputs.filter((o) => o.enabled && o.url)) {
    a.push('-map', '0:v?', '-map', '0:a?');
    a.push(...videoArgs(cfg.video), ...audioArgs(cfg.audio));
    a.push(...splitArgs(cfg.extraOutputArgs));
    a.push(...outputFormat(out.url), outputUrl(out.url));
  }

  if (cfg.preview) {
    a.push(
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-vf', 'scale=-2:360', '-pix_fmt', 'yuv420p', '-b:v', '700k', '-g', '30',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
      '-hls_segment_filename', ctx.hlsDir + '/seg%d.ts',
      ctx.hlsDir + '/index.m3u8'
    );
  }
  return a;
}

module.exports = { buildArgs, protocolOf, splitArgs };
