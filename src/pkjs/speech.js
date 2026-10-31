/* Spoken replies (ES5, no platform dependencies so it can be unit-tested in node).
 *
 * Server (see README):
 *   POST {base}/api/pebble/tts?format=pcm8k8  {text} -> {id, state, sdk_format, bytes_per_sec, ...}
 *   GET  {base}/api/pebble/tts/{id}?offset=N&limit=M -> {state, data(base64), next_offset, total, done, error}
 *
 * Watch protocol (phone -> watch, via env.send):
 *   STATE=ST_AUDIO_START AUDIO_FORMAT=<SpeakerPcmFormat>    open the speaker stream
 *   STATE=ST_AUDIO_DATA  AUDIO=<byte array, <= CHUNK_BYTES> raw PCM
 *   STATE=ST_AUDIO_END                                      no more data, drain and close
 *   STATE=ST_AUDIO_STOP                                     abort (phone-side failure)
 * Watch -> phone: AUDIO_POS = cumulative PCM bytes the watch has consumed (flow control),
 * AUDIO_STOP = user stopped playback.
 *
 * Flow control: the phone never has more than WINDOW_BYTES unconsumed bytes on the watch, so the
 * watch ring buffer (RING_BYTES in main.c, keep >= WINDOW_BYTES) can never overflow.
 * Everything here is best effort: any failure just ends the speech; it never touches the text reply.
 */
'use strict';

var ST_AUDIO_START = 6, ST_AUDIO_DATA = 7, ST_AUDIO_END = 8, ST_AUDIO_STOP = 9;
var CHUNK_BYTES = 480;        // one AppMessage; must fit the watch inbox (see app_message_open)
var WINDOW_BYTES = 12288;     // max unconsumed bytes on the watch (ring buffer is 16 KB)
var PAGE_BYTES = 4096;        // bytes requested from the server per GET
var PREFETCH_BYTES = 8192;    // fetch ahead while local buffer is below this
var IDLE_POLL_MS = 400;       // pending job with no new audio yet
var FAIL_BACKOFF_MS = 600;
var MAX_FAILURES = 5;         // consecutive GET failures before giving up
var STALL_TIMEOUT_MS = 20000; // window full and the watch consumed nothing
var TOTAL_TIMEOUT_MS = 150000;
var QUALITY_FORMATS = { fast: 'pcm8k8', good: 'pcm8k', best: 'pcm16k' };

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* base64 -> array of byte values (no atob dependency). Invalid characters are skipped. */
function b64decode(s) {
  var out = [], buf = 0, bits = 0, i, v;
  s = String(s || '');
  for (i = 0; i < s.length; i++) {
    if (s.charAt(i) === '=') { break; }
    v = B64.indexOf(s.charAt(i));
    if (v < 0) { continue; }
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xFF);
      buf &= (1 << bits) - 1;
    }
  }
  return out;
}

function formatForQuality(q) { return QUALITY_FORMATS[q] || QUALITY_FORMATS.fast; }

/* env = { request(method, url, headers, body, cb), setTimeout, clearTimeout, now,
 *         send(msg, onOk, onFail) }
 * hooks = { onEnd(reason) }   reason: 'done' | 'cancelled' | 'unavailable' | 'error'
 */
