# Restream

A web application that uses ffmpeg to receive, view, convert, record, analyse and restream multiple live streams at once.

## Features

- Multiple streams running in parallel, each in its own ffmpeg process
- Sources: RTSP (with username and password), RTP (via SDP), UDP MPEG-TS, SRT, RTMP, HTTP/HLS, or videos stored on the server
- Destinations: UDP, RTP, SRT, RTMP, RTSP push or a file, several per stream
- Conversion presets (keep video and fix audio, pass through, 720p, 1080p) or fully custom codecs, bitrate, resolution and frame rate
- Server video library: upload videos, stream one or a playlist of several, and loop forever for constant streaming
- Recording: save a copy of any stream to disk (MKV, MP4 or TS), optionally split every 10, 30 or 60 minutes, with download and delete in the dashboard
- Live low-resolution preview in the browser
- Measured input and output bitrate, frame rate, speed, dropped frames and codec details for the input and every output
- Analytics report per stream: health score, plain-language summary, graphs and detailed statistics, downloadable as HTML, JSON or CSV
- Plain-language explanations for common errors (wrong login, unreachable source, invalid address, unsupported format)
- Automatic reconnect with backoff, and a watchdog that restarts a stalled stream
- Streams are saved to disk and can start automatically with the server

## Requirements

- Node.js 18 or newer
- ffmpeg and ffprobe available on PATH

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

## Using the dashboard

Click **New stream** and follow three steps.

1. **Source.** Enter an address such as `rtsp://192.168.1.50/stream1`, add a username and password if the device needs a login, and press **Test connection**. Or choose **Video stored on this server**, upload videos, tick the ones to play (in the order you click them) and keep **Loop forever** on for a stream that never stops.
2. **Convert.** Pick a preset. The recommended one passes the video through untouched and converts the audio to AAC so every destination accepts it.
3. **Destination.** Add one or more destinations (UDP and RTP take an address and a port). Optionally turn on the live preview and recording.

Each stream card shows the state, the measured input and output bitrate, the frame rate and how long it has been running. **Details** opens:

- **Overview** with live bitrate, frame rate and speed graphs and a health summary
- **Report** with the full analytics report
- **Format** comparing the input with every destination, the recording and the preview
- **Recordings** to download or delete saved files
- **Log** with the ffmpeg output and the exact command line

### Example: RTSP to UDP

1. Source: `rtsp://camera/stream`, with the camera username and password.
2. Convert: keep the recommended preset.
3. Destination: UDP, address `239.100.100.1`, port `5000`.

Play the result with VLC at `udp://@239.100.100.1:5000`.

### Passwords

Usernames and passwords entered in the form are percent-encoded automatically, so special characters work. The password is stored in plain text in `data/streams.json` and is never sent back to the browser or written to the logs, commands or reports.

## Analytics report

Open **Details > Report**, or go to `/api/streams/<id>/report.html`. The report covers the time since the stream was started and contains:

- A health score from 0 to 100 and a plain-language summary with suggestions
- Graphs for bitrate (input and output), frame rate, processing speed, the bitrate distribution and a connection timeline
- Technical data: minimum, average, median, 95th and 99th percentile, maximum and standard deviation per metric, totals, input and output formats, the most frequent warnings from the log, an event history, the health score breakdown, the configuration and the ffmpeg command

It can be downloaded as a standalone HTML file. The raw data is available as JSON (`report.json`) and CSV (`report.csv`).

Bitrates are measured by the server. The input bitrate is counted from a copy of the incoming packets, and the output bitrate follows the first destination. The output container adds its own overhead (MPEG-TS notably), so output can read a little higher than input even when the video is copied.

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

MPEG-TS cannot carry some audio codecs, for example the PCM audio many cameras send. Use the recommended conversion preset, which converts the audio to AAC.

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
  index.js     HTTP API, WebSocket updates, uploads, static files
  manager.js   Process lifecycle, stats and session data, media library, recordings
  ffmpeg.js    ffmpeg argument builder
  report.js    Analytics report (statistics, summary, SVG graphs, HTML)
public/
  index.html   Dashboard markup
  app.js       Dashboard logic
  style.css    Styles
data/          Created at runtime (saved streams, videos, recordings, playlists)
```

## API

| Method and path                               | Description                          |
|-----------------------------------------------|--------------------------------------|
| `GET /api/streams`                            | List streams with live state         |
| `POST /api/streams`                           | Create a stream                      |
| `PUT /api/streams/:id`                        | Update a stream                      |
| `DELETE /api/streams/:id`                     | Delete a stream                      |
| `POST /api/streams/:id/start`                 | Start                                |
| `POST /api/streams/:id/stop`                  | Stop                                 |
| `GET /api/streams/:id/logs`                   | Recent ffmpeg log lines              |
| `GET /api/streams/:id/report.html`            | Analytics report (`?download=1`)     |
| `GET /api/streams/:id/report.json`            | Report data                          |
| `GET /api/streams/:id/report.csv`             | Measured samples                     |
| `GET /api/streams/:id/recordings`             | List recordings                      |
| `GET /api/streams/:id/recordings/:file`       | Download a recording                 |
| `DELETE /api/streams/:id/recordings/:file`    | Delete a recording                   |
| `GET /api/media`                              | List server videos                   |
| `POST /api/media/:name`                       | Upload a video (raw request body)    |
| `DELETE /api/media/:name`                     | Delete a video that is not in use    |
| `POST /api/probe`                             | Probe a source with ffprobe          |
| `GET /api/system`                             | ffmpeg availability                  |

Live state is also pushed once per second over a WebSocket at `/ws`.

## Notes

- The preview adds a second, low-resolution encode to each stream, which costs some CPU. It can be disabled per stream.
- Each destination is encoded separately, so several transcoded destinations multiply the CPU use.
- Playlists use ffmpeg's concat demuxer, which works best when all videos share the same codec and size. Pick a re-encoding preset to mix different videos.
- Deleting a stream keeps its recordings on disk.
- The server can start processes, read local files and write uploads, and has no authentication unless `AUTH_USER` and `AUTH_PASS` are set. It listens on localhost by default. Do not expose it to a network without a password or a tunnel.
