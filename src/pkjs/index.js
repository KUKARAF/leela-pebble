/* Leela PebbleKit JS (runs on the phone, ES5 only). */
var Clay = require('pebble-clay');
var clayConfig = require('./config');
var leela = require('./leela');

var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

// Watch-side STATE values (keep in sync with src/c/main.c)
var ST_READY = 1, ST_THINKING = 2, ST_CHUNK = 3, ST_DONE = 4, ST_ERROR = 5;
var WATCH_CHUNK_BYTES = 200;

var DEFAULT_SERVER = 'https://chat.osmosis.page';
var conversationId = leela.newConversationId(); // one per app launch, reused for follow-ups
var current = null;

function getSettings() {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('clay-settings')) || {}; } catch (e) { s = {}; }
  return {
    serverUrl: (typeof s.SERVER_URL === 'string' && s.SERVER_URL) ? s.SERVER_URL : DEFAULT_SERVER,
    token: typeof s.DEVICE_TOKEN === 'string' ? s.DEVICE_TOKEN.replace(/^\s+|\s+$/g, '') : '',
    speak: !!s.SPEAK_REPLIES
  };
}

/* ---- phone -> watch: one message at a time, in order, with retry ---- */
var outQueue = [], sending = false;
function pump() {
  if (sending || !outQueue.length) { return; }
  sending = true;
  var msg = outQueue[0], tries = 0;
  (function attempt() {
    Pebble.sendAppMessage(msg, function () {
      outQueue.shift(); sending = false; pump();
    }, function () {
      tries++;
      if (tries >= 3) { outQueue.shift(); sending = false; pump(); }
      else { setTimeout(attempt, 300 * tries); }
    });
  })();
}
function toWatch(state, text) {
  var m = { 'STATE': state };
  if (text !== undefined) { m['TEXT'] = text; }
  outQueue.push(m);
  pump();
}
function sendError(msg) {
  outQueue = [];
  toWatch(ST_ERROR, leela.trimTo(leela.normalizeText(msg), 200));
}

/* ---- XHR adapter for leela.createClient ---- */
function request(method, url, headers, body, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, url);
  xhr.timeout = 30000;
  Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
  xhr.onload = function () {
    var json = null;
    try { json = JSON.parse(xhr.responseText); } catch (e) { json = null; }
    var ra = xhr.getResponseHeader ? xhr.getResponseHeader('Retry-After') : null;
    cb(xhr.status, json, ra ? { 'retry-after': ra } : {});
  };
  xhr.onerror = function () { cb(0, null, {}); };
  xhr.ontimeout = function () { cb(0, null, {}); };
  xhr.send(body);
}
var client = leela.createClient({
  request: request,
  setTimeout: function (f, ms) { return setTimeout(f, ms); },
  clearTimeout: function (h) { clearTimeout(h); },
  now: function () { return new Date().getTime(); }
});

function handleAsk(text) {
  var s = getSettings();
  if (current) { current.cancel(); current = null; }
  if (!s.token) {
    sendError('No device token set. Open Leela settings in the Pebble app on your phone.');
    return;
  }
  text = leela.normalizeText(text);
  toWatch(ST_THINKING);
  current = client.ask(
    { serverUrl: s.serverUrl, token: s.token, text: text, conversationId: conversationId },
    {
      onChunk: function () { /* reply is pushed in one go when complete */ },
      onDone: function (reply) {
        current = null;
        reply = leela.trimTo(reply.replace(/^\s+|\s+$/g, '') || '(empty reply)', leela.MAX_REPLY_CHARS);
        leela.splitUtf8(reply, WATCH_CHUNK_BYTES).forEach(function (p) { toWatch(ST_CHUNK, p); });
        toWatch(ST_DONE);
      },
      onError: function (msg) { current = null; sendError(msg); }
    }
  );
}

Pebble.addEventListener('ready', function () {
  toWatch(ST_READY);
});

Pebble.addEventListener('appmessage', function (e) {
  var text = e.payload && e.payload['ASK'];
  if (typeof text === 'string' && text.length) { handleAsk(text); }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }
  try { clay.getSettings(e.response, false); } catch (err) { console.log('config parse failed'); }
});