function createSpeech(env) {
  function speak(opts, hooks) {
    var base = String(opts.serverUrl || '').replace(/\/+$/, '');
    var headers = { 'Authorization': 'Bearer ' + opts.token, 'Content-Type': 'application/json' };
    var fmt = opts.format || QUALITY_FORMATS.fast;
    var started = env.now();
    var ended = false, startSent = false, startAcked = false, waitTimer = false;
    var jobId = null, fetchOffset = 0, serverDone = false, fetching = false, failures = 0;
    var buf = [];            // fetched, not yet sent
    var sent = 0;            // bytes handed to the watch
    var watchPos = 0;        // bytes the watch reports as consumed
    var lastProgress = started;
    var sending = false, endQueued = false;
    var timers = [];

    function later(fn, ms) {
      var h = env.setTimeout(function () {
        var i = timers.indexOf(h);
        if (i >= 0) { timers.splice(i, 1); }
        fn();
      }, ms);
      timers.push(h);
    }
    function finish(reason, tellWatch) {
      if (ended) { return; }
      ended = true;
      timers.forEach(function (h) { env.clearTimeout(h); });
      timers = [];
      if (tellWatch && startSent) {
        try { env.send({ 'STATE': ST_AUDIO_STOP }, function () {}, function () {}); } catch (e) { /* ignore */ }
      }
      if (hooks && hooks.onEnd) { hooks.onEnd(reason); }
    }
    function fail(reason) { finish(reason, true); }

    function checkTimeouts() {
      var now = env.now();
      if (now - started > TOTAL_TIMEOUT_MS) { fail('error'); return true; }
      if (sent - watchPos >= WINDOW_BYTES - CHUNK_BYTES && now - lastProgress > STALL_TIMEOUT_MS) {
        fail('error');
        return true;
      }
      return false;
    }

    function fetchMore() {
      if (ended || fetching || serverDone || jobId === null) { return; }
      if (buf.length >= PREFETCH_BYTES) { return; }
      fetching = true;
      env.request('GET', base + '/api/pebble/tts/' + encodeURIComponent(jobId) +
                  '?offset=' + fetchOffset + '&limit=' + PAGE_BYTES, headers, null,
                  function (status, body) {
        fetching = false;
        if (ended) { return; }
        if (status < 200 || status >= 300 || !body) {
          failures++;
          if (failures >= MAX_FAILURES || status === 404 || status === 401 || status === 403) { fail('error'); return; }
          later(fetchMore, FAIL_BACKOFF_MS * failures);
          return;
        }
        failures = 0;
        if (body.state === 'error') { fail('error'); return; }
        var bytes = typeof body.data === 'string' ? b64decode(body.data) : [];
        if (bytes.length) { buf = buf.concat(bytes); }
        if (typeof body.next_offset === 'number') { fetchOffset = body.next_offset; }
        if (body.done === true) { serverDone = true; }
        pump();
        if (serverDone) { return; }
        if (bytes.length) { fetchMore(); } else { later(fetchMore, IDLE_POLL_MS); }
      });
    }

    function pump() {
      if (ended || sending || !startAcked) { return; }
      if (checkTimeouts()) { return; }
      var room = WINDOW_BYTES - (sent - watchPos);
      var n = Math.min(CHUNK_BYTES, buf.length, room);
      if (n % 2 === 1 && n < buf.length) { n -= 1; } // keep 16-bit samples whole
      if (n > 0) {
        var chunk = buf.slice(0, n);
        buf = buf.slice(n);
        sent += n;
        sending = true;
        env.send({ 'STATE': ST_AUDIO_DATA, 'AUDIO': chunk }, function () {
          sending = false;
          pump();
          fetchMore();
        }, function () { sending = false; fail('error'); });
        return;
      }
      if (serverDone && buf.length === 0 && !endQueued) {
        endQueued = true;
        sending = true;
        env.send({ 'STATE': ST_AUDIO_END }, function () {
          sending = false;
          finish('done', false);
        }, function () { sending = false; fail('error'); });
        return;
      }
      if (buf.length > 0 && room < 2) {
        // window full: wait for the watch to report progress (onWatchPos), re-check for a stall
        if (!waitTimer) {
          waitTimer = true;
          later(function () { waitTimer = false; pump(); }, 1000);
        }
      }
    }

    var payload = { text: String(opts.text) };
    env.request('POST', base + '/api/pebble/tts?format=' + encodeURIComponent(fmt), headers,
                JSON.stringify(payload), function (status, body) {
      if (ended) { return; }
      if (status === 501) { finish('unavailable', false); return; } // TTS not configured on the server
      if (status < 200 || status >= 300 || !body || !body.id) { finish('error', false); return; }
      jobId = body.id;
      var sdkFmt = typeof body.sdk_format === 'number' ? body.sdk_format : 0;
      startSent = true; // from here on the watch may have opened the stream
      env.send({ 'STATE': ST_AUDIO_START, 'AUDIO_FORMAT': sdkFmt }, function () {
        startAcked = true;
        lastProgress = env.now();
        fetchMore();
        pump();
      }, function () { finish('error', false); });
    });

    return {
      cancel: function () {
        if (ended) { return; }
        finish('cancelled', false);
      },
      /* watch reported cumulative consumed bytes */
      onWatchPos: function (n) {
        if (ended || typeof n !== 'number') { return; }
        if (n > watchPos) { watchPos = n; lastProgress = env.now(); }
        pump();
        fetchMore();
      },
      isActive: function () { return !ended; }
    };
  }
  return { speak: speak };
}

module.exports = {
  createSpeech: createSpeech,
  b64decode: b64decode,
  formatForQuality: formatForQuality,
  ST_AUDIO_START: ST_AUDIO_START,
  ST_AUDIO_DATA: ST_AUDIO_DATA,
  ST_AUDIO_END: ST_AUDIO_END,
  ST_AUDIO_STOP: ST_AUDIO_STOP,
  CHUNK_BYTES: CHUNK_BYTES,
  WINDOW_BYTES: WINDOW_BYTES,
  PAGE_BYTES: PAGE_BYTES
};
