# Restream

A web application that uses ffmpeg to receive, view, convert, record, analyse and restream multiple live streams at once, with separate control over every destination.

## Features

- **Sources:** RTSP (with username and password), RTP (via SDP), UDP MPEG-TS, SRT, RTMP, HTTP/HLS, a video stored on the server (one file or a playlist, optionally looping forever), or **listen mode** where a camera or encoder such as OBS pushes to the server over RTMP or SRT
- **Independent destinations:** UDP, RTP, SRT, RTMP, RTSP push or a file. Every destination runs in its own process, so you can switch one on or off, restart it, or give it its own conversion without interrupting the others
- **Conversion:** presets (keep video and fix audio, pass through, 720p, 1080p) or fully custom codecs, bitrate, resolution and frame rate, set for the stream and optionally overridden per destination
- **Picture and sound adjustments:** rotate, flip, crop, deinterlace, text and clock overlay, logo overlay, volume change, loudness evening, silent audio track
- **Recording:** save a copy of any stream to disk (MKV, MP4 or TS), optionally split every 10, 30 or 60 minutes, with download and delete in the dashboard
- **Viewing:** live preview in the browser (Low 360p, HD 720p, or Original quality with no extra CPU), a large **Watch** player, and snapshots (a JPEG of the live picture)
- **Analytics:** measured input and output bitrate, frame rate, speed, dropped frames and codec details per input and per output, graphs, and a full report per stream with a health score, a plain-language summary and detailed statistics, downloadable as HTML, JSON or CSV
- Plain-language explanations for common errors (wrong login, unreachable source, invalid address, unusable encoder, missing font)
- Automatic reconnect with backoff, a watchdog for stalled streams, and encoder checks so a missing GPU never causes a restart loop
- Streams are saved to disk and can start automatically with the server

## Requirements

- Node.js 18 or newer
- ffmpeg and ffprobe available on PATH (ffmpeg 6 or newer recommended)
- For text overlays on Linux, a font such as `fonts-dejavu-core` (or set `FONT_FILE`)

On Windows ffmpeg can be installed with:

```powershell
winget install Gyan.FFmpeg
```

Restart the terminal afterwards so the PATH change takes effect.

## Run

```powershell
npm install
npm start
```

Open http://127.0.0.1:3000.

## Configuration

Environment variables:

| Variable       | Default            | Description                                   |
|----------------|--------------------|-----------------------------------------------|
| `PORT`         | `3000`             | HTTP port                                     |
| `HOST`         | `127.0.0.1`        | Interface to listen on                        |
| `AUTH_USER`    | (none)             | Username for HTTP basic auth                  |
| `AUTH_PASS`    | (none)             | Password for HTTP basic auth                  |
| `FFMPEG_PATH`  | `ffmpeg`           | Path to the ffmpeg executable                 |
| `FFPROBE_PATH` | `ffprobe`          | Path to the ffprobe executable                |
| `MEDIA_DIR`    | `data/media`       | Where uploaded videos are stored              |
| `RECORD_DIR`   | `data/recordings`  | Where recordings are written                  |
| `LOGO_DIR`     | `data/logos`       | Where uploaded logo images are stored         |
| `FONT_FILE`    | (auto)             | Font used for text overlays                   |

Example:

```powershell
$env:PORT = 8080
npm start
```

## Running on a remote server

By default the server only listens on localhost. To reach it from another machine, bind to all interfaces and set a login (open the chosen port in the firewall if needed):

```bash
HOST=0.0.0.0 AUTH_USER=admin AUTH_PASS=change-me npm start
```

Alternatively keep the default and use an SSH tunnel, then open http://127.0.0.1:3000 locally:

```bash
ssh -L 3000:127.0.0.1:3000 user@server
```

Basic auth sends the password unencrypted over plain HTTP, so on untrusted networks prefer the SSH tunnel or put a TLS reverse proxy in front.

To keep it running after the terminal closes, use a systemd service:

```ini
[Unit]
Description=Restream
After=network.target

[Service]
WorkingDirectory=/opt/restream.io
Environment=HOST=0.0.0.0
Environment=AUTH_USER=admin
Environment=AUTH_PASS=change-me
ExecStart=/usr/bin/npm start
Restart=always

[Install]
WantedBy=multi-user.target
```

