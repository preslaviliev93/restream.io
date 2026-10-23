'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mask = (u) => String(u || '').replace(/(:\/\/[^/\s:@]+:)[^@/\s]+@/g, '$1****@');
const proto = (u) => (/^([a-z][a-z0-9+.-]*):\/\//i.exec(u || '') || [, 'file'])[1].toLowerCase();
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const streams = new Map();   // id -> snapshot from the server
const cards = new Map();     // id -> { el, video, hls, key }
let detailId = null;
let editId = null;
let step = 1;
let logBuf = [];
let recTimer = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ================= formatting ================= */
const fmtBitrate = (k) => (k >= 1000 ? (k / 1000).toFixed(2) + ' Mb/s' : Math.round(k) + ' kb/s');
const fmtUp = (ms) => {
  const s = Math.floor(ms / 1000), p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' kB');
const up = (x) => (x ? String(x).toUpperCase() : '');
const kbps = (n) => (n ? fmtBitrate(n) : '');

const STATUS_TEXT = {
  running: 'Live', starting: 'Connecting', restarting: 'Reconnecting', stopping: 'Stopping',
  stopped: 'Stopped', error: 'Error', stalled: 'No data',
};
const statusOf = (s) => (s.runtime.stalled ? 'stalled' : s.runtime.status);
const isActive = (s) => ['running', 'starting', 'restarting'].includes(s.runtime.status);

const PROTO_LABEL = { rtsp: 'RTSP', rtsps: 'RTSP', rtmp: 'RTMP', rtmps: 'RTMP', srt: 'SRT', udp: 'UDP', rtp: 'RTP', http: 'HTTP', https: 'HTTP', tcp: 'TCP' };
function describe(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/?#]*)/i.exec(mask(url));
  if (!m) return 'File ' + String(url).split(/[\\/]/).pop();
  const p = m[1].toLowerCase();
  return `${PROTO_LABEL[p] || p.toUpperCase()} ${m[2]}`.trim();
}

function routeText(s) {
  const dests = s.outputs.filter((o) => o.enabled).map((o) => describe(o.url));
  if (s.record?.enabled) dests.push('Recording');
  if (!dests.length) dests.push('Preview only');
  return `${sourceText(s)}  \u2192  ${dests.join(', ')}`;
}

function sourceText(s) {
  if (s.input.type !== 'media') return describe(s.input.url);
  const f = s.input.files || [];
  return `Server video ${f[0] || ''}${f.length > 1 ? ` +${f.length - 1} more` : ''}${s.input.loop ? ', looping' : ''}`;
}

// Turns raw ffmpeg messages into something a person can act on.
const ERRORS = [
  [/401|unauthorized|authorization failed/i, 'The login was rejected', 'Check the username and password for the source.'],
  [/connection refused/i, 'The source refused the connection', 'Check the address and port, and that the device is switched on.'],
  [/timed out|timeout|no route to host|network is unreachable/i, 'The source cannot be reached', 'Check the address and your network connection.'],
  [/does not resolve|getaddrinfo|name or service not known|could not resolve/i, 'An address is not valid', 'Check host names and IP addresses. An IP address needs four numbers, like 239.100.100.1.'],
  [/could not write header|not currently supported in container|incorrect codec parameters/i, 'A destination cannot carry this video or audio format', 'Edit the stream and choose "Keep video, fix audio" in the Convert step.'],
  [/no such file|not found/i, 'File or path not found', 'Check the file path or stream path.'],
  [/address already in use|bind failed/i, 'That port is already in use', 'Choose a different port.'],
  [/invalid data found/i, 'The source sent data that cannot be read', 'Check that the address points to a real video stream.'],
  [/protocol not found/i, 'Unsupported address type', 'Check the address starts with a supported prefix such as rtsp://.'],
];
function explain(text) {
  const hit = ERRORS.find(([re]) => re.test(text || ''));
  return hit ? { title: hit[1], hint: hit[2] } : null;
}
function alertFor(s) {
  const rt = s.runtime, st = statusOf(s);
  if (st === 'stalled') return { kind: 'warn', title: 'No data from the source', hint: 'The connection is open but nothing has arrived for a few seconds.' };
  if (['restarting', 'error', 'starting'].includes(rt.status) && rt.lastError) {
    const e = explain(rt.lastError);
    return { kind: 'bad', title: e?.title || 'There was a problem', hint: e?.hint || rt.lastError };
  }
  return null;
}
function paintAlert(el, a) {
  el.hidden = !a;
  if (!a) return;
  el.className = `alert ${a.kind === 'bad' ? 'bad' : ''}`;
  el.innerHTML = `<b>${esc(a.title)}</b>${esc(a.hint)}`;
}

/* ================= charts ================= */
// lines: [{ values, color }]. Several lines share one scale so they can be compared directly.
function drawChart(canvas, lines, { min = 0, label = (v) => v } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const len = Math.max(...lines.map((l) => l.values.length));
  if (len < 2) return;
  const max = Math.max(min, ...lines.flatMap((l) => l.values)) * 1.15 || 1;
  const x = (i) => (i / (len - 1)) * w;
  const y = (v) => h - 2 - (v / max) * (h - 4);
  c.strokeStyle = cssVar('--line');
  c.lineWidth = 1;
  for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, (h / 4) * i); c.lineTo(w, (h / 4) * i); c.stroke(); }
  lines.forEach(({ values, color }, k) => {
    c.beginPath();
    values.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
    c.strokeStyle = color;
    c.lineWidth = 1.8;
    c.stroke();
    if (k === 0) {
      c.lineTo(x(values.length - 1), h); c.lineTo(0, h); c.closePath();
      c.globalAlpha = 0.13; c.fillStyle = color; c.fill(); c.globalAlpha = 1;
    }
  });
  c.fillStyle = cssVar('--mute');
  c.font = '11px system-ui';
  c.fillText(label(max), 4, 12);
}

