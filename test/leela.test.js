'use strict';
var assert = require('assert');
var L = require('../src/pkjs/leela.js');

// fake clock + scheduler + scripted server
function makeEnv(script) {
  var t = 0, queue = [], log = [];
  return {
    log: log,
    env: {
      now: function () { return t; },
      setTimeout: function (fn, ms) { var h = { at: t + ms, fn: fn }; queue.push(h); return h; },
      clearTimeout: function (h) { queue = queue.filter(function (q) { return q !== h; }); },
      request: function (method, url, headers, body, cb) {
        log.push({ method: method, url: url, headers: headers, body: body });
        var r = script.shift();
        assert.ok(r, 'unexpected request ' + method + ' ' + url);
        cb(r[0], r[1], r[2]);
      }
    },
    run: function () {
      while (queue.length) {
        queue.sort(function (a, b) { return a.at - b.at; });
        var h = queue.shift(); t = h.at; h.fn();
      }
    },
    advance: function (ms) { t += ms; }
  };
}
function collect() {
  var r = { chunks: [], done: null, error: null };
  return { r: r, hooks: {
    onChunk: function (c) { r.chunks.push(c); },
    onDone: function (txt) { r.done = txt; },
    onError: function (m, s) { r.error = { msg: m, status: s }; } } };
}
var OPTS = { serverUrl: 'https://x.test/', token: 'lpd_SECRET', text: 'hi', conversationId: 'c1' };

// 1. happy path: chunks reassembled, offsets followed, auth header sent
(function () {
  var s = makeEnv([
    [200, { id: 'abc', state: 'pending' }],
    [200, { state: 'pending', text: 'Hello ', next_offset: 6, done: false }],
    [200, { state: 'pending', text: '', next_offset: 6, done: false }],
    [200, { state: 'done', text: 'world ’s', next_offset: 14, done: true }]
  ]);
  var c = collect();
  L.createClient(s.env).ask(OPTS, c.hooks); s.run();
  assert.strictEqual(c.r.done, "Hello world 's");
  assert.deepStrictEqual(c.r.chunks, ['Hello ', 'world ’s']);
  assert.strictEqual(s.log[0].url, 'https://x.test/api/pebble/ask');
  assert.deepStrictEqual(JSON.parse(s.log[0].body), { text: 'hi', conversation_id: 'c1' });
  assert.strictEqual(s.log[1].url, 'https://x.test/api/pebble/ask/abc?offset=0');
  assert.strictEqual(s.log[3].url, 'https://x.test/api/pebble/ask/abc?offset=6');
  assert.strictEqual(s.log[0].headers.Authorization, 'Bearer lpd_SECRET');
})();

// 2. error state text is surfaced
(function () {
  var s = makeEnv([[200, { id: 'a', state: 'pending' }], [200, { state: 'error', text: 'Model unavailable', next_offset: 0, done: true }]]);
  var c = collect(); L.createClient(s.env).ask(OPTS, c.hooks); s.run();
  assert.strictEqual(c.r.error.msg, 'Model unavailable');
})();

// 3. HTTP errors on ask
[[401, 'Token rejected'], [403, 'Token rejected'], [429, 'Slow down'], [400, 'Request refused: too long'], [0, "Can't reach"], [503, 'Server error']]
.forEach(function (p) {
  var s = makeEnv([[p[0], p[0] === 400 ? { detail: 'too long' } : null]]);
  var c = collect(); L.createClient(s.env).ask(OPTS, c.hooks); s.run();
  assert.ok(c.r.error && c.r.error.msg.indexOf(p[1]) === 0, p[0] + ' -> ' + (c.r.error && c.r.error.msg));
  assert.strictEqual(s.log.length, 1);
});

// 4. 404 while polling = expired
(function () {
  var s = makeEnv([[200, { id: 'a', state: 'pending' }], [404, { detail: 'gone' }]]);
  var c = collect(); L.createClient(s.env).ask(OPTS, c.hooks); s.run();
  assert.ok(/expired/.test(c.r.error.msg));
})();

// 5. 429 while polling: backs off (Retry-After honoured), recovers, does not hammer
(function () {
  var s = makeEnv([[200, { id: 'a', state: 'pending' }],
    [429, { detail: 'rate' }, { 'retry-after': '7' }],
    [200, { state: 'done', text: 'ok', next_offset: 2, done: true }]]);
  var c = collect(); L.createClient(s.env).ask(OPTS, c.hooks);
  var before = s.log.length; s.run();
  assert.strictEqual(c.r.done, 'ok');
  assert.strictEqual(s.log.length, 3);
})();
// persistent 429 gives up with "Slow down"
(function () {
  var script = [[200, { id: 'a', state: 'pending' }]];
  for (var i = 0; i < 6; i++) { script.push([429, null]); }
  var s = makeEnv(script);
  var c = collect(); L.createClient(s.env).ask(OPTS, c.hooks); s.run();
  assert.ok(/^Slow down/.test(c.r.error.msg));
  assert.strictEqual(s.log.length, 1 + 4); // 1 ask + 1 poll + 3 retries
})();

// 6. timeout after 90s of pending
(function () {
  var script = [[200, { id: 'a', state: 'pending' }]];
  for (var i = 0; i < 200; i++) { script.push([200, { state: 'pending', text: '', next_offset: 0, done: false }]); }
  var s = makeEnv(script);
  var c = collect(); L.createClient(s.env).ask(OPTS, c.hooks); s.run();
  assert.ok(/too long/.test(c.r.error.msg));
  assert.ok(s.log.length <= 95);
})();

// 7. cancel stops polling
(function () {
  var s = makeEnv([[200, { id: 'a', state: 'pending' }], [200, { state: 'pending', text: 'x', next_offset: 1, done: false }]]);
  var c = collect(); var h = L.createClient(s.env).ask(OPTS, c.hooks); h.cancel(); s.run();
  assert.strictEqual(c.r.done, null); assert.strictEqual(s.log.length, 2);
})();

// 8. UTF-8-safe splitting
(function () {
  var str = new Array(300).join('aé€'); // 1+2+3 bytes
  var parts = L.splitUtf8(str, 200);
  assert.strictEqual(parts.join(''), str);
  parts.forEach(function (p) { assert.ok(Buffer.byteLength(p, 'utf8') <= 200); });
  assert.strictEqual(L.normalizeText('a 😀 “q” — b…'), 'a  "q" - b...');
  assert.deepStrictEqual(L.splitUtf8('', 10), []);
})();

console.log('all tests passed');