## Using the dashboard

Click **New stream** and follow three steps.

1. **Source.** Enter an address such as `rtsp://192.168.1.50/stream1`, add a username and password if the device needs a login, and press **Test connection**. Or choose **Video stored on this server**, upload videos, tick the ones to play (in the order you click them) and keep **Loop forever** on. Or choose **Wait for a camera or encoder to send**, pick RTMP or SRT and a port, and enter the shown address in the sender.
2. **Convert.** Pick a preset. The recommended one passes the video through untouched and converts the audio to AAC so every destination accepts it. Open **Picture and sound adjustments** for overlays, rotation, volume and so on.
3. **Destination.** Add one or more destinations (UDP and RTP take an address and a port). Each destination can have its own conversion. Optionally turn on the live preview and recording.

Each stream card shows the state, the measured input and output bitrate, the frame rate and uptime, and one row per destination with its own **Stop** and **Start** switch. **Watch** opens a large player, and **Details** opens:

- **Overview** with live bitrate, frame rate and speed graphs and a health summary
- **Outputs** with a card for the source, every destination, the recording and the preview, each with its own state, numbers, switch and restart button, plus a snapshot button
- **Report** with the full analytics report
- **Format** comparing the input with every destination, the recording and the preview
- **Recordings** to download or delete saved files
- **Log** with the ffmpeg output of every part (filterable) and the exact command lines

### Example: RTSP to UDP

1. Source: `rtsp://camera/stream`, with the camera username and password.
2. Convert: keep the recommended preset.
3. Destination: UDP, address `239.100.100.1`, port `5000`.

Play the result with VLC at `udp://@239.100.100.1:5000`, or press **Watch** in the dashboard.

### Passwords

Usernames and passwords entered in the form are percent-encoded automatically, so special characters work. They are stored in plain text in `data/streams.json` and are never sent back to the browser or written to the logs, commands or reports.

## How it works

Each stream is a small group of ffmpeg processes around an internal relay:

```
source (camera, file, push)  ->  ingest  ->  relay  ->  destination 1 (own conversion)  ->  network
                                                    ->  destination 2 (own conversion)  ->  network
                                                    ->  recording                       ->  disk
                                                    ->  preview                         ->  browser
                                                    ->  snapshot (on demand)
```

The source is opened once, so cameras that allow only one connection work with any number of destinations. If the source drops, it reconnects and everything that reads from the relay reconnects with it. Changing a setting restarts only the processes it affects. Codecs the relay cannot carry (for example PCM audio from many cameras) are converted at the source and noted in the Outputs tab.

## Analytics report

Open **Details > Report**, or go to `/api/streams/<id>/report.html`. The report covers the time since the stream was started and contains:

- A health score from 0 to 100 and a plain-language summary with suggestions
- Graphs for bitrate (input and output), frame rate, processing speed, the bitrate distribution and a connection timeline
- Technical data: statistics per metric (minimum, average, median, 95th and 99th percentile, maximum, standard deviation), per-destination figures, totals, input and output formats, the most frequent warnings from the log, an event history, the health score breakdown, the configuration and the ffmpeg commands

It can be downloaded as a standalone HTML file. The raw data is available as JSON (`report.json`) and CSV (`report.csv`).

## Output formats

The format is chosen from the destination address:

| Destination | Format                        |
|-------------|-------------------------------|
| `udp://`    | MPEG-TS (`pkt_size=1316`)     |
| `rtp://`    | RTP MPEG-TS                   |
| `srt://`    | MPEG-TS                       |
| `rtmp://`   | FLV                           |
| `rtsp://`   | RTSP push                     |
| file path   | By file extension             |

## RTP input

ffmpeg cannot receive plain RTP without a session description. For `rtp://` sources paste an SDP into the SDP field, for example:

```
v=0
o=- 0 0 IN IP4 127.0.0.1
s=stream
c=IN IP4 0.0.0.0
t=0 0
m=video 5004 RTP/AVP 96
a=rtpmap:96 H264/90000
```

## Project layout