/* ================= dashboard cards ================= */
function makeCard(id) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="view">
      <video muted autoplay playsinline controls></video>
      <div class="ph"></div>
      <span class="pill"></span>
      <span class="rec" hidden>REC</span>
    </div>
    <div class="body">
      <h3></h3>
      <p class="route"></p>
      <p class="fmt"></p>
      <div class="alert" hidden></div>
      <div class="metrics">
        <div><b data-k="inbitrate">-</b><span>Input</span></div>
        <div><b data-k="bitrate">-</b><span>Output</span></div>
        <div><b data-k="fps">-</b><span>Frames/s</span></div>
        <div><b data-k="up">-</b><span>Running for</span></div>
      </div>
    </div>
    <div class="actions">
      <button class="btn primary" data-a="toggle">Start</button>
      <button class="btn" data-a="detail">Details</button>
      <span class="sp"></span>
      <button class="btn" data-a="edit">Edit</button>
    </div>`;
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const s = streams.get(id);
    if (!a || !s) return;
    try {
      if (a === 'toggle') await api('POST', `/api/streams/${id}/${isActive(s) ? 'stop' : 'start'}`);
      else if (a === 'detail') openDetail(id);
      else if (a === 'edit') openEdit(s);
    } catch (err) { alert(err.message); }
  });
  $('#grid').appendChild(el);
  const c = { el, video: $('video', el), hls: null, key: '' };
  // Hide the "preparing" text as soon as frames are available, without waiting for the next refresh.
  c.video.addEventListener('loadeddata', () => { $('.ph', el).hidden = true; });
  c.video.addEventListener('playing', () => { $('.ph', el).hidden = true; });
  cards.set(id, c);
  return c;
}

function syncPreview(c, s) {
  const want = s.preview && s.runtime.status === 'running' ? `${s.id}:${s.runtime.startedAt}` : '';
  const ph = $('.ph', c.el);
  if (want !== c.key) {
    c.key = want;
    if (c.hls) { c.hls.destroy(); c.hls = null; }
    c.video.removeAttribute('src');
    c.video.load();
    if (want) attachHls(c, `/hls/${s.id}/index.m3u8`);
  }
  c.video.hidden = !want;
  ph.hidden = !!want && c.video.readyState >= 2;
  ph.textContent = !s.preview ? 'Preview is turned off for this stream'
    : s.runtime.status === 'running' ? 'Preparing preview...'
      : isActive(s) ? 'Connecting to the source...' : 'Stream is stopped';
}

function attachHls(c, src) {
  if (window.Hls && Hls.isSupported()) {
    c.hls = new Hls({
      liveSyncDurationCount: 2, manifestLoadingMaxRetry: 60, manifestLoadingRetryDelay: 1000,
      manifestLoadingMaxRetryTimeout: 2000, levelLoadingMaxRetry: 20,
    });
    c.hls.loadSource(src);
    c.hls.attachMedia(c.video);
    c.hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) c.hls.startLoad();
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) c.hls.recoverMediaError();
    });
    c.video.onplaying = () => { $('.ph', c.el).hidden = true; };
  } else {
    c.video.src = src;
  }
}

function formatLine(info) {
  const v = info.video, a = info.audio;
  if (!v && !a) return 'Reading stream details...';
  const vp = v ? [up(v.codec), v.resolution, v.fps ? `${v.fps} fps` : ''].filter(Boolean).join(' ') : 'No video';
  const ap = a ? [up(a.codec), a.sampleRate ? `${a.sampleRate / 1000} kHz` : '', a.channels].filter(Boolean).join(' ') : 'No audio';
  return `${vp}  |  ${ap}`;
}

function render() {
  for (const [id, c] of cards) if (!streams.has(id)) { c.hls?.destroy(); c.el.remove(); cards.delete(id); }
  $('#empty').hidden = streams.size > 0;
  const live = [...streams.values()].filter((s) => s.runtime.status === 'running').length;
  $('#summary').textContent = streams.size ? `${streams.size} stream${streams.size === 1 ? '' : 's'}, ${live} live` : '';

  for (const s of streams.values()) {
    const c = cards.get(s.id) || makeCard(s.id);
    const rt = s.runtime, st = statusOf(s), el = c.el;
    $('h3', el).textContent = s.name;
    $('.route', el).textContent = routeText(s);
    const pill = $('.pill', el);
    pill.textContent = STATUS_TEXT[st] || st;
    pill.className = `pill ${st}`;
    $('.rec', el).hidden = !(s.record?.enabled && rt.status === 'running');
    $('.fmt', el).textContent = rt.status === 'stopped' ? '' : formatLine(rt.info);
    paintAlert($('.alert', el), alertFor(s));
    const live2 = rt.status === 'running';
    $('[data-k=inbitrate]', el).textContent = live2 ? fmtBitrate(rt.stats.inBitrate) : '-';
    $('[data-k=bitrate]', el).textContent = live2 ? fmtBitrate(rt.stats.bitrate) : '-';
    $('[data-k=fps]', el).textContent = live2 ? rt.stats.fps.toFixed(1) : '-';
    $('[data-k=up]', el).textContent = rt.uptime ? fmtUp(rt.uptime) : '-';
    const btn = $('[data-a=toggle]', el);
    btn.textContent = isActive(s) ? 'Stop' : 'Start';
    btn.className = `btn ${isActive(s) ? 'stop' : 'primary'}`;
    syncPreview(c, s);
  }
  if (detailId) renderDetail();
}

/* ================= details ================= */
function openDetail(id, tab = 'ov') {
  detailId = id;
  logBuf = [];
  api('GET', `/api/streams/${id}/logs`).then((l) => { logBuf = l; paintLog(); }).catch(() => {});
  $('#detailDlg').showModal();
  selectTab(tab);
  renderDetail();
}

function selectTab(tab) {
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== tab));
  clearInterval(recTimer);
  if (tab === 'rec') { loadRecordings(); recTimer = setInterval(loadRecordings, 5000); }
  if (tab === 'log') { paintLog(); $('#dLog').scrollTop = 1e9; }
  if (tab === 'rep') loadReport();
  renderDetail();
}

function loadReport() {
  const base = `/api/streams/${detailId}`;
  $('#repFrame').src = `${base}/report.html?t=${Date.now()}`;
  $('#repOpen').href = `${base}/report.html`;
  $('#repDl').href = `${base}/report.html?download=1`;
  $('#repJson').href = `${base}/report.json`;
  $('#repCsv').href = `${base}/report.csv`;
}
$('#repRefresh').addEventListener('click', loadReport);

function paintLog() {
  const pre = $('#dLog');
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = logBuf.join('\n');
  if (stick) pre.scrollTop = pre.scrollHeight;
}

function renderFormatTable(s) {
  const info = s.runtime.info;
  const st = s.runtime.stats, live = s.runtime.status === 'running';
  // Sources often do not declare a bitrate, so fall back to what the server actually measures.
  const inText = info.bitrate ? kbps(info.bitrate) : live && st.inBitrate ? `${fmtBitrate(st.inBitrate)} (measured)` : '';
  const cols = [{ title: 'Input', sub: sourceText(s), format: info.format, bitrateText: inText, video: info.video, audio: info.audio }];
  // ffmpeg's size counter follows its first output, which is the first destination (or recording/preview if none).
  const visible = info.outputs.filter((o) => o.kind !== 'tap');
  let destNo = 1;
  visible.forEach((o, i) => {
    const t = !live || !st.bitrate || o.kind === 'preview' ? ''
      : i === 0 ? `${fmtBitrate(st.bitrate)} (measured)` : `about ${fmtBitrate(st.bitrate)} (same settings)`;
    const title = o.kind === 'record' ? 'Recording' : o.kind === 'preview' ? 'Live preview' : `Destination ${destNo++}`;
    const sub = o.kind === 'dest' ? mask(o.url) : o.kind === 'preview' ? 'low resolution, for the dashboard' : o.url.split('/').pop();
    cols.push({ title, sub, format: o.format, bitrateText: t, video: o.video, audio: o.audio });
  });
  const rows = [
    ['Container', (c) => c.format],
    ['Total bitrate', (c) => c.bitrateText],
    ['Video codec', (c) => up(c.video?.codec)],
    ['Profile', (c) => c.video?.profile],
    ['Resolution', (c) => c.video?.resolution],
    ['Aspect ratio', (c) => c.video?.aspect],
    ['Frame rate', (c) => (c.video?.fps ? `${c.video.fps} fps` : '')],
    ['Pixel format', (c) => c.video?.pixFmt],
    ['Video bitrate', (c) => kbps(c.video?.bitrate)],
    ['Audio codec', (c) => up(c.audio?.codec)],
    ['Sample rate', (c) => (c.audio?.sampleRate ? `${c.audio.sampleRate / 1000} kHz` : '')],
    ['Channels', (c) => c.audio?.channels],
    ['Audio bitrate', (c) => kbps(c.audio?.bitrate)],
  ];
  const cell = (v) => (v ? esc(v) : '<span class="dim">-</span>');
  $('#dFormat').innerHTML =
    `<thead><tr><th></th>${cols.map((c) => `<th>${c.title}<small>${esc(c.sub)}</small></th>`).join('')}</tr></thead><tbody>${
      rows.map(([label, fn]) => `<tr><th>${label}</th>${cols.map((c) => `<td>${cell(fn(c))}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function renderDetail() {
  const s = streams.get(detailId);
  if (!s) return $('#detailDlg').close();
  const rt = s.runtime, st = rt.stats, h = rt.history;
  const tab = $('.tabs button.on')?.dataset.tab;
  $('#dName').textContent = s.name;
  $('#dRoute').textContent = routeText(s);
  const sb = $('#dStatus');
  sb.textContent = STATUS_TEXT[statusOf(s)];
  sb.className = `pill ${statusOf(s)}`;
  $('#dCmd').textContent = rt.command || '(not started yet)';
  if (tab === 'fmt') renderFormatTable(s);
  if (tab !== 'ov') return;

  paintAlert($('#dAlert'), alertFor(s));
  const last = h[h.length - 1] || { bitrate: 0, fps: 0, speed: 0 };
  const live = rt.status === 'running';
  $('#tInBitrate').textContent = live ? fmtBitrate(last.inBitrate || 0) : '-';
  $('#tBitrate').textContent = live ? fmtBitrate(last.bitrate) : '-';
  $('#tFps').textContent = live ? last.fps.toFixed(1) : '-';
  $('#tSpeed').textContent = live ? last.speed.toFixed(2) + 'x' : '-';
  $('#tUp').textContent = rt.uptime ? fmtUp(rt.uptime) : '-';
  $('#tRestarts').textContent = rt.restarts ? `${rt.restarts} reconnect${rt.restarts === 1 ? '' : 's'}` : 'No reconnects';
  drawChart($('#chBitrate'), [
    { values: h.map((x) => x.inBitrate || 0), color: cssVar('--accent') },
    { values: h.map((x) => x.bitrate), color: cssVar('--ok') },
  ], { label: fmtBitrate });
  drawChart($('#chFps'), [{ values: h.map((x) => x.fps), color: cssVar('--ok') }], { min: 30, label: (v) => v.toFixed(0) + ' fps' });
  drawChart($('#chSpeed'), [{ values: h.map((x) => x.speed), color: cssVar('--warn') }], { min: 1.5, label: (v) => v.toFixed(2) + 'x' });

  const err = rt.lastError ? (explain(rt.lastError)?.title || '') : '';
  const rows = [
    ['Data sent', `${fmtBytes(st.size)} (${st.frame} frames, ${st.outTime.toFixed(0)} s of media)`],
    ['Dropped frames', `<span class="${st.drop ? 'warn' : ''}">${st.drop}</span>`],
    ['Duplicated frames', String(st.dup)],
    ['Bitrate, average / peak', h.length ? `${fmtBitrate(h.reduce((t, x) => t + x.bitrate, 0) / h.length)} / ${fmtBitrate(Math.max(...h.map((x) => x.bitrate)))}` : '-'],
    ['Warnings in log', `<span class="${rt.counters.warnings ? 'warn' : ''}">${rt.counters.warnings}</span>`],
    ['Errors in log', `<span class="${rt.counters.errors ? 'bad' : ''}">${rt.counters.errors}</span>`],
    ['Last error', rt.lastError ? `${err ? `<b>${esc(err)}</b><br>` : ''}<span class="dim">${esc(rt.lastError)}</span>` : '-'],
  ];
  $('#dTable').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
}

async function loadRecordings() {
  if (!detailId) return;
  const s = streams.get(detailId);
  try {
    const r = await api('GET', `/api/streams/${detailId}/recordings`);
    const state = s?.record?.enabled ? 'Recording is on for this stream.' : 'Recording is off for this stream. Turn it on under Edit, step 3.';
    $('#recSummary').innerHTML = `${state}<br>Saved in <code>${esc(r.dir)}</code> - ${r.files.length} file${r.files.length === 1 ? '' : 's'}, ${fmtBytes(r.total)}`;
    $('#recList').innerHTML = r.files.length ? r.files.map((f) => `
      <div class="rec-row">
        <span class="name">${esc(f.name)} ${f.active ? '<span class="live">RECORDING</span>' : ''}</span>
        <span class="meta">${f.active ? 'being recorded...' : `${fmtBytes(f.size)} - ${new Date(f.mtime).toLocaleString()}`}</span>
        ${f.active ? '' : `<a class="btn sm" href="/api/streams/${detailId}/recordings/${encodeURIComponent(f.name)}">Download</a>`}
        <button class="btn sm danger-text" data-del="${esc(f.name)}" ${f.active ? 'disabled' : ''}>Delete</button>
      </div>`).join('') : '<p class="note">No recordings yet.</p>';
  } catch (e) {
    $('#recList').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

$('#recList').addEventListener('click', async (e) => {
  const name = e.target.dataset.del;
  if (!name || !confirm(`Delete ${name}? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/streams/${detailId}/recordings/${encodeURIComponent(name)}`);
    loadRecordings();
  } catch (err) { alert(err.message); }
});
$$('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
$('#dClose').addEventListener('click', () => $('#detailDlg').close());
$('#detailDlg').addEventListener('close', () => { detailId = null; clearInterval(recTimer); });

/* ================= create / edit ================= */
const form = $('#form');

const PRESETS = {
  audio_fix: { video: { mode: 'copy' }, audio: { mode: 'transcode', codec: 'aac', bitrate: 128 } },
  original: { video: { mode: 'copy' }, audio: { mode: 'copy' } },
  hd720: { video: { mode: 'transcode', codec: 'libx264', preset: 'veryfast', bitrate: 2500, width: 1280, height: 720 }, audio: { mode: 'transcode', codec: 'aac', bitrate: 128 } },
  hd1080: { video: { mode: 'transcode', codec: 'libx264', preset: 'veryfast', bitrate: 5000, width: 1920, height: 1080 }, audio: { mode: 'transcode', codec: 'aac', bitrate: 128 } },
};

const BLANK = { video: { mode: 'copy', codec: 'libx264', preset: 'veryfast', bitrate: '', width: '', height: '', fps: '', gop: '' }, audio: { mode: 'copy', codec: 'aac', bitrate: '', sampleRate: '' } };

function matchPreset(v, a) {
  const same = (x, y) => Object.entries(y).every(([k, val]) => x[k] === val);
  const plain = !v.fps && !v.gop && !a.sampleRate;
  if (plain) {
    for (const [name, p] of Object.entries(PRESETS)) {
      const vOk = p.video.mode === 'copy' ? v.mode === 'copy' : v.mode === 'transcode' && same(v, p.video);
      const aOk = p.audio.mode === 'copy' ? a.mode === 'copy' : a.mode === 'transcode' && same(a, p.audio);
      if (vOk && aOk) return name;
    }
  }
  return 'custom';
}

function setFields(obj) {
  for (const el of form.elements) {
    if (!el.name || el.name.startsWith('_')) continue;
    const v = getPath(obj, el.name);
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v || v === 0 ? v : '';
  }
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  setFields({ video: { ...BLANK.video, ...p.video }, audio: { ...BLANK.audio, ...p.audio } });
  updateVisibility();
}

function setPath(obj, path, val) {
  const keys = path.split('.');
  keys.slice(0, -1).reduce((o, k) => (o[k] ??= {}), obj)[keys.at(-1)] = val;
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const chosenPreset = () => $('input[name=_preset]:checked')?.value || 'custom';
const srcType = () => $('input[name=_src]:checked')?.value || 'url';

/* ---- server video library ---- */
let mediaFiles = [];
let mediaSel = [];   // selected file names, in play order

async function loadMedia() {
  try { mediaFiles = (await api('GET', '/api/media')).files; } catch (e) { mediaFiles = []; $('#mediaProg').textContent = e.message; }
  renderMedia();
}

function renderMedia() {
  const el = $('#mediaList');
  mediaSel = mediaSel.filter((n) => mediaFiles.some((f) => f.name === n));
  el.innerHTML = mediaFiles.length ? mediaFiles.map((f) => {
    const i = mediaSel.indexOf(f.name);
    return `<div class="media-row ${i >= 0 ? 'sel' : ''}">
      <label><input type="checkbox" data-pick="${esc(f.name)}" ${i >= 0 ? 'checked' : ''}><span class="ord">${i + 1}</span><span>${esc(f.name)}</span></label>
      <span class="meta">${fmtBytes(f.size)}</span>
      <button type="button" class="btn sm danger-text" data-mdel="${esc(f.name)}">Delete</button></div>`;
  }).join('') : '<p class="note">No videos on the server yet. Upload one to get started.</p>';
}

$('#mediaList').addEventListener('change', (e) => {
  const name = e.target.dataset.pick;
  if (!name) return;
  mediaSel = e.target.checked ? [...mediaSel, name] : mediaSel.filter((n) => n !== name);
  renderMedia();
});
$('#mediaList').addEventListener('click', async (e) => {
  const name = e.target.dataset.mdel;
  if (!name || !confirm(`Delete "${name}" from the server?`)) return;
  try { await api('DELETE', `/api/media/${encodeURIComponent(name)}`); await loadMedia(); } catch (err) { alert(err.message); }
});

$('#mediaUpBtn').onclick = () => $('#mediaFile').click();
$('#mediaFile').addEventListener('change', async (e) => {
  const prog = $('#mediaProg');
  for (const file of [...e.target.files]) {
    try {
      const res = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/media/${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) prog.textContent = `Uploading ${file.name}: ${Math.round((ev.loaded / ev.total) * 100)}%`; };
        xhr.onload = () => {
          const body = JSON.parse(xhr.responseText || '{}');
          xhr.status < 300 ? resolve(body) : reject(new Error(body.error || `Upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Upload failed: connection lost'));
        xhr.send(file);
      });
      mediaSel.push(res.name);
      prog.textContent = `Uploaded ${res.name}`;
    } catch (err) {
      prog.textContent = err.message;
    }
  }
  e.target.value = '';
  await loadMedia();
});

// Looping is the point of streaming a stored video, so switch it on when the user first picks that source.
$('#srcType').addEventListener('change', () => {
  if (srcType() === 'media' && !editId) form.elements['input.loop'].checked = true;
  updateVisibility();
});

function updateVisibility() {
  const p = proto(form.elements['input.url'].value);
  $$('[data-for=rtsp]').forEach((e) => (e.hidden = !/^rtsps?$/.test(p)));
  $$('[data-for=rtp]').forEach((e) => (e.hidden = p !== 'rtp'));
  const media = srcType() === 'media';
  $$('[data-src]').forEach((e) => (e.hidden = e.dataset.src !== srcType()));
  $$('[data-for=loop]').forEach((e) => (e.hidden = !(media || p === 'file')));
  $$('[data-for=auth]').forEach((e) => (e.hidden = ['file', 'udp', 'rtp'].includes(p)));
  $$('[data-for=vtx]').forEach((e) => (e.hidden = form.elements['video.mode'].value !== 'transcode'));
  $$('[data-for=atx]').forEach((e) => (e.hidden = form.elements['audio.mode'].value !== 'transcode'));
  $('#customConv').hidden = chosenPreset() !== 'custom';
  $('#recOpts').hidden = !$('#recOn').checked;
}
form.addEventListener('input', updateVisibility);
form.addEventListener('change', updateVisibility);
$('#presets').addEventListener('change', () => { if (chosenPreset() !== 'custom') applyPreset(chosenPreset()); updateVisibility(); });

/* ---- destinations ---- */
function parseDest(url) {
  const m = /^(udp|rtp):\/\/([^/?#:@]+):(\d+)$/i.exec(url || '');
  return m ? { type: m[1].toLowerCase(), host: m[2], port: m[3], url: '' } : { type: 'url', host: '', port: '', url: url || '' };
}

function addDest(o = { url: '', enabled: true }) {
  const d = parseDest(o.url);
  if (!o.url) d.type = 'udp';   // the most common destination, so a new row starts as UDP
  const row = document.createElement('div');
  row.className = 'dest';
  row.innerHTML = `
    <select class="d-type">
      <option value="udp">UDP</option><option value="rtp">RTP</option>
      <option value="url">Other URL (SRT, RTMP...)</option>
    </select>
    <input class="d-host" placeholder="Address, e.g. 239.100.100.1" autocomplete="off">
    <input class="d-port" type="number" min="1" max="65535" placeholder="Port">
    <input class="d-url" placeholder="srt://host:9000   rtmp://server/live/key   C:\\video\\out.mp4" autocomplete="off">
    <label class="on"><input type="checkbox" class="d-on"> On</label>
    <button type="button" class="btn sm danger-text">Remove</button>`;
  $('.d-type', row).value = d.type;
  $('.d-host', row).value = d.host;
  $('.d-port', row).value = d.port;
  $('.d-url', row).value = d.url;
  $('.d-on', row).checked = o.enabled !== false;
  const sync = () => {
    const other = $('.d-type', row).value === 'url';
    $('.d-host', row).hidden = $('.d-port', row).hidden = other;
    $('.d-url', row).hidden = !other;
  };
  $('.d-type', row).addEventListener('change', sync);
  $('button', row).onclick = () => row.remove();
  sync();
  $('#dests').appendChild(row);
}
$('#addDest').onclick = () => addDest();

function readDests() {
  const out = [];
  for (const row of $$('.dest')) {
    const type = $('.d-type', row).value, on = $('.d-on', row).checked;
    if (type === 'url') {
      const url = $('.d-url', row).value.trim();
      if (url) out.push({ url, enabled: on });
      continue;
    }
    const host = $('.d-host', row).value.trim(), port = $('.d-port', row).value.trim();
    if (!host && !port) continue;
    if (!host || !port) throw new Error(`A ${type.toUpperCase()} destination needs both an address and a port.`);
    out.push({ url: `${type}://${host}:${port}`, enabled: on });
  }
  return out;
}

/* ---- steps ---- */
function showStep(n) {
  step = n;
  $$('.step').forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
  $$('#steps li').forEach((li) => {
    const i = Number(li.dataset.go);
    li.classList.toggle('on', i === n);
    li.classList.toggle('done', i < n);
  });
  $('#backBtn').hidden = n === 1;
  $('#nextBtn').hidden = n === 3;
  $('#saveBtn').hidden = n < 3 && !editId;
  $('#formErr').hidden = true;
}

function validateStep1() {
  if (srcType() === 'media') return mediaSel.length ? '' : 'Pick at least one video, or upload one.';
  const url = form.elements['input.url'].value.trim();
  if (!url) return 'Enter where the stream comes from.';
  if (proto(url) === 'rtp' && !form.elements['input.sdp'].value.trim()) return 'rtp:// sources need an SDP description.';
  return '';
}
function showErr(msg) {
  const e = $('#formErr');
  e.textContent = msg;
  e.hidden = !msg;
}
function goTo(n) {
  if (n > 1) { const err = validateStep1(); if (err) { showStep(1); return showErr(err); } }
  showStep(n);
}
$('#nextBtn').onclick = () => goTo(step + 1);
$('#backBtn').onclick = () => showStep(step - 1);
$$('#steps li').forEach((li) => li.addEventListener('click', () => goTo(Number(li.dataset.go))));
$('#cancelBtn').onclick = () => $('#editDlg').close();
$('#newBtn').onclick = () => openEdit(null);
$('#emptyBtn').onclick = () => openEdit(null);

const DEFAULTS = {
  name: '', input: { type: 'url', files: [], url: '', username: '', password: '', rtspTransport: 'tcp', sdp: '', loop: false, extra: '' },
  video: BLANK.video, audio: BLANK.audio, outputs: [{ url: '', enabled: true }],
  extraOutputArgs: '', preview: true, autoRestart: true, autoStart: false,
  record: { enabled: false, format: 'mkv', splitMinutes: 0 },
};

function openEdit(s) {
  editId = s?.id || null;
  const d = s || DEFAULTS;
  $('#editTitle').textContent = s ? `Edit "${s.name}"` : 'New stream';
  $('#delBtn').hidden = !s;
  $('#probeOut').hidden = true;
  showErr('');
  form.reset();
  setFields(d);
  if (!s) applyPreset('audio_fix');
  $('#inPass').placeholder = d.input.passwordSet ? 'saved - leave empty to keep' : '';
  $$('input[name=_src]').forEach((r) => (r.checked = r.value === (d.input.type || 'url')));
  mediaSel = [...(d.input.files || [])];
  $('#mediaProg').textContent = '';
  loadMedia();
  const preset = s ? matchPreset(d.video, d.audio) : 'audio_fix';
  $$('input[name=_preset]').forEach((r) => (r.checked = r.value === preset));
  $('#dests').innerHTML = '';
  (d.outputs.length ? d.outputs : DEFAULTS.outputs).forEach(addDest);
  updateVisibility();
  showStep(1);
  $('#editDlg').showModal();
}

function readForm() {
  if (chosenPreset() !== 'custom') applyPreset(chosenPreset());
  const body = {};
  for (const el of form.elements) {
    if (!el.name || el.name.startsWith('_')) continue;
    setPath(body, el.name, el.type === 'checkbox' ? el.checked : el.value);
  }
  body.outputs = readDests();
  body.input.type = srcType();
  body.input.files = srcType() === 'media' ? [...mediaSel] : [];
  if (srcType() === 'media') body.input.url = '';
  return body;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (step < 3 && !editId) return goTo(step + 1);
  try {
    const err = validateStep1();
    if (err) { showStep(1); return showErr(err); }
    const body = readForm();
    if (editId) await api('PUT', `/api/streams/${editId}`, body);
    else await api('POST', '/api/streams', body);
    $('#editDlg').close();
    await refresh();
  } catch (err) {
    showErr(err.message);
  }
});

$('#delBtn').onclick = async () => {
  const s = streams.get(editId);
  if (!s || !confirm(`Delete "${s.name}"? Its recordings stay on disk.`)) return;
  try {
    await api('DELETE', `/api/streams/${editId}`);
    $('#editDlg').close();
    await refresh();
  } catch (err) { showErr(err.message); }
};

$('#probeBtn').onclick = async () => {
  const out = $('#probeOut');
  out.hidden = false;
  out.className = 'probe-out';
  out.textContent = 'Connecting...';
  const err = validateStep1();
  if (err) { out.className = 'probe-out bad'; out.textContent = err; return; }
  try {
    const f = form.elements;
    const r = await api('POST', '/api/probe', {
      url: f['input.url'].value, sdp: f['input.sdp'].value, rtspTransport: f['input.rtspTransport'].value,
      username: f['input.username'].value, password: f['input.password'].value, streamId: editId,
    });
    const lines = ['<p><b>Connected.</b></p>'];
    const v = (r.streams || []).find((x) => x.codec_type === 'video');
    const a = (r.streams || []).find((x) => x.codec_type === 'audio');
    lines.push(v
      ? `<p>Video: ${esc(up(v.codec_name))} ${esc(v.profile || '')} ${v.width}x${v.height}, ${esc(v.avg_frame_rate)} fps</p>`
      : '<p>Video: none found</p>');
    lines.push(a
      ? `<p>Audio: ${esc(up(a.codec_name))}, ${a.sample_rate} Hz, ${esc(a.channel_layout || a.channels + ' channels')}</p>`
      : '<p>Audio: none found</p>');
    if (a && /^pcm_/.test(a.codec_name)) {
      lines.push('<p class="dim">This audio format cannot be sent over UDP, RTP or SRT as-is. The recommended option in the next step converts it for you.</p>');
    }
    out.innerHTML = lines.join('');
  } catch (e) {
    const ex = explain(e.message);
    out.className = 'probe-out bad';
    out.innerHTML = `<p><b>${esc(ex?.title || 'Could not connect')}</b></p>${ex ? `<p>${esc(ex.hint)}</p>` : ''}<p class="dim">${esc(e.message)}</p>`;
  }
};

/* ================= live data ================= */
async function refresh() {
  const list = await api('GET', '/api/streams');
  streams.clear();
  list.forEach((s) => streams.set(s.id, s));
  render();
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  const conn = $('#conn');
  ws.onopen = () => { conn.textContent = 'Live updates on'; conn.className = 'chip ok'; };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type !== 'state') return;
    streams.clear();
    m.streams.forEach((s) => streams.set(s.id, s));
    if (detailId && m.logs[detailId]) {
      logBuf.push(...m.logs[detailId]);
      if (logBuf.length > 500) logBuf = logBuf.slice(-500);
      if (!$('#dLog').closest('section').hidden) paintLog();
    }
    render();
  };
  ws.onclose = () => { conn.textContent = 'Disconnected, retrying...'; conn.className = 'chip bad'; setTimeout(connect, 2000); };
}

api('GET', '/api/system').then((s) => {
  const el = $('#sys');
  if (s.ok) { el.textContent = s.version.split(' ').slice(0, 3).join(' '); el.className = 'chip ok'; }
  else { el.textContent = 'ffmpeg missing'; el.className = 'chip bad'; const b = $('#banner'); b.textContent = s.error; b.hidden = false; }
});
refresh().then(connect);
