'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const streams = new Map();   // id -> snapshot
const cards = new Map();     // id -> { el, video, hls, key }
let detailId = null;
let editId = null;

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

const fmtBitrate = (k) => (k >= 1000 ? (k / 1000).toFixed(2) + ' Mb/s' : Math.round(k) + ' kb/s');
const fmtUp = (ms) => {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' kB');
const proto = (u) => (/^([a-z][a-z0-9+.-]*):\/\//i.exec(u || '') || [, 'file'])[1].toLowerCase();
const statusOf = (s) => (s.runtime.stalled ? 'stalled' : s.runtime.status);

/* ---------- charts ---------- */
function drawChart(canvas, values, color, { min = 0, label = (v) => v } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = Math.max(min, ...values) * 1.15 || 1;
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => h - 2 - (v / max) * (h - 4);
  c.strokeStyle = 'rgba(255,255,255,.08)';
  c.lineWidth = 1;
  for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, (h / 4) * i); c.lineTo(w, (h / 4) * i); c.stroke(); }
  c.beginPath();
  values.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.strokeStyle = color;
  c.lineWidth = 1.6;
  c.stroke();
  c.lineTo(w, h); c.lineTo(0, h); c.closePath();
  c.fillStyle = color + '22';
  c.fill();
  c.fillStyle = '#8b96a5';
  c.font = '10px system-ui';
  c.fillText(label(max), 4, 11);
}

