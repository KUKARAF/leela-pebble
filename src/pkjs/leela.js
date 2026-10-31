/* Leela client logic (ES5, no platform dependencies so it can be unit-tested in node).
 *
 * Talks to the Leela server:
 *   POST {base}/api/pebble/ask            {text, conversation_id} -> {id, state}
 *   GET  {base}/api/pebble/ask/{id}?offset=N -> {state, text, next_offset, done}
 * The bearer token is only ever placed in the Authorization header; it is never logged.
 */
'use strict';

var POLL_INTERVAL_MS = 1000; // server limit is 20 req/min per device, see README
var POLL_TIMEOUT_MS = 90000;
var MAX_RATE_LIMIT_RETRIES = 3;
var DEFAULT_BACKOFF_MS = 5000;
var MAX_REPLY_CHARS = 4000; // watch-side buffer is 4096 bytes

/* Replace characters the Pebble system fonts cannot draw. */
function normalizeText(s) {
  s = String(s === undefined || s === null ? '' : s);
  s = s.replace(/[‘’‚‛]/g, "'")
       .replace(/[“”„‟]/g, '"')
       .replace(/[–—−]/g, '-')
       .replace(/…/g, '...')
       .replace(/[•●◦]/g, '*')
       .replace(/[   ]/g, ' ')
       .replace(/[\uD800-\uDFFF]/g, '')      // astral chars (emoji): no glyphs on the watch
       .replace(/[︎️​-‍]/g, '')
       .replace(/\r\n?/g, '\n');
  return s;
}

function utf8Len(code) {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : 3; // surrogates were stripped by normalizeText
}

/* Split into pieces of at most maxBytes UTF-8 bytes, never inside a character. */
function splitUtf8(s, maxBytes) {
  var out = [], cur = '', bytes = 0, i, ch, n;
  for (i = 0; i < s.length; i++) {
    ch = s.charAt(i);
    n = utf8Len(s.charCodeAt(i));
    if (bytes + n > maxBytes) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  if (cur.length) { out.push(cur); }
  return out;
}

function trimTo(s, maxChars) {
  return s.length > maxChars ? s.substring(0, maxChars - 3) + '...' : s;
}

function errorMessageFor(status, detail) {
  if (status === 0) { return "Can't reach the server. Check your phone's connection."; }
  if (status === 401 || status === 403) { return 'Token rejected. Check the device token in the Leela settings on your phone.'; }
  if (status === 404) { return 'That reply expired. Please ask again.'; }
  if (status === 429) { return 'Slow down - too many requests. Wait a moment and retry.'; }
  if (status === 400) { return detail ? 'Request refused: ' + detail : 'Request refused by the server.'; }
  if (status === 501) { return 'The server does not support this yet.'; }
  if (status >= 500) { return 'Server error (' + status + '). Try again later.'; }
  return detail ? detail : 'Unexpected error (' + status + ').';
}

/* env = { request(method, url, headers, body, cb), setTimeout, clearTimeout, now }
 *   request cb: function (status, parsedJsonOrNull, headers)   status 0 = network failure
 */
function createClient(env) {
  function ask(opts, hooks) {
    var base = String(opts.serverUrl || '').replace(/\/+$/, '');
    var headers = { 'Authorization': 'Bearer ' + opts.token, 'Content-Type': 'application/json' };
    var text = '';
    var cancelled = false, timer = null, finished = false;
    var started = env.now();
    var rateRetries = 0;

    function fail(status, body) {
      if (finished) { return; }
      finished = true;
      var detail = body && typeof body.detail === 'string' ? body.detail : null;
      hooks.onError(errorMessageFor(status, detail), status);
    }
    function succeed() {
      if (finished) { return; }
      finished = true;
      hooks.onDone(text);
    }
    function later(fn, ms) { timer = env.setTimeout(function () { timer = null; fn(); }, ms); }

    function poll(id, offset) {
      if (cancelled || finished) { return; }
      if (env.now() - started > POLL_TIMEOUT_MS) {
        fail(-1, { detail: 'Leela took too long to answer. Try again.' });
        return;
      }
      env.request('GET', base + '/api/pebble/ask/' + encodeURIComponent(id) + '?offset=' + offset,
                  headers, null, function (status, body, rh) {
        if (cancelled || finished) { return; }
        if (status === 429) {
          rateRetries++;
          if (rateRetries > MAX_RATE_LIMIT_RETRIES) { fail(429, body); return; }
          var ra = rh && parseInt(rh['retry-after'], 10);
          later(function () { poll(id, offset); }, ra > 0 ? ra * 1000 : DEFAULT_BACKOFF_MS);
          return;
        }
        if (status < 200 || status >= 300 || !body) { fail(status, body); return; }
        if (body.state === 'error') {
          finished = true;
          hooks.onError(body.text ? normalizeText(body.text) : 'Leela hit an error.', 200);
          return;
        }
        var next = offset;
        if (typeof body.text === 'string' && body.text.length) {
          text += normalizeText(body.text);
          if (hooks.onChunk) { hooks.onChunk(body.text); }
        }
        if (typeof body.next_offset === 'number') { next = body.next_offset; }
        if (body.done === true || body.state === 'done') { succeed(); return; }
        // more data already available -> small delay only; otherwise normal interval
        later(function () { poll(id, next); }, POLL_INTERVAL_MS);
      });
    }

    var payload = { text: String(opts.text).substring(0, 1000) };
    if (opts.conversationId) { payload.conversation_id = opts.conversationId; }
    env.request('POST', base + '/api/pebble/ask', headers, JSON.stringify(payload),
                function (status, body) {
      if (cancelled) { return; }
      if (status < 200 || status >= 300 || !body) { fail(status, body); return; }
      if (body.state === 'error') { fail(-1, { detail: 'Leela could not start that request.' }); return; }
      if (!body.id) { fail(-1, { detail: 'Unexpected reply from the server.' }); return; }
      poll(body.id, 0);
    });

    return {
      cancel: function () {
        cancelled = true;
        if (timer !== null) { env.clearTimeout(timer); timer = null; }
      }
    };
  }
  return { ask: ask };
}

function newConversationId() {
  var s = 'w', i;
  for (i = 0; i < 16; i++) { s += Math.floor(Math.random() * 16).toString(16); }
  return s;
}

module.exports = {
  createClient: createClient,
  normalizeText: normalizeText,
  splitUtf8: splitUtf8,
  trimTo: trimTo,
  errorMessageFor: errorMessageFor,
  newConversationId: newConversationId,
  MAX_REPLY_CHARS: MAX_REPLY_CHARS,
  POLL_INTERVAL_MS: POLL_INTERVAL_MS
};
