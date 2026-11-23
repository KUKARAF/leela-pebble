/* Timer sync (ES5, no platform dependencies so it can be unit-tested in node).
 *
 *   GET {base}/api/pebble/timer -> {active, paused, remaining_ms, length_ms, label}
 *
 * The phone relays that to the watch as one AppMessage (STATE = ST_TIMER). The watch keeps its own
 * copy, so a failed fetch is simply ignored: the watch keeps counting offline.
 */
'use strict';

var ST_TIMER = 10;
var FLAG_ACTIVE = 1, FLAG_PAUSED = 2;
var MAX_MS = 86400000;
var MAX_LABEL = 60;

function clampMs(v) {
  v = Math.round(Number(v));
  if (!isFinite(v) || v < 0) { return 0; }
  return v > MAX_MS ? MAX_MS : v;
}

/* label text the watch fonts can draw (same replacements as replies) */
function cleanLabel(s, normalize) {
  s = String(s === undefined || s === null ? '' : s);
  if (normalize) { s = normalize(s); }
  s = s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  return s.length > MAX_LABEL ? s.substring(0, MAX_LABEL) : s;
}

/* Server body -> AppMessage dictionary (or null if the body is not a timer status). */
function buildMessage(body, normalize) {
  if (!body || typeof body !== 'object' || typeof body.active !== 'boolean') { return null; }
  var active = body.active;
  var flags = 0;
  if (active) { flags |= FLAG_ACTIVE; }
  if (active && body.paused === true) { flags |= FLAG_PAUSED; }
  var msg = { 'STATE': ST_TIMER, 'TIMER_FLAGS': flags };
  if (active) {
    msg['TIMER_REMAINING'] = clampMs(body.remaining_ms);
    msg['TIMER_LENGTH'] = clampMs(body.length_ms);
    msg['TIMER_LABEL'] = cleanLabel(body.label, normalize);
  }
  return msg;
}

/* opts: {serverUrl, token, normalize}; env: {request}. cb(msg) only on success. */
function fetchTimer(env, opts, cb) {
  var base = String(opts.serverUrl || '').replace(/\/+$/, '');
  if (!base || !opts.token) { return; }
  env.request('GET', base + '/api/pebble/timer', { 'Authorization': 'Bearer ' + opts.token }, null,
              function (status, body) {
    if (status < 200 || status >= 300) { return; }
    var msg = buildMessage(body, opts.normalize);
    if (msg) { cb(msg); }
  });
}

module.exports = {
  ST_TIMER: ST_TIMER,
  FLAG_ACTIVE: FLAG_ACTIVE,
  FLAG_PAUSED: FLAG_PAUSED,
  buildMessage: buildMessage,
  fetchTimer: fetchTimer
};
