'use strict';
var assert = require('assert');
var S = require('../src/pkjs/speech.js');

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

/* Scripted server holding `total` PCM bytes (value = index & 0xFF), revealed `revealPerPoll` at a time. */
function makeWorld(opts) {
  var t = 0, queue = [], log = [], sent = [], ackMode = opts.ackMode || 'sync';
  var total = opts.total, revealed = opts.reveal === undefined ? total : opts.reveal;
  var w = {
    log: log, sent: sent,
    env: {
      now: function () { return t; },
      setTimeout: function (fn, ms) { var h = { at: t + ms, fn: fn }; queue.push(h); return h; },
      clearTimeout: function (h) { queue = queue.filter(function (q) { return q !== h; }); },
      request: function (method, url, headers, body, cb) {
        log.push({ method: method, url: url, headers: headers, body: body });
        if (method === 'POST') {
          if (opts.postStatus !== undefined) { cb(opts.postStatus, null); return; }
          cb(200, { id: 'job1', state: 'pending', sdk_format: 0 });
          return;
        }
        var m = /offset=(\d+)&limit=(\d+)/.exec(url);
        var off = +m[1], lim = +m[2];
        if (opts.getStatus) { cb(opts.getStatus, null); return; }
        var end = Math.min(off + lim, revealed), bytes = [], i;
        for (i = off; i < end; i++) { bytes.push(i & 0xFF); }
        var fin = revealed >= total && end >= total;
        cb(200, { state: fin ? 'done' : 'pending', data: b64(bytes), next_offset: end,
                  total: revealed >= total ? total : null, done: fin });
      },
      send: function (msg, ok, fail) {
        sent.push(msg);
        if (opts.failSendAt !== undefined && sent.length === opts.failSendAt) { fail(); return; }
        if (ackMode === 'sync') { ok(); } else { w.pendingAck = ok; }
      }
    },
    run: function (limit) {
      var n = 0;
      while (queue.length && n++ < (limit || 10000)) {
        queue.sort(function (a, b) { return a.at - b.at; });
        var h = queue.shift(); t = h.at; h.fn();
      }
    },
    reveal: function (n) { revealed = n; },
    time: function () { return t; }
  };
  return w;
}
var OPTS = { serverUrl: 'https://x.test/', token: 'lpd_SECRET', text: 'hello', format: 'pcm8k8' };
function ends() { var r = { reason: null }; r.hooks = { onEnd: function (x) { r.reason = x; } }; return r; }
function audioOf(sent) {
  var out = [];
  sent.forEach(function (m) { if (m.STATE === S.ST_AUDIO_DATA) { out = out.concat(m.AUDIO); } });
  return out;
}

// base64 decode
assert.deepStrictEqual(S.b64decode(b64([0, 1, 2, 3, 250, 255])), [0, 1, 2, 3, 250, 255]);
assert.deepStrictEqual(S.b64decode(''), []);
assert.deepStrictEqual(S.b64decode(b64([7])), [7]);
assert.deepStrictEqual(S.b64decode(b64([7, 8])), [7, 8]);
assert.strictEqual(S.formatForQuality('best'), 'pcm16k');
assert.strictEqual(S.formatForQuality('good'), 'pcm8k');
assert.strictEqual(S.formatForQuality('nonsense'), 'pcm8k8');

// 1. happy path: START, all bytes in order in <=CHUNK_BYTES messages, END; auth + URL shape
(function () {
  var w = makeWorld({ total: 3000 }), e = ends();
  var h = S.createSpeech(w.env).speak(OPTS, e.hooks);
  h.onWatchPos(0); w.run();
  assert.strictEqual(e.reason, 'done');
  assert.strictEqual(w.sent[0].STATE, S.ST_AUDIO_START);
  assert.strictEqual(w.sent[0].AUDIO_FORMAT, 0);
  assert.strictEqual(w.sent[w.sent.length - 1].STATE, S.ST_AUDIO_END);
  var a = audioOf(w.sent);
  assert.strictEqual(a.length, 3000);
  a.forEach(function (v, i) { assert.strictEqual(v, i & 0xFF); });
  w.sent.forEach(function (m) { if (m.AUDIO) { assert.ok(m.AUDIO.length <= S.CHUNK_BYTES); } });
  assert.strictEqual(w.log[0].url, 'https://x.test/api/pebble/tts?format=pcm8k8');
  assert.deepStrictEqual(JSON.parse(w.log[0].body), { text: 'hello' });
  assert.strictEqual(w.log[0].headers.Authorization, 'Bearer lpd_SECRET');
  assert.ok(/\/api\/pebble\/tts\/job1\?offset=0&limit=\d+$/.test(w.log[1].url));
})();

