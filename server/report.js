// Builds the per-stream analytics report: plain-language summary, SVG graphics and detailed ("nerd") data.
// The same standalone HTML page is shown inside the dashboard and offered as a download.
const os = require('os');
const { maskSecrets } = require('./ffmpeg');

const PRESET_NAMES = { inherit: 'Same as stream', original: 'Pass through', audio_fix: 'Keep video, fix audio', hd720: '720p', hd1080: '1080p' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- formatting ---------- */
const fmtRate = (k) => (k == null ? '-' : k >= 1000 ? `${(k / 1000).toFixed(2)} Mb/s` : `${Math.round(k)} kb/s`);
const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
const clock = (t) => new Date(t).toLocaleTimeString('en-GB');
const stamp = (t) => new Date(t).toLocaleString('en-GB');
const n1 = (v) => (v == null ? '-' : (+v).toFixed(1));
const n2 = (v) => (v == null ? '-' : (+v).toFixed(2));

/* ---------- statistics ---------- */
function describe(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const avg = v.reduce((t, x) => t + x, 0) / v.length;
  const std = Math.sqrt(v.reduce((t, x) => t + (x - avg) ** 2, 0) / v.length);
  return { n: v.length, min: sorted[0], avg, p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1], std, cv: avg ? std / avg : 0 };
}

function downsample(series, max = 300) {
  if (series.length <= max) return series;
  const size = series.length / max;
  const out = [];
  for (let i = 0; i < max; i++) {
    const chunk = series.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    if (!chunk.length) continue;
    const avg = (k) => chunk.reduce((t, x) => t + x[k], 0) / chunk.length;
    out.push({ t: chunk[Math.floor(chunk.length / 2)].t, i: avg('i'), o: avg('o'), f: avg('f'), s: avg('s') });
  }
  return out;
}

