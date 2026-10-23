// In-process relay: one ingest ffmpeg uploads an MPEG-TS stream, any number of other ffmpeg processes
// (destinations, recording, preview, snapshots) read it back. This is what lets every destination be
// started, stopped and converted on its own without re-opening the camera.
const crypto = require('crypto');

const TS_PACKET = 188;
const MAX_BACKLOG = 16 * 1024 * 1024;   // a reader that falls this far behind is dropped instead of slowing everyone down
const LIVE_WINDOW_MS = 5000;            // no data for this long means the source is not delivering

const VIDEO_PID = 0x100;
const MAX_GOP = 12 * 1024 * 1024;

// Reads the PMT's PID out of a PAT packet.
function pmtPidFrom(p) {
  const afc = (p[3] >> 4) & 3;
  let o = 4;
  if (afc & 2) o += 1 + p[4];
  if (!(afc & 1)) return null;
  o += 1 + p[o];                                  // pointer field
  if (p[o] !== 0x00) return null;                 // not a PAT section
  const end = Math.min(TS_PACKET, o + 3 + (((p[o + 1] & 0x0f) << 8) | p[o + 2]) - 4);
  for (let e = o + 8; e + 4 <= end; e += 4) {
    if (((p[e] << 8) | p[e + 1]) !== 0) return ((p[e + 2] & 0x1f) << 8) | p[e + 3];
  }
  return null;
}

class Relay {
  constructor() {
    this.token = crypto.randomBytes(16).toString('hex');
    this.base = '';                     // http://127.0.0.1:PORT, set once the server is listening
    this.channels = new Map();          // stream id -> channel
  }

  channel(id) {
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { subs: new Set(), bytes: 0, lastChunk: 0, put: null, leftover: Buffer.alloc(0), epoch: 0 };
      this.channels.set(id, ch);
    }
    return ch;
  }

  url(id) { return `${this.base}/relay/${this.token}/${id}`; }

  // Bytes received from the ingest since the stream was started (used for the measured input bitrate).
  bytes(id) { return this.channels.get(id)?.bytes || 0; }

  live(id) {
    const ch = this.channels.get(id);
    return !!ch && !!ch.put && Date.now() - ch.lastChunk < LIVE_WINDOW_MS;
  }

  readers(id) { return this.channels.get(id)?.subs.size || 0; }

  // PUT handler: the ingest ffmpeg streams its output here for as long as it runs.
  ingest(id, req, res) {
    const ch = this.channel(id);
    if (ch.put) ch.put.destroy();       // a new ingest replaces a stale one
    this.closeReaders(ch);              // timestamps restart with every ingest, so readers must reconnect cleanly
    ch.put = req;
    ch.epoch++;
    ch.lastChunk = Date.now();
    ch.leftover = Buffer.alloc(0);
    ch.pat = ch.pmt = ch.gop = null;
    ch.pmtPid = -1;
    ch.gopBytes = 0;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (ch.put === req) { ch.put = null; this.closeReaders(ch); }
      if (!res.headersSent) res.status(201).end();
    };
    req.on('data', (chunk) => this.push(ch, chunk));
    req.on('end', end);
    req.on('close', end);
    req.on('error', end);
  }

  push(ch, chunk) {
    ch.bytes += chunk.length;
    ch.lastChunk = Date.now();
    // Hand readers whole 188-byte packets so a reader that joins mid-stream starts on a packet boundary.
    const buf = ch.leftover.length ? Buffer.concat([ch.leftover, chunk]) : chunk;
    const whole = buf.length - (buf.length % TS_PACKET);
    ch.leftover = whole < buf.length ? Buffer.from(buf.subarray(whole)) : Buffer.alloc(0);
    if (!whole) return;
    const out = buf.subarray(0, whole);
    this.track(ch, out);
    for (const sub of ch.subs) {
      if (sub.writableLength > MAX_BACKLOG) { sub.destroy(); ch.subs.delete(sub); continue; }
      sub.write(out);
    }
  }

  // Remembers the stream tables (PAT, PMT) and everything since the latest video keyframe, so a reader that
  // connects later can start decoding immediately instead of waiting for the next keyframe. The ingest is
  // started with video on PID 0x100, and ffmpeg marks keyframes with the random-access flag.
  track(ch, buf) {
    for (let o = 0; o < buf.length; o += TS_PACKET) {
      const p = buf.subarray(o, o + TS_PACKET);
      if (p[0] !== 0x47) continue;
      const pid = ((p[1] & 0x1f) << 8) | p[2];
      const start = p[1] & 0x40;
      if (pid === 0) {
        if (start) { ch.pat = Buffer.from(p); ch.pmtPid = pmtPidFrom(p) ?? ch.pmtPid; }
        continue;
      }
      if (pid === ch.pmtPid) {
        if (start) ch.pmt = Buffer.from(p);
        continue;
      }
      const adaptation = (p[3] >> 4) & 2;
      if (pid === VIDEO_PID && start && adaptation && p[4] > 0 && (p[5] & 0x40)) {
        ch.gop = [p];
        ch.gopBytes = TS_PACKET;
      } else if (ch.gop) {
        ch.gop.push(p);
        ch.gopBytes += TS_PACKET;
        if (ch.gopBytes > MAX_GOP) ch.gop = null;   // no keyframes for a long time: do not hoard memory
      }
    }
  }

  // GET handler: a reader attaches to the live stream.
  subscribe(id, req, res) {
    const ch = this.channel(id);
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', Connection: 'close' });
    if (ch.put && ch.pat && ch.pmt && ch.gop) res.write(Buffer.concat([ch.pat, ch.pmt, ...ch.gop]));
    ch.subs.add(res);
    res.on('close', () => ch.subs.delete(res));
    req.on('error', () => ch.subs.delete(res));
  }

  closeReaders(ch) {
    for (const sub of ch.subs) sub.end();
    ch.subs.clear();
  }

  // Forget a stream's counters when it is started again or deleted.
  reset(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    if (ch.put) ch.put.destroy();
    this.closeReaders(ch);
    this.channels.delete(id);
  }
}

module.exports = { Relay };
