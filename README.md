# Leela for Pebble

Press one button, speak, get a reply from Leela (the AI assistant behind our chat server) on your wrist.

Target: Pebble Time 2 (`emery`, 200x228 colour, microphone, speaker). C watch app plus PebbleKit JS (PKJS) on the phone. No Android companion app.

![idle screen](docs/idle.png)

## How it works

1. SELECT starts the built-in Pebble `DictationSession`. Speech-to-text is done by the phone side of the Pebble app; the watch app only receives text.
2. The watch sends the text to PKJS via AppMessage (key `ASK`).
3. PKJS calls the server over HTTPS (`POST /api/pebble/ask`), then polls `GET /api/pebble/ask/{id}?offset=N` until `done`, appending the <=240 byte chunks.
4. PKJS re-splits the finished reply at UTF-8 character boundaries into <=200 byte pieces and pushes them to the watch (`STATE`=chunk, `TEXT`=piece), one AppMessage at a time with acks and retries. The watch reassembles them into a 4 KB buffer.
5. The reply appears in a scrollable plain-text layer. UP/DOWN scroll, SELECT asks a follow-up in the same conversation.

Screens: idle ("Press SELECT to talk to Leela"), listening, thinking (animated dots), reply, error (readable message, SELECT retries).

One `conversation_id` is generated per app launch (PKJS restarts with the app) and reused for follow-ups.

## Build and run

Requires the Pebble SDK (tested: pebble-tool 5.0.40, SDK 4.33.1) and Node/npm.

```
npm install          # pulls pebble-clay (settings page)
pebble build         # produces build/leela-pebble.pbw
pebble install --emulator emery
pebble install --phone <phone-ip>     # real watch, via the Pebble phone app's developer connection
npm test             # unit tests for the PKJS client logic (plain node, mocked XHR)
```

Screenshot of the emulator: `pebble screenshot --emulator emery docs/idle.png`.

## Settings (Clay)

Open the app's settings from the Pebble phone app. All values live in the phone's PKJS `localStorage` only; they are never sent to the watch and never in this repo.

| Setting | Default | Notes |
| --- | --- | --- |
| Server URL | `https://chat.osmosis.page` | |
| Device token | empty | Long-lived bearer token starting `lpd_`. Never logged. |
| Speak replies | off | Reads the start of each reply aloud through the watch speaker, see Spoken replies. |
| Voice quality | Fast | Fast = 8 kHz 8-bit (8 KB/s), Good = 8 kHz 16-bit (16 KB/s), Best = 16 kHz 16-bit (32 KB/s). |

### Creating a device token

Admin dashboard, Leela tab, Pebble devices, Create device. Copy the `lpd_...` token and paste it into the app's settings on the phone.

## Server API used

All requests carry `Authorization: Bearer <device_token>`; errors are `{"detail": "..."}`.

- `POST /api/pebble/ask` body `{"text", "conversation_id"}` (text max 1000 chars) returns `{"id", "state"}`.
- `GET /api/pebble/ask/{id}?offset=N` returns `{"state": pending|done|error, "text" (<=240 bytes), "next_offset", "done"}`. 404 = job expired; an `error` state's text is shown to the user.
- Spoken replies (only when enabled): `POST /api/pebble/tts?format=pcm8k8|pcm8k|pcm16k|pcm16k8` body `{"text"}` returns `{"id", "state", "format", "sdk_format", "sample_rate", "bits", "bytes_per_sec", "chars", "segments"}` (501 = no TTS model configured on the server). `GET /api/pebble/tts/{id}?offset=N&limit=M` returns `{"state": pending|done|error, "data" (base64 PCM bytes N..N+M), "next_offset", "total" (null until finished), "done", "error"}`. The server speaks at most the first 400 characters and synthesises sentence-sized segments in parallel, so audio starts after the first segment while the rest is still being generated.
- Not used: `/api/pebble/stt` (built-in dictation is used instead).

Error handling: 401/403 "Token rejected", 429 "Slow down", 404 "reply expired", network failure, 90 s overall timeout.

Rate limit: the server allows 20 req/min per device. PKJS polls once per second (up to ~60/min while a reply is pending), so a long reply can hit 429. On a 429 while polling it waits (`Retry-After` or 5 s) and retries up to 3 times before showing "Slow down". The interval is `POLL_INTERVAL_MS` in `src/pkjs/leela.js`.

## Spoken replies

With "Speak replies" on, after the text reply is on screen PKJS asks the server for speech and streams it to the watch speaker. The text flow is never blocked or changed by this; every failure (no TTS configured, network error, muted speaker, watch without speaker) just means no sound.

- The watch tells PKJS whether it can speak (`CAN_SPEAK` in the ask message: speaker present and not muted).
- PKJS creates a TTS job (`POST /api/pebble/tts?format=...`), downloads the PCM in 4 KB pages (base64 JSON) and forwards it in 480 byte AppMessages (`STATE`=7 `AUDIO`=bytes), between `STATE`=6 (`AUDIO_FORMAT` = SDK `SpeakerPcmFormat` value) and `STATE`=8 (end).
- The watch keeps a 16 KB ring buffer, prebuffers ~0.25-0.5 s, then a 40 ms timer feeds `speaker_stream_write()`. If the speaker runs dry it rebuffers and reopens the stream. At the end it calls `speaker_stream_close()` so buffered audio finishes.
- Flow control: the watch reports cumulative consumed bytes (`AUDIO_POS`); PKJS never lets more than 12 KB be unconsumed, so the ring cannot overflow and the whole clip never sits in RAM.
- BACK or SELECT while speaking stops playback immediately (`AUDIO_STOP` tells the phone to stop downloading); the next BACK exits as usual and the next SELECT asks a question. Starting a new question also stops speech.
- Audio format: the server resamples the TTS output to the SDK's `8kHz_8bit`, `8kHz_16bit` or `16kHz_16bit` raw signed PCM.
- Server prerequisite: pick a TTS model (and voice) under Admin, Leela.

## Known limitations

- Emery only (`targetPlatforms`). Other mic-equipped platforms would probably work but are untested.
- Spoken replies are only attempted on watches with a speaker (emery here; the code is compiled out elsewhere) and are skipped silently when the speaker is muted or Quiet Time is on. Real playback quality, underrun behaviour and Bluetooth throughput have not been verified on hardware yet. Only the first ~400 characters of a reply are spoken.
- The reply is shown only once complete (no live streaming to the watch).
- The watch fonts cannot draw emoji or non-Latin scripts; curly quotes/dashes/bullets are mapped to ASCII and emoji dropped. Markdown is shown as plain text. Replies are truncated at ~4000 characters.
- If the server splits a chunk in the middle of a multi-byte character the JSON already contains a replacement character; the app cannot repair that.
- No history; the reply is lost when the app is closed.
- The emulator has no voice service, so the full dictation flow has to be tested on a real watch.