/* ---------- data ---------- */
function build(runner, sys) {
  const rep = runner.rep, cfg = runner.cfg, st = runner.stats, now = Date.now();
  const active = !!runner.proc;
  const lastEvent = rep.events[rep.events.length - 1];
  const end = !active && runner.status === 'stopped' && lastEvent ? lastEvent.t : now;
  const durationMs = Math.max(0, end - rep.startedAt);
  const series = rep.series;

  const metrics = {
    inBitrate: describe(series.map((x) => x.i)),
    outBitrate: describe(series.map((x) => x.o)),
    fps: describe(series.map((x) => x.f)),
    speed: describe(series.map((x) => x.s)),
  };
  const cur = runner.currentTotals();
  const totals = {
    bytesIn: runner.inBytes,
    bytesOut: rep.base.bytesOut + cur.bytesOut,
    frames: rep.base.frames + cur.frames,
    drops: rep.base.drops + cur.drops,
    dups: rep.base.dups + cur.dups,
    mediaSeconds: rep.base.media + cur.media,
  };
  const reconnects = rep.events.filter((e) => e.state === 'down' && /lost/i.test(e.text)).length;
  const availability = durationMs > 0 ? Math.min(100, (rep.runningMs / durationMs) * 100) : 0;
  const slowShare = series.length ? series.filter((x) => x.s > 0 && x.s < 0.95).length / series.length : 0;
  const dropPct = totals.frames ? (totals.drops / totals.frames) * 100 : 0;

  // Health score: every deduction is listed in the report so the number is never a black box.
  const parts = [];
  const deduct = (label, points, why) => { if (points > 0.4) parts.push({ label, points: Math.round(points * 10) / 10, why }); };
  deduct('Availability', Math.max(0, 100 - availability) * 0.5, `Receiving data ${availability.toFixed(1)}% of the time`);
  deduct('Reconnects', Math.min(25, reconnects * 5), `${reconnects} reconnect${reconnects === 1 ? '' : 's'} (5 points each, max 25)`);
  deduct('Stalls', Math.min(15, rep.stalls * 5), `${rep.stalls} period${rep.stalls === 1 ? '' : 's'} with no data (5 points each, max 15)`);
  deduct('Dropped frames', Math.min(15, dropPct * 5), `${dropPct.toFixed(2)}% of frames dropped (5 points per 1%, max 15)`);
  deduct('Processing speed', Math.min(20, slowShare * 40), `Slower than real time ${(slowShare * 100).toFixed(1)}% of the time (max 20)`);
  deduct('Frame-rate stability', metrics.fps ? (metrics.fps.cv > 0.15 ? 10 : metrics.fps.cv > 0.08 ? 5 : 0) : 0, `Frame rate varies by ${((metrics.fps?.cv || 0) * 100).toFixed(1)}% (5 points above 8%, 10 above 15%)`);
  deduct('Errors in log', rep.errors > 20 ? 10 : rep.errors > 0 ? 5 : 0, `${rep.errors} error line${rep.errors === 1 ? '' : 's'} in the ffmpeg log`);
  const score = series.length ? Math.max(0, Math.round(100 - parts.reduce((t, p) => t + p.points, 0))) : null;
  const label = score == null ? 'No data yet' : score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 55 ? 'Fair' : 'Poor';

  const timeline = [];
  rep.events.forEach((e, i) => {
    const to = i + 1 < rep.events.length ? rep.events[i + 1].t : end;
    if (to > e.t) timeline.push({ from: e.t, to, state: e.state });
  });

  const messages = [...rep.msgs.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  const info = runner.info;

  const report = {
    generatedAt: now,
    stream: { id: cfg.id, name: cfg.name, input: maskSecrets(cfg.input.url), outputs: cfg.outputs.filter((o) => o.enabled).map((o) => maskSecrets(o.url)), recording: cfg.record.enabled },
    config: { video: cfg.video, audio: cfg.audio, preview: cfg.preview, autoRestart: cfg.autoRestart, record: cfg.record, rtspTransport: cfg.input.rtspTransport, loop: cfg.input.loop, playlist: cfg.input.files || [] },
    status: runner.status,
    session: { startedAt: rep.startedAt, endedAt: end, durationMs, runningMs: rep.runningMs, availability, reconnects, stalls: rep.stalls, warnings: rep.warnings, errors: rep.errors },
    health: { score, label, parts },
    destinations: runner.destinationReport(durationMs),
    metrics, totals, slowShare, dropPct, timeline, messages,
    events: rep.events,
    format: { format: info.format, bitrate: info.bitrate, video: info.video, audio: info.audio, outputs: info.outputs.filter((o) => o.kind !== 'tap').map((o) => ({ ...o, url: maskSecrets(o.url) })) },
    command: maskSecrets(runner.command || ''),
    environment: { ffmpeg: sys?.version || 'unknown', node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, memoryRssMB: Math.round(process.memoryUsage().rss / 1e6), serverUptimeSec: Math.round(process.uptime()) },
    series: downsample(series),
    sampleSpacingSec: 2,
  };
  report.summary = summarize(report);
  return report;
}

/* ---------- plain-language summary ---------- */
function summarize(r) {
  const { metrics: m, session: s, totals: t } = r;
  const points = [], tips = [];
  if (r.health.score == null) {
    return { points: ['This stream has not delivered any data in the current session yet. Start it and come back in a minute.'], tips: [] };
  }
  points.push(`The stream has been observed for ${fmtDur(s.durationMs)} and was receiving data ${s.availability.toFixed(1)}% of that time.`);
  points.push(s.reconnects ? `It lost the connection and reconnected ${s.reconnects} time${s.reconnects === 1 ? '' : 's'}.` : 'It stayed connected without any reconnects.');
  if (s.stalls) points.push(`There ${s.stalls === 1 ? 'was 1 period' : `were ${s.stalls} periods`} where the source stopped sending data for several seconds.`);
  if (m.inBitrate && m.outBitrate) {
    const diff = m.inBitrate.avg ? ((m.outBitrate.avg - m.inBitrate.avg) / m.inBitrate.avg) * 100 : 0;
    const why = r.config.video.mode === 'copy'
      ? 'the output container, such as MPEG-TS, adds its own overhead, which is normal'
      : 'the video is being re-encoded with different settings';
    points.push(`On average ${fmtRate(m.inBitrate.avg)} came in and ${fmtRate(m.outBitrate.avg)} went out (${Math.abs(diff) < 3 ? 'about the same' : `${Math.abs(diff).toFixed(0)}% ${diff > 0 ? 'higher' : 'lower'} on the way out; ${why}`}). The busiest moment reached ${fmtRate(m.inBitrate.max)} coming in.`);
  }
  if (m.fps) {
    points.push(m.fps.cv < 0.05 ? `The frame rate was steady at about ${m.fps.avg.toFixed(0)} frames per second.`
      : `The frame rate averaged ${m.fps.avg.toFixed(1)} fps but varied between ${m.fps.min.toFixed(1)} and ${m.fps.max.toFixed(1)}.`);
  }
  if (m.speed) {
    points.push(r.slowShare < 0.02 ? 'The server kept up with real time the whole time.'
      : `The server fell behind real time ${(r.slowShare * 100).toFixed(0)}% of the time, which can cause stutter or growing delay.`);
  }
  points.push(t.drops ? `${t.drops} frame${t.drops === 1 ? ' was' : 's were'} dropped (${r.dropPct.toFixed(2)}%).` : 'No frames were dropped.');
  points.push(`${fmtBytes(t.bytesOut)} was sent out in total (${fmtBytes(t.bytesIn)} received).`);
  for (const d of r.destinations.filter((x) => x.kind === 'dest')) {
    if (d.restarts) points.push(`${d.label} (${d.url}) restarted ${d.restarts} time${d.restarts === 1 ? '' : 's'}.`);
    else if (d.status === 'error') points.push(`${d.label} (${d.url}) is stopped because of an error.`);
  }

  if (r.slowShare >= 0.05) tips.push('The server is struggling to convert in real time. Use "Keep video, fix audio" (no video re-encoding), a lower resolution, or a faster encoder preset.');
  if (s.reconnects >= 2 || s.stalls >= 2) tips.push('The source is unstable. For RTSP cameras make sure the transport is TCP (under More source options) and check the network or Wi-Fi to the camera.');
  if (r.dropPct >= 0.5) tips.push('Frames are being dropped. Check the CPU load on the server and the network path between source and server.');
  if (m.outBitrate && m.outBitrate.cv > 0.6) tips.push('The output bitrate is very uneven. If the destination is bandwidth limited, use a convert preset with a fixed bitrate.');
  if (s.errors > 0 && r.messages[0]) tips.push(`The most frequent problem in the log is: "${r.messages[0].sample.replace(/^[\d:]+ /, '').slice(0, 140)}".`);
  if (!tips.length) tips.push('Nothing needs attention right now.');
  return { points, tips };
}

/* ---------- SVG graphics ---------- */
function lineChart({ title, series, fmt, ref, minMax = 0 }) {
  const W = 720, H = 190, L = 56, R = 12, T = 12, B = 26;
  const pts = series.flatMap((s) => s.data);
  if (pts.length < 2) return `<figure><figcaption>${esc(title)}</figcaption><p class="dim">Not enough data yet.</p></figure>`;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const allT = series[0].data;
  const ts = allT.length ? [allT[0].t, allT[allT.length - 1].t] : [t0, t1];
  const maxV = Math.max(minMax, ref || 0, ...series.flatMap((s) => s.data.map((d) => d.v))) * 1.12 || 1;
  const x = (t) => L + ((t - ts[0]) / Math.max(1, ts[1] - ts[0])) * (W - L - R);
  const y = (v) => T + (1 - v / maxV) * (H - T - B);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (maxV * i) / 4, yy = y(v);
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="axis" x="${L - 6}" y="${yy + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  g += `<text class="axis" x="${L}" y="${H - 6}">${clock(ts[0])}</text><text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${clock(ts[1])}</text>`;
  if (ref) g += `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/>`;
  const lines = series.map((s, k) => {
    const d = s.data.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    return `<path class="line c${k + 1}" d="${d}"/>`;
  }).join('');
  const legend = series.map((s, k) => `<span class="key c${k + 1}">${esc(s.name)}</span>`).join('');
  return `<figure><figcaption>${esc(title)} <span class="legend">${legend}</span></figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}${lines}</svg></figure>`;
}

function histogram(values, fmt) {
  const v = values.filter((x) => x > 0);
  if (v.length < 5) return '<figure><figcaption>Output bitrate distribution</figcaption><p class="dim">Not enough data yet.</p></figure>';
  const W = 720, H = 150, L = 56, R = 12, T = 8, B = 26, bins = 24;
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const counts = Array(bins).fill(0);
  v.forEach((x) => { counts[Math.min(bins - 1, Math.floor(((x - min) / span) * bins))]++; });
  const top = Math.max(...counts), bw = (W - L - R) / bins;
  const bars = counts.map((c, i) => {
    const h = (c / top) * (H - T - B);
    return `<rect class="bar" x="${L + i * bw + 1}" y="${H - B - h}" width="${bw - 2}" height="${h}"><title>${esc(fmt(min + (i / bins) * span))}: ${c} samples</title></rect>`;
  }).join('');
  return `<figure><figcaption>Output bitrate distribution <span class="legend dim">how often each bitrate occurred</span></figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Output bitrate distribution">${bars}
    <text class="axis" x="${L}" y="${H - 6}">${esc(fmt(min))}</text><text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(fmt(max))}</text></svg></figure>`;
}

function timelineBar(r) {
  const W = 720, H = 34, L = 0;
  const { timeline } = r;
  if (!timeline.length) return '';
  const a = timeline[0].from, b = timeline[timeline.length - 1].to, span = Math.max(1, b - a);
  const rects = timeline.map((s) => `<rect class="st-${s.state}" x="${L + ((s.from - a) / span) * W}" y="0" width="${Math.max(1.5, ((s.to - s.from) / span) * W)}" height="${H}"><title>${s.state}: ${clock(s.from)} - ${clock(s.to)}</title></rect>`).join('');
  return `<figure><figcaption>Connection timeline <span class="legend"><span class="key st-running">receiving</span><span class="key st-connecting">connecting</span><span class="key st-down">no data / reconnecting</span><span class="key st-stopped">stopped</span></span></figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Connection timeline">${rects}</svg></figure>`;
}

function gauge(score, label) {
  const C = 2 * Math.PI * 52, v = score == null ? 0 : score;
  const cls = score == null ? 'none' : score >= 90 ? 'great' : score >= 75 ? 'good' : score >= 55 ? 'fair' : 'poor';
  return `<div class="gauge ${cls}"><svg viewBox="0 0 120 120" role="img" aria-label="Health score ${score ?? 'n/a'}"><circle class="ring-bg" cx="60" cy="60" r="52"/><circle class="ring" cx="60" cy="60" r="52" stroke-dasharray="${(v / 100) * C} ${C}" transform="rotate(-90 60 60)"/><text x="60" y="64" text-anchor="middle" class="score">${score ?? '-'}</text><text x="60" y="84" text-anchor="middle" class="outof">of 100</text></svg><b>${esc(label)}</b></div>`;
}

/* ---------- HTML ---------- */
const CSS = `
:root{--bg:#f4f5f8;--card:#fff;--soft:#eef0f4;--line:#dfe3ea;--text:#19202d;--mute:#667085;--c1:#2f6bff;--c2:#0f9d58;--warn:#b86e00;--bad:#d92d20}
@media (prefers-color-scheme:dark){:root{--bg:#0e1117;--card:#161b22;--soft:#1f2631;--line:#2a323e;--text:#e8ecf1;--mute:#8b97a7;--c1:#5b8cff;--c2:#3ecf8e;--warn:#f5a524;--bad:#ff6b7a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,"Segoe UI",sans-serif}
.page{max-width:980px;margin:0 auto;padding:24px 20px 48px}h1{margin:0;font-size:24px}h2{font-size:18px;margin:34px 0 10px}h3{font-size:14px;margin:22px 0 8px;color:var(--mute);text-transform:uppercase;letter-spacing:.05em}
.sub{color:var(--mute);font-size:13px;overflow-wrap:anywhere}.dim{color:var(--mute)}
.hero{display:flex;gap:24px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 22px;margin-top:18px}
.gauge{text-align:center;min-width:130px}.gauge svg{width:120px;height:120px}.gauge b{display:block;font-size:16px}
.ring-bg{fill:none;stroke:var(--soft);stroke-width:10}.ring{fill:none;stroke-width:10;stroke-linecap:round}
.great .ring{stroke:var(--c2)}.good .ring{stroke:var(--c1)}.fair .ring{stroke:var(--warn)}.poor .ring{stroke:var(--bad)}.none .ring{stroke:var(--line)}
.score{font-size:30px;font-weight:700;fill:var(--text)}.outof{font-size:10px;fill:var(--mute)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;flex:1}
.tile{background:var(--soft);border-radius:12px;padding:10px 12px}.tile span{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}.tile b{display:block;font-size:19px;font-variant-numeric:tabular-nums}
ul.plain{padding-left:20px;margin:0}ul.plain li{margin:6px 0}.tips li::marker{color:var(--warn)}
figure{margin:14px 0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}figcaption{font-weight:600;font-size:14px;margin-bottom:4px}
.legend{font-weight:400;font-size:12px;margin-left:10px}.key{margin-right:12px}.key::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;background:currentColor;vertical-align:-1px}
.c1{color:var(--c1)}.c2{color:var(--c2)}svg{width:100%;height:auto;display:block}
.line{fill:none;stroke-width:1.8}.line.c1{stroke:var(--c1)}.line.c2{stroke:var(--c2)}.grid{stroke:var(--line);stroke-width:1}.ref{stroke:var(--warn);stroke-dasharray:4 4}
.axis{font-size:11px;fill:var(--mute)}.bar{fill:var(--c1);opacity:.85}
.st-running{fill:var(--c2);color:var(--c2)}.st-connecting{fill:var(--c1);color:var(--c1)}.st-down{fill:var(--bad);color:var(--bad)}.st-stopped{fill:var(--line);color:var(--mute)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere;vertical-align:top}thead th{background:var(--soft);font-weight:600}tbody th{color:var(--mute);font-weight:500;width:190px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace}
details{margin-top:8px}summary{cursor:pointer;font-weight:600;color:var(--mute)}pre{background:var(--soft);padding:10px 12px;border-radius:10px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all}
.warn{color:var(--warn)}.bad{color:var(--bad)}a{color:var(--c1)}.dl{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:14px}
@media print{body{background:#fff}.dl{display:none}}
@media (max-width:640px){.hero{flex-direction:column;align-items:stretch}}`;

function table(head, rows, cls = []) {
  return `<table><thead><tr>${head.map((h, i) => `<th class="${cls[i] || ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c, i) => `<td class="${cls[i] || ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function render(r, { download = false } = {}) {
  const m = r.metrics, s = r.session, t = r.totals;
  const sx = (k) => r.series.map((p) => ({ t: p.t, v: p[k] }));
  const stat = (name, d, f) => (d ? [name, d.n, f(d.min), f(d.avg), f(d.p50), f(d.p95), f(d.p99), f(d.max), f(d.std), `${(d.cv * 100).toFixed(1)}%`] : [name, 0, '-', '-', '-', '-', '-', '-', '-', '-']);
  const fv = r.format.video, fa = r.format.audio;
  let destNo = 1;
  const vline = (v) => (v ? `${esc(String(v.codec).toUpperCase())} ${esc(v.profile)} ${esc(v.resolution)} ${v.fps ? v.fps + ' fps' : ''} ${esc(v.pixFmt)}` : '-');
  const aline = (a) => (a ? `${esc(String(a.codec).toUpperCase())} ${a.sampleRate ? a.sampleRate / 1000 + ' kHz' : ''} ${esc(a.channels)} ${a.bitrate ? a.bitrate + ' kb/s' : ''}` : '-');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report - ${esc(r.stream.name)}</title><style>${CSS}</style></head><body><div class="page">
<h1>${esc(r.stream.name)}</h1>
<div class="sub">${esc(r.stream.input)} &rarr; ${esc(r.stream.outputs.join(', ') || (r.stream.recording ? 'recording' : 'preview only'))}<br>
Session ${esc(stamp(s.startedAt))} to ${esc(stamp(s.endedAt))} (${esc(fmtDur(s.durationMs))}). Report created ${esc(stamp(r.generatedAt))}.</div>

<div class="hero">${gauge(r.health.score, r.health.label)}
<div class="tiles">
<div class="tile"><span>Availability</span><b>${s.availability.toFixed(1)}%</b></div>
<div class="tile"><span>Reconnects</span><b>${s.reconnects}</b></div>
<div class="tile"><span>Avg input</span><b>${m.inBitrate ? fmtRate(m.inBitrate.avg) : '-'}</b></div>
<div class="tile"><span>Avg output</span><b>${m.outBitrate ? fmtRate(m.outBitrate.avg) : '-'}</b></div>
<div class="tile"><span>Avg frame rate</span><b>${m.fps ? m.fps.avg.toFixed(1) + ' fps' : '-'}</b></div>
<div class="tile"><span>Dropped frames</span><b>${t.drops}</b></div>
</div></div>

<h2>In plain words</h2>
<ul class="plain">${r.summary.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<h3>Suggestions</h3>
<ul class="plain tips">${r.summary.tips.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>

<h2>Graphs</h2>
${timelineBar(r)}
${lineChart({ title: 'Bitrate', series: [{ name: 'Input', data: sx('i') }, { name: 'Output', data: sx('o') }], fmt: fmtRate })}
${lineChart({ title: 'Frame rate', series: [{ name: 'Frames per second', data: sx('f') }], fmt: (v) => `${v.toFixed(0)} fps`, minMax: 30 })}
${lineChart({ title: 'Processing speed', series: [{ name: 'Speed (1.0 = real time)', data: sx('s') }], fmt: (v) => `${v.toFixed(2)}x`, ref: 1, minMax: 1.5 })}
${histogram(r.series.map((p) => p.o), fmtRate)}

<h2>Technical details</h2>
<details open><summary>Destinations (${r.destinations.length})</summary>
${r.destinations.length ? table(['Output', 'Settings', 'State', 'Avg bitrate', 'Peak', 'Avg fps', 'Delivered', 'Restarts', 'Errors'], r.destinations.map((d) => [
    esc(d.kind === 'dest' ? `${d.label}<br><span class="sub">${d.url}</span>` : d.label),
    esc(PRESET_NAMES[d.preset] || 'Same as stream'),
    esc(d.status),
    d.avgBitrate ? fmtRate(d.avgBitrate) : '-',
    d.maxBitrate ? fmtRate(d.maxBitrate) : '-',
    d.avgFps ? n1(d.avgFps) : '-',
    s.durationMs ? `${Math.min(100, (d.runningMs / s.durationMs) * 100).toFixed(1)}%` : '-',
    String(d.restarts),
    String(d.errors),
  ]), ['', '', '', 'num', 'num', 'num', 'num', 'num', 'num']) : '<p class="dim">No destinations.</p>'}</details>

<details open><summary>Statistics per metric (${m.outBitrate?.n || 0} samples, one every ${r.sampleSpacingSec} s)</summary>
${table(['Metric', 'Samples', 'Min', 'Average', 'Median', '95th pct', '99th pct', 'Max', 'Std dev', 'Variation'], [
    stat('Input bitrate', m.inBitrate, fmtRate), stat('Output bitrate', m.outBitrate, fmtRate),
    stat('Frame rate', m.fps, (v) => `${n1(v)} fps`), stat('Speed', m.speed, (v) => `${n2(v)}x`),
  ], ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num', 'num', 'num'])}
<p class="sub">Variation is the standard deviation divided by the average. Low means steady, high means bursty.</p></details>

<details open><summary>Totals for this session</summary>
${table(['Item', 'Value'], [
    ['Data received (measured at input)', fmtBytes(t.bytesIn)],
    ['Data sent (all destinations together)', fmtBytes(t.bytesOut)],
    ['Output / input size ratio', t.bytesIn ? (t.bytesOut / t.bytesIn).toFixed(2) : '-'],
    ['Frames processed', String(t.frames)],
    ['Dropped / duplicated frames', `${t.drops} / ${t.dups} (${r.dropPct.toFixed(3)}% dropped)`],
    ['Media time sent', fmtDur(t.mediaSeconds * 1000)],
    ['Time receiving data', `${fmtDur(s.runningMs)} of ${fmtDur(s.durationMs)}`],
    ['Stalls (no data for 6 s+)', String(s.stalls)],
    ['Log warnings / errors', `${s.warnings} / ${s.errors}`],
  ])}</details>

<details open><summary>Stream formats</summary>
${table(['', 'Video', 'Audio', 'Container'], [
    ['Input (declared by source)', vline(fv), aline(fa), `${esc(r.format.format)} ${r.format.bitrate ? fmtRate(r.format.bitrate) : ''}`],
    ...r.format.outputs.map((o) => {
      const title = o.kind === 'record' ? 'Recording' : o.kind === 'preview' ? 'Live preview (low resolution)' : `Destination ${destNo++}`;
      const where = o.kind === 'preview' ? 'internal' : o.url.split('/').pop();
      return [`${esc(title)}<br><span class="sub">${esc(o.kind === 'dest' ? o.url : where)}</span>`, vline(o.video), aline(o.audio), esc(o.format)];
    }),
  ])}</details>

<details><summary>Health score breakdown</summary>
${r.health.parts.length ? table(['Factor', 'Points lost', 'Why'], r.health.parts.map((p) => [esc(p.label), `-${p.points}`, esc(p.why)]), ['', 'num', '']) : '<p class="dim">No points were deducted.</p>'}
<p class="sub">The score starts at 100 and loses points for each factor above. 90+ is Excellent, 75+ Good, 55+ Fair, below that Poor.</p></details>

<details><summary>Most frequent problem messages in the ffmpeg log</summary>
${r.messages.length ? table(['Count', 'Level', 'Example'], r.messages.map((x) => [String(x.count), x.level === 'error' ? '<span class="bad">error</span>' : '<span class="warn">warning</span>', esc(x.sample.slice(0, 220))]), ['num', '', '']) : '<p class="dim">No warnings or errors were logged.</p>'}</details>

<details><summary>Event history (${r.events.length})</summary>
${r.events.length ? table(['Time', 'Event'], r.events.slice().reverse().map((e) => [esc(stamp(e.t)), esc(e.text)])) : '<p class="dim">No events yet.</p>'}</details>

<details><summary>Configuration and environment</summary>
${table(['Setting', 'Value'], [
    ['Video', esc(r.config.video.mode === 'copy' ? 'copy (no re-encode)' : `${r.config.video.codec} ${r.config.video.bitrate || 'auto'} kb/s ${r.config.video.width || 'auto'}x${r.config.video.height || 'auto'}`)],
    ['Audio', esc(r.config.audio.mode === 'transcode' ? `${r.config.audio.codec} ${r.config.audio.bitrate || 'auto'} kb/s` : r.config.audio.mode)],
    ['Reconnect automatically', r.config.autoRestart ? 'yes' : 'no'],
    ['Recording', r.config.record.enabled ? esc(`${r.config.record.format}, split ${r.config.record.splitMinutes || 'never'}`) : 'off'],
    ['ffmpeg', esc(r.environment.ffmpeg)],
    ['Server', esc(`Node ${r.environment.node}, ${r.environment.platform}, ${r.environment.cpus} CPUs, ${r.environment.memoryRssMB} MB used, up ${fmtDur(r.environment.serverUptimeSec * 1000)}`)],
  ])}
<h3>ffmpeg command</h3><pre>${esc(r.command || '(not started)')}</pre></details>

${download ? '' : `<div class="dl"><a href="report.html?download=1">Download this report (HTML)</a><a href="report.json">Raw data (JSON)</a><a href="report.csv">Samples (CSV)</a></div>`}
</div></body></html>`;
}

function csv(runner) {
  const rows = ['time,input_kbps,output_kbps,fps,speed'];
  for (const p of runner.rep.series) rows.push(`${new Date(p.t).toISOString()},${p.i},${p.o},${p.f},${p.s}`);
  return rows.join('\n') + '\n';
}

module.exports = { build, render, csv };