// 2. flow control: never more than WINDOW_BYTES unconsumed; resumes when the watch reports progress
(function () {
  var w = makeWorld({ total: 40000 }), e = ends();
  var h = S.createSpeech(w.env).speak(OPTS, e.hooks);
  w.run(3);
  var inflight = audioOf(w.sent).length;
  assert.ok(inflight <= S.WINDOW_BYTES && inflight > S.WINDOW_BYTES - S.CHUNK_BYTES, 'window respected: ' + inflight);
  assert.strictEqual(e.reason, null);
  h.cancel();
})();
(function () {
  var w = makeWorld({ total: 40000 }), e = ends(), pos = 0, peak = 0;
  var h = S.createSpeech(w.env).speak(OPTS, e.hooks);
  var guard = 0;
  while (e.reason === null && guard++ < 500) {
    w.run(2);
    var unconsumed = audioOf(w.sent).length - pos;
    peak = Math.max(peak, unconsumed);
    pos = Math.min(audioOf(w.sent).length, pos + 3000); // watch drains 3000 bytes per round
    h.onWatchPos(pos);
  }
  assert.strictEqual(e.reason, 'done');
  assert.ok(peak <= S.WINDOW_BYTES, 'peak ' + peak);
})();

// 3. server still generating: polls with idle backoff, picks up late audio
(function () {
  var w = makeWorld({ total: 1000, reveal: 0 }), e = ends();
  var h = S.createSpeech(w.env).speak(OPTS, e.hooks);
  w.run(5);
  assert.strictEqual(audioOf(w.sent).length, 0);
  w.reveal(600); w.run(5);
  assert.strictEqual(audioOf(w.sent).length, 600);
  assert.strictEqual(e.reason, null);
  w.reveal(1000); w.run(50);
  assert.strictEqual(e.reason, 'done');
  assert.strictEqual(audioOf(w.sent).length, 1000);
})();

// 4. TTS not configured (501) / refused: silent end, nothing sent to the watch
[501, 429, 400, 500, 0].forEach(function (st) {
  var w = makeWorld({ total: 10, postStatus: st }), e = ends();
  S.createSpeech(w.env).speak(OPTS, e.hooks); w.run();
  assert.strictEqual(e.reason, st === 501 ? 'unavailable' : 'error');
  assert.strictEqual(w.sent.length, 0);
});

// 5. GET failures: retried then gives up and tells the watch to stop
(function () {
  var w = makeWorld({ total: 10, getStatus: 500 }), e = ends();
  S.createSpeech(w.env).speak(OPTS, e.hooks); w.run();
  assert.strictEqual(e.reason, 'error');
  assert.strictEqual(w.sent[w.sent.length - 1].STATE, S.ST_AUDIO_STOP);
  assert.strictEqual(w.log.filter(function (l) { return l.method === 'GET'; }).length, 5);
  var w2 = makeWorld({ total: 10, getStatus: 404 }), e2 = ends();
  S.createSpeech(w2.env).speak(OPTS, e2.hooks); w2.run();
  assert.strictEqual(e2.reason, 'error');
  assert.strictEqual(w2.log.filter(function (l) { return l.method === 'GET'; }).length, 1);
})();

// 6. cancel (user stopped / new question): no more requests or sends, no STOP echo
(function () {
  var w = makeWorld({ total: 40000 }), e = ends();
  var h = S.createSpeech(w.env).speak(OPTS, e.hooks);
  w.run(3);
  var sentBefore = w.sent.length, reqBefore = w.log.length;
  h.cancel(); h.onWatchPos(99999); w.run();
  assert.strictEqual(e.reason, 'cancelled');
  assert.strictEqual(w.sent.length, sentBefore);
  assert.strictEqual(w.log.length, reqBefore);
  assert.ok(!h.isActive());
})();

// 7. watch send failure aborts quietly
(function () {
  var w = makeWorld({ total: 5000, failSendAt: 3 }), e = ends();
  S.createSpeech(w.env).speak(OPTS, e.hooks); w.run();
  assert.strictEqual(e.reason, 'error');
})();

// 8. stalled watch (window full, never consumes) times out
(function () {
  var w = makeWorld({ total: 40000 }), e = ends();
  S.createSpeech(w.env).speak(OPTS, e.hooks); w.run(300);
  assert.strictEqual(e.reason, 'error');
  assert.ok(w.time() < 60000);
})();

// 9. odd leftover never splits a 16-bit sample mid-stream
(function () {
  var w = makeWorld({ total: 13000 }), e = ends();
  var h = S.createSpeech(w.env).speak(OPTS, e.hooks);
  w.run(100);
  h.onWatchPos(1); w.run(100); // room is odd
  w.sent.forEach(function (m) { if (m.AUDIO && m.STATE === S.ST_AUDIO_DATA) { assert.ok(m.AUDIO.length % 2 === 0 || m === w.sent[w.sent.length - 1]); } });
})();

console.log('speech tests passed');