```
server/
  index.js     HTTP API, WebSocket updates, uploads, internal relay endpoints
  manager.js   Streams, settings, media and logo libraries, recordings, probing, encoder checks
  worker.js    Supervises one ffmpeg process (restart, statistics, logs)
  relay.js     Internal relay between the source process and the readers
  ffmpeg.js    ffmpeg command builders, filters and presets
  report.js    Analytics report (statistics, summary, SVG graphs, HTML)
public/
  index.html   Dashboard markup
  app.js       Dashboard logic
  style.css    Styles
data/          Created at runtime (settings, videos, logos, recordings, playlists)
```

## API

| Method and path                                   | Description                                      |
|---------------------------------------------------|--------------------------------------------------|
| `GET /api/streams`                                | List streams with live state                     |
| `POST /api/streams`                               | Create a stream                                  |
| `PUT /api/streams/:id`                            | Update a stream (only affected processes restart)|
| `DELETE /api/streams/:id`                         | Delete a stream                                  |
| `POST /api/streams/:id/start`                     | Start                                            |
| `POST /api/streams/:id/stop`                      | Stop                                             |
| `POST /api/streams/:id/workers/:worker/:action`   | `start`, `stop` or `restart` one part (`ingest`, `dest:<id>`, `record`, `preview`) |
| `GET /api/streams/:id/snapshot.jpg`               | A JPEG of the live picture                       |
| `GET /api/streams/:id/logs`                       | Recent ffmpeg log lines of every part            |
| `GET /api/streams/:id/report.html`                | Analytics report (`?download=1`)                 |
| `GET /api/streams/:id/report.json`                | Report data                                      |
| `GET /api/streams/:id/report.csv`                 | Measured samples                                 |
| `GET /api/streams/:id/recordings`                 | List recordings                                  |
| `GET /api/streams/:id/recordings/:file`           | Download a recording                             |
| `DELETE /api/streams/:id/recordings/:file`        | Delete a recording                               |
| `GET /api/media`, `POST /api/media/:name`         | List and upload server videos (raw request body) |
| `DELETE /api/media/:name`                         | Delete a video that is not in use                |
| `GET /api/logos`, `POST /api/logos/:name`         | List and upload logo images                      |
| `DELETE /api/logos/:name`                         | Delete a logo that is not in use                 |
| `POST /api/probe`                                 | Probe a source with ffprobe                      |
| `GET /api/system`                                 | ffmpeg version and encoder availability          |

Live state is also pushed once per second over a WebSocket at `/ws`.

## Troubleshooting

- **Hardware encoders on a virtual machine.** On start the server tests every encoder. NVENC, QSV and AMF need a GPU the machine can use, so on a VM without GPU passthrough only software encoders such as libx264 work. They are greyed out in the Custom codec list, and a stream that fails because of an unusable encoder stops with an explanation instead of restarting forever.
- **Multicast does not play in VLC on Windows ("cannot join multicast group: No route to host").** Windows joins on the adapter with the lowest metric, which is often an unplugged or virtual adapter. Give your real adapter the lowest metric (`netsh interface ipv4 set interface <Idx> metric=1`, see `netsh interface ipv4 show interfaces`), or play the stream with `ffplay "udp://239.100.100.5:5005?localaddr=<your PC address>"`. Also avoid UDP ports used by VPNs (500 and 4500). On Proxmox, the Linux bridge may need `multicast_snooping` switched off for `vmbr0` and the `fwbr*` firewall bridges.
- **Text overlay fails with a font error.** Install a font (`apt install fonts-dejavu-core`) or set `FONT_FILE` to a `.ttf` file.
- **A port for listen mode is already in use.** Each listening stream needs its own port. Ports below 1024 may need extra permissions on Linux.

## Notes

- The Low and HD previews add an encode per stream, which costs some CPU. Original quality only repackages the H.264 video, so it costs almost nothing, but it needs H.264 source video and a keyframe every few seconds at most. The preview can be switched off per stream, and on and off while running.
- Each destination is converted separately, so several re-encoded destinations multiply the CPU use. Passing the video through costs almost nothing.
- Picture adjustments force a re-encode of the video, which also overrides "pass through".
- Playlists use ffmpeg's concat demuxer, which works best when all videos share the same codec and size. Pick a re-encoding preset to mix different videos.
- Deleting a stream keeps its recordings on disk.
- The server can start processes, read local files and write uploads, and has no authentication unless `AUTH_USER` and `AUTH_PASS` are set. It listens on localhost by default. Do not expose it to a network without a password or a tunnel.