/* ---------- cards ---------- */
function makeCard(id) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <header><h3></h3><span class="badge"></span></header>
    <div class="view"><video muted autoplay playsinline controls></video><div class="ph">No preview</div></div>
    <div class="route"></div>
    <div class="fmt"></div>
    <dl class="kpis">
      <div><dt>Bitrate</dt><dd data-k="bitrate">-</dd></div>
      <div><dt>FPS</dt><dd data-k="fps">-</dd></div>
      <div><dt>Speed</dt><dd data-k="speed">-</dd></div>
      <div><dt>Uptime</dt><dd data-k="up">-</dd></div>
    </dl>
    <canvas class="spark"></canvas>
    <footer>
      <button data-a="toggle"></button>
      <button data-a="detail">Analytics</button>
      <span class="sp"></span>
      <button data-a="edit">Edit</button>
      <button data-a="del" class="danger">Delete</button>
    </footer>`;
  el.addEventListener('click', async (e) => {
    const a = e.target.dataset?.a;
    if (!a) return;
    const s = streams.get(id);
    try {
      if (a === 'toggle') {
        const active = ['running', 'starting', 'restarting'].includes(s.runtime.status);
        await api('POST', `/api/streams/${id}/${active ? 'stop' : 'start'}`);
      } else if (a === 'detail') openDetail(id);
      else if (a === 'edit') openEdit(s);
      else if (a === 'del' && confirm(`Delete "${s.name}"?`)) await api('DELETE', `/api/streams/${id}`);
    } catch (err) { alert(err.message); }
  });
  $('#grid').appendChild(el);
  const c = { el, video: $('video', el), hls: null, key: '' };
  cards.set(id, c);
  return c;
}

function syncPreview(c, s) {
  const want = s.preview && s.runtime.status === 'running' ? `${s.id}:${s.runtime.startedAt}` : '';
  if (want === c.key) return;
  c.key = want;
  if (c.hls) { c.hls.destroy(); c.hls = null; }
  c.video.removeAttribute('src');
  c.video.load();
  $('.ph', c.el).hidden = !!want;
  $('.ph', c.el).textContent = s.preview ? 'Waiting for stream…' : 'Preview disabled';
  if (!want) return;
  const src = `/hls/${s.id}/index.m3u8`;
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
  } else {
    c.video.src = src;
  }
}

function render() {
  for (const [id, c] of cards) if (!streams.has(id)) { c.hls?.destroy(); c.el.remove(); cards.delete(id); }
  $('#empty').hidden = streams.size > 0;
  for (const s of streams.values()) {
    const c = cards.get(s.id) || makeCard(s.id);
    const rt = s.runtime, st = statusOf(s);
    const el = c.el;
    $('h3', el).textContent = s.name;
    const badge = $('.badge', el);
    badge.textContent = st;
    badge.className = `badge ${st}`;
    $('.route', el).innerHTML = `<b>${esc(s.input.url)}</b><br>→ ${
      s.outputs.filter((o) => o.enabled).map((o) => esc(o.url)).join('<br>→ ') || '(preview only)'}
      <br>${s.video.mode === 'copy' ? 'copy' : s.video.codec} / ${s.audio.mode === 'none' ? 'no audio' : s.audio.mode === 'copy' ? 'copy' : s.audio.codec}`;
    $('.fmt', el).textContent = rt.status === 'stopped' ? 'Not running' : formatLine(rt.info);
    const live = rt.status === 'running';
    $('[data-k=bitrate]', el).textContent = live ? fmtBitrate(rt.stats.bitrate) : '-';
    $('[data-k=fps]', el).textContent = live ? rt.stats.fps.toFixed(1) : '-';
    $('[data-k=speed]', el).textContent = live ? rt.stats.speed.toFixed(2) + '×' : '-';
    $('[data-k=up]', el).textContent = rt.uptime ? fmtUp(rt.uptime) : '-';
    $('[data-a=toggle]', el).textContent = ['running', 'starting', 'restarting'].includes(rt.status) ? 'Stop' : 'Start';
    syncPreview(c, s);
    drawChart($('.spark', el), rt.history.map((h) => h.bitrate), '#4c9aff');
  }
  if (detailId) renderDetail();
}

/* ---------- details ---------- */
let logBuf = [];
function openDetail(id) {
  detailId = id;
  logBuf = [];
  api('GET', `/api/streams/${id}/logs`).then((l) => { logBuf = l; paintLog(); }).catch(() => {});
  $('#detailDlg').showModal();
  renderDetail();
}

function paintLog() {
  const pre = $('#dLog');
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = logBuf.join('\n');
  if (stick) pre.scrollTop = pre.scrollHeight;
}

const up = (x) => (x ? String(x).toUpperCase() : '');
const kbps = (n) => (n ? fmtBitrate(n) : '');

// One column per endpoint (input, then each output) so conversions are easy to compare.
function renderFormatTable(s) {
  const info = s.runtime.info;
  const cols = [{ title: 'Input', sub: s.input.url, format: info.format, bitrate: info.bitrate, video: info.video, audio: info.audio }];
  info.outputs.forEach((o, i) => cols.push({ title: `Output ${i + 1}`, sub: o.url, format: o.format, video: o.video, audio: o.audio }));
  const rows = [
    ['Container', (c) => c.format],
    ['Total bitrate', (c) => kbps(c.bitrate)],
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

function formatLine(info) {
  const v = info.video, a = info.audio;
  if (!v && !a) return 'Waiting for input details...';
  const vp = v ? [up(v.codec), v.resolution, v.fps ? `${v.fps} fps` : ''].filter(Boolean).join(' ') : 'no video';
  const ap = a ? [up(a.codec), a.sampleRate ? `${a.sampleRate / 1000} kHz` : '', a.channels].filter(Boolean).join(' ') : 'no audio';
  return `${vp} | ${ap}`;
}

function renderDetail() {
  const s = streams.get(detailId);
  if (!s) return $('#detailDlg').close();
  const rt = s.runtime, st = rt.stats, h = rt.history;
  $('#dName').textContent = s.name;
  const sb = $('#dStatus');
  sb.textContent = statusOf(s);
  sb.className = `badge ${statusOf(s)}`;
  const last = h[h.length - 1] || { bitrate: 0, fps: 0, speed: 0 };
  $('#cBitrate').textContent = fmtBitrate(last.bitrate);
  $('#cFps').textContent = last.fps.toFixed(1);
  $('#cSpeed').textContent = last.speed.toFixed(2) + '×';
  drawChart($('#chBitrate'), h.map((x) => x.bitrate), '#4c9aff', { label: fmtBitrate });
  drawChart($('#chFps'), h.map((x) => x.fps), '#3ecf8e', { min: 30, label: (v) => v.toFixed(0) + ' fps' });
  drawChart($('#chSpeed'), h.map((x) => x.speed), '#f5a524', { min: 1.5, label: (v) => v.toFixed(2) + '×' });

  renderFormatTable(s);
  const rows = [
    ['Frames / data sent', `${st.frame} frames · ${fmtBytes(st.size)} · ${st.outTime.toFixed(1)}s of media`],
    ['Dropped / duplicated frames', `<span class="${st.drop ? 'warn' : ''}">${st.drop}</span> / ${st.dup}`],
    ['Uptime / restarts', `${rt.uptime ? fmtUp(rt.uptime) : '-'} / ${rt.restarts}`],
    ['Log warnings / errors', `<span class="${rt.counters.warnings ? 'warn' : ''}">${rt.counters.warnings}</span> / <span class="${rt.counters.errors ? 'bad' : ''}">${rt.counters.errors}</span>`],
    ['Bitrate avg / peak (window)', h.length ? `${fmtBitrate(h.reduce((t, x) => t + x.bitrate, 0) / h.length)} / ${fmtBitrate(Math.max(...h.map((x) => x.bitrate)))}` : '-'],
    ['Last error', rt.lastError ? `<span class="bad">${esc(rt.lastError)}</span>` : '-'],
  ];
  $('#dTable').innerHTML = rows.map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join('');
  $('#dCmd').textContent = rt.command || '(not started yet)';
}

$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  if (b.dataset.tab === 'log') { paintLog(); $('#dLog').scrollTop = 1e9; }
}));
$('#dClose').addEventListener('click', () => $('#detailDlg').close());
$('#detailDlg').addEventListener('close', () => { detailId = null; });

/* ---------- edit form ---------- */
const form = $('#form');

function setPath(obj, path, val) {
  const keys = path.split('.');
  keys.slice(0, -1).reduce((o, k) => (o[k] ??= {}), obj)[keys.at(-1)] = val;
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

function addOutputRow(o = { url: '', enabled: true }) {
  const row = document.createElement('div');
  row.className = 'out-row';
  row.innerHTML = `<input type="checkbox" ${o.enabled ? 'checked' : ''} title="Enabled">
    <input type="text" placeholder="udp://239.1.1.1:5000 · rtp://host:5004 · rtmp://… · srt://… · out.mp4" value="${esc(o.url)}">
    <button type="button" class="danger">x</button>`;
  $('button', row).onclick = () => row.remove();
  $('#outputs').appendChild(row);
}
$('#addOut').onclick = () => addOutputRow();

function updateVisibility() {
  const p = proto(form.elements['input.url'].value);
  $$('[data-for=rtsp]').forEach((e) => (e.hidden = !/^rtsps?$/.test(p)));
  $$('[data-for=rtp]').forEach((e) => (e.hidden = p !== 'rtp'));
  $$('[data-for=file]').forEach((e) => (e.hidden = p !== 'file'));
  $$('[data-for=vtx]').forEach((e) => (e.hidden = form.elements['video.mode'].value !== 'transcode'));
  $$('[data-for=atx]').forEach((e) => (e.hidden = form.elements['audio.mode'].value !== 'transcode'));
}
form.addEventListener('input', updateVisibility);
form.addEventListener('change', updateVisibility);

const DEFAULTS = {
  name: '', input: { url: '', rtspTransport: 'tcp', sdp: '', loop: false, extra: '' },
  video: { mode: 'copy', codec: 'libx264', preset: 'veryfast', bitrate: '', width: '', height: '', fps: '', gop: '' },
  audio: { mode: 'copy', codec: 'aac', bitrate: '', sampleRate: '' },
  outputs: [{ url: '', enabled: true }], extraOutputArgs: '', preview: true, autoRestart: true, autoStart: false,
};

function openEdit(s) {
  editId = s?.id || null;
  const d = s || DEFAULTS;
  $('#editTitle').textContent = s ? `Edit "${s.name}"` : 'New stream';
  $('#formErr').hidden = true;
  $('#probeOut').hidden = true;
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = getPath(d, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v || v === 0 ? v : '';
  }
  $('#outputs').innerHTML = '';
  (d.outputs.length ? d.outputs : DEFAULTS.outputs).forEach(addOutputRow);
  updateVisibility();
  $('#editDlg').showModal();
}

function readForm() {
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    setPath(body, el.name, el.type === 'checkbox' ? el.checked : el.value);
  }
  body.outputs = $$('.out-row').map((r) => ({ enabled: $('input[type=checkbox]', r).checked, url: $('input[type=text]', r).value }));
  return body;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = readForm();
    if (editId) await api('PUT', `/api/streams/${editId}`, body);
    else await api('POST', '/api/streams', body);
    $('#editDlg').close();
    await refresh();
  } catch (err) {
    $('#formErr').textContent = err.message;
    $('#formErr').hidden = false;
  }
});
$('#cancelBtn').onclick = () => $('#editDlg').close();
$('#newBtn').onclick = () => openEdit(null);

$('#probeBtn').onclick = async () => {
  const out = $('#probeOut');
  out.hidden = false;
  out.textContent = 'Probing…';
  try {
    const b = readForm();
    const r = await api('POST', '/api/probe', { url: b.input.url, sdp: b.input.sdp, rtspTransport: b.input.rtspTransport });
    const lines = [`Format: ${r.format?.format_long_name || '?'}  ·  ${r.format?.bit_rate ? Math.round(r.format.bit_rate / 1000) + ' kb/s' : 'bitrate n/a'}`];
    for (const st of r.streams || []) {
      lines.push(st.codec_type === 'video'
        ? `#${st.index} video  ${st.codec_name} ${st.profile || ''}  ${st.width}x${st.height}  ${st.avg_frame_rate}  ${st.pix_fmt || ''}`
        : st.codec_type === 'audio'
          ? `#${st.index} audio  ${st.codec_name}  ${st.sample_rate} Hz  ${st.channel_layout || st.channels + ' ch'}`
          : `#${st.index} ${st.codec_type} ${st.codec_name}`);
    }
    out.textContent = lines.join('\n');
  } catch (err) { out.textContent = 'Probe failed: ' + err.message; }
};

/* ---------- live data ---------- */
async function refresh() {
  const list = await api('GET', '/api/streams');
  streams.clear();
  list.forEach((s) => streams.set(s.id, s));
  render();
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  const conn = $('#conn');
  ws.onopen = () => { conn.textContent = 'live'; conn.className = 'sys ok'; };
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
  ws.onclose = () => { conn.textContent = 'offline - reconnecting'; conn.className = 'sys bad'; setTimeout(connect, 2000); };
}

api('GET', '/api/system').then((s) => {
  const el = $('#sys');
  if (s.ok) { el.textContent = s.version.split(' ').slice(0, 3).join(' '); el.className = 'sys ok'; }
  else { el.textContent = 'ffmpeg missing'; el.className = 'sys bad'; const b = $('#banner'); b.textContent = s.error; b.hidden = false; }
});
refresh().then(connect);
