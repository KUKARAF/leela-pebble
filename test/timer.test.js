'use strict';
var assert = require('assert');
var T = require('../src/pkjs/timer.js');
var L = require('../src/pkjs/leela.js');

// inactive: only STATE + flags 0
assert.deepStrictEqual(T.buildMessage({ active: false }, true), { STATE: 10, TIMER_FLAGS: 0 });

// active running timer, no open
var m = T.buildMessage({ active: true, paused: false, remaining_ms: 600000, length_ms: 1200000, label: 'pasta' }, false);
assert.deepStrictEqual(m, { STATE: 10, TIMER_FLAGS: 1, TIMER_REMAINING: 600000, TIMER_LENGTH: 1200000, TIMER_LABEL: 'pasta' });

// open flag only when active; paused flag
m = T.buildMessage({ active: true, paused: true, remaining_ms: 5000, length_ms: 10000, label: '' }, true);
assert.strictEqual(m.TIMER_FLAGS, T.FLAG_ACTIVE | T.FLAG_PAUSED | T.FLAG_OPEN);
assert.strictEqual(T.buildMessage({ active: false, paused: true }, true).TIMER_FLAGS, 0);

// clamping and junk
m = T.buildMessage({ active: true, remaining_ms: -5, length_ms: 9e12, label: null }, false);
assert.strictEqual(m.TIMER_REMAINING, 0);
assert.strictEqual(m.TIMER_LENGTH, 86400000);
assert.strictEqual(m.TIMER_LABEL, '');
m = T.buildMessage({ active: true, remaining_ms: 'abc', length_ms: NaN }, false);
assert.strictEqual(m.TIMER_REMAINING, 0);
assert.strictEqual(m.TIMER_LENGTH, 0);
assert.strictEqual(T.buildMessage(null, false), null);
assert.strictEqual(T.buildMessage({}, false), null);
assert.strictEqual(T.buildMessage('x', false), null);

// label: normalized for the watch fonts, one line, capped
m = T.buildMessage({ active: true, remaining_ms: 1, length_ms: 1, label: 'café’s  \n tea ' + new Array(100).join('x') }, false, L.normalizeText);
assert.ok(m.TIMER_LABEL.indexOf("'s tea") !== -1);
assert.ok(m.TIMER_LABEL.length <= 60);
assert.ok(m.TIMER_LABEL.indexOf('\n') === -1);

// fetchTimer: success sends, failures and missing settings stay silent
var calls = [], got = [];
function env(status, body) {
  return { request: function (method, url, headers, b, cb) { calls.push({ method: method, url: url, headers: headers, body: b }); cb(status, body, {}); } };
}
T.fetchTimer(env(200, { active: true, remaining_ms: 1000, length_ms: 2000, label: 'x' }),
             { serverUrl: 'https://s.example/', token: 'tok', open: true }, function (msg) { got.push(msg); });
assert.strictEqual(calls[0].method, 'GET');
assert.strictEqual(calls[0].url, 'https://s.example/api/pebble/timer');
assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok');
assert.strictEqual(got.length, 1);
assert.strictEqual(got[0].TIMER_FLAGS, 5);

T.fetchTimer(env(401, { detail: 'no' }), { serverUrl: 'https://s', token: 't' }, function (m) { got.push(m); });
T.fetchTimer(env(0, null), { serverUrl: 'https://s', token: 't' }, function (m) { got.push(m); });
T.fetchTimer(env(200, { weird: 1 }), { serverUrl: 'https://s', token: 't' }, function (m) { got.push(m); });
var n = calls.length;
T.fetchTimer(env(200, { active: false }), { serverUrl: 'https://s', token: '' }, function (m) { got.push(m); });
assert.strictEqual(calls.length, n, 'no token: no request');
assert.strictEqual(got.length, 1);
console.log('timer tests passed');
