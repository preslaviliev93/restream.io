# Restream

A web application that uses ffmpeg to receive, view, convert, analyse and restream multiple live streams at once.

## Features

- Multiple streams running in parallel, each in its own ffmpeg process
- Inputs: RTSP (TCP or UDP transport), RTP (via SDP), UDP MPEG-TS, SRT, RTMP, HTTP/HLS and local files
- Outputs: UDP, RTP, SRT, RTMP, RTSP push or a file, several per stream
- Conversion: copy without re-encoding, or transcode video and audio (codec, bitrate, resolution, fps, GOP, preset)
- Live low-resolution preview in the browser (HLS)
- Analytics: bitrate, fps and speed graphs, input codec details, dropped and duplicated frames, warning and error counters, restart count, live ffmpeg log and the exact command line
- Input probing with ffprobe before saving a stream
- Automatic restart with backoff, and a watchdog that restarts a stalled stream
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

| Variable      | Default     | Description                                  |
|---------------|-------------|----------------------------------------------|
| `PORT`        | `3000`      | HTTP port                                    |
| `HOST`        | `127.0.0.1` | Interface to listen on                       |
| `FFMPEG_PATH` | `ffmpeg`    | Path to the ffmpeg executable                |
| `FFPROBE_PATH`| `ffprobe`   | Path to the ffprobe executable               |

Example:

```powershell
$env:PORT = 8080
npm start
```

## Example: RTSP to UDP

1. Click **New stream**.
2. Input URL: `rtsp://camera/stream`. Use **Probe input** to check it.
3. Add an output: `udp://239.1.1.1:5000`.
4. Leave video and audio on **Copy** for a plain conversion without re-encoding.
5. Save and press **Start**.

Play the result with VLC at `udp://@239.1.1.1:5000`.

To test without a camera, use a local file as the input and enable **Loop file**.

## Output formats

The format is chosen from the output URL:

| Output URL | Format                        |
|------------|-------------------------------|
| `udp://`   | MPEG-TS (`pkt_size=1316`)     |
| `rtp://`   | RTP MPEG-TS                   |
| `srt://`   | MPEG-TS                       |
| `rtmp://`  | FLV                           |
| `rtsp://`  | RTSP push                     |
| file path  | By file extension             |

## RTP input

ffmpeg cannot receive plain RTP without a session description. For `rtp://` inputs paste an SDP into the SDP field, for example:

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
  index.js     HTTP API, WebSocket updates, static files
  manager.js   Process lifecycle, stats parsing, persistence, probing
  ffmpeg.js    ffmpeg argument builder
public/
  index.html   Dashboard markup
  app.js       Dashboard logic
  style.css    Styles
data/          Created at runtime (saved streams, HLS segments, SDP files)
```

## API

| Method and path                    | Description                 |
|------------------------------------|-----------------------------|
| `GET /api/streams`                 | List streams with live state|
| `POST /api/streams`                | Create a stream             |
| `PUT /api/streams/:id`             | Update a stream             |
| `DELETE /api/streams/:id`          | Delete a stream             |
| `POST /api/streams/:id/start`      | Start                       |
| `POST /api/streams/:id/stop`       | Stop                        |
| `GET /api/streams/:id/logs`        | Recent ffmpeg log lines     |
| `POST /api/probe`                  | Probe an input with ffprobe |
| `GET /api/system`                  | ffmpeg availability         |

Live state is also pushed once per second over a WebSocket at `/ws`.

## Notes

- The preview adds a second, low-resolution encode to each stream, which costs some CPU. It can be disabled per stream.
- The server can start processes and read local files and has no authentication. It listens on localhost by default. Do not expose it to a network without putting authentication in front of it.
