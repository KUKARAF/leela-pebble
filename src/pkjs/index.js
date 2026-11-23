/* Leela PebbleKit JS (runs on the phone, ES5 only). */
var Clay = require('pebble-clay');
var clayConfig = require('./config');
var leela = require('./leela');
var speech = require('./speech');
var timerSync = require('./timer');

var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

// Watch-side STATE values (keep in sync with src/c/main.c)
var ST_READY = 1, ST_THINKING = 2, ST_CHUNK = 3, ST_DONE = 4, ST_ERROR = 5;
// (audio states 6..9 live in speech.js)
var WATCH_CHUNK_BYTES = 200;

var DEFAULT_SERVER = 'https://chat.osmosis.page';
var TIMER_POLL_MS = 60000; // re-sync the timer with the server about once a minute while Leela is open
var conversationId = leela.newConversationId(); // one per app launch, reused for follow-ups
var current = null;

function getSettings() {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('clay-settings')) || {}; } catch (e) { s = {}; }
  return {
    serverUrl: (typeof s.SERVER_URL === 'string' && s.SERVER_URL) ? s.SERVER_URL : DEFAULT_SERVER,
    token: typeof s.DEVICE_TOKEN === 'string' ? s.DEVICE_TOKEN.replace(/^\s+|\s+$/g, '') : '',
    speak: !!s.SPEAK_REPLIES,
    quality: typeof s.SPEAK_QUALITY === 'string' ? s.SPEAK_QUALITY : 'fast'
  };
}

/* ---- phone -> watch: one message at a time, in order, with retry ---- */
var outQueue = [], sending = false;
function pump() {
  if (sending || !outQueue.length) { return; }
  sending = true;
  var item = outQueue[0], tries = 0;
  function next(cb) {
    if (outQueue[0] === item) { outQueue.shift(); }
    sending = false;
    if (cb) { try { cb(); } catch (e) { console.log('send callback failed'); } }
    pump();
  }
  (function attempt() {
    if (outQueue[0] !== item) { sending = false; pump(); return; } // queue was flushed
    Pebble.sendAppMessage(item.msg, function () {
      next(item.ok);
    }, function () {
      tries++;
      if (tries >= 3) { next(item.fail); }
      else { setTimeout(attempt, 300 * tries); }
    });
  })();
}
function enqueue(msg, ok, fail) {
  outQueue.push({ msg: msg, ok: ok, fail: fail });
  pump();
}
function toWatch(state, text) {
  var m = { 'STATE': state };
  if (text !== undefined) { m['TEXT'] = text; }
  enqueue(m);
}
function sendError(msg) {
  stopSpeech();
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

/* ---- spoken replies: best effort, never affects the text reply ---- */
var speaker = speech.createSpeech({
  request: request,
  setTimeout: function (f, ms) { return setTimeout(f, ms); },
  clearTimeout: function (h) { clearTimeout(h); },
  now: function () { return new Date().getTime(); },
  send: function (msg, ok, fail) { enqueue(msg, ok, fail); }
});
var currentSpeech = null;
function stopSpeech() {
  if (currentSpeech) { currentSpeech.cancel(); currentSpeech = null; }
}
function startSpeech(s, text) {
  stopSpeech();
  try {
    var h = speaker.speak(
      { serverUrl: s.serverUrl, token: s.token, text: text, format: speech.formatForQuality(s.quality) },
      { onEnd: function (reason) { if (currentSpeech === h) { currentSpeech = null; } } }
    );
    currentSpeech = h;
  } catch (e) { console.log('speech failed to start'); }
}

function handleAsk(text, canSpeak) {
  var s = getSettings();
  if (current) { current.cancel(); current = null; }
  stopSpeech();
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
        syncTimer(); // pick up a timer set by this request right away
        if (s.speak && canSpeak) { startSpeech(s, reply); }
      },
      onError: function (msg) { current = null; sendError(msg); }
    }
  );
}

/* ---- timer: the server/HA own it; the watch keeps a local copy and just re-syncs ---- */
function syncTimer() {
  var s = getSettings();
  if (!s.token) { return; }
  timerSync.fetchTimer({ request: request },
    { serverUrl: s.serverUrl, token: s.token, normalize: leela.normalizeText },
    function (msg) { enqueue(msg); });
}
setInterval(syncTimer, TIMER_POLL_MS);

Pebble.addEventListener('ready', function () {
  toWatch(ST_READY);
  syncTimer();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p['AUDIO_STOP']) { stopSpeech(); }   // user pressed BACK/SELECT while it was speaking
  if (typeof p['AUDIO_POS'] === 'number' && currentSpeech) { currentSpeech.onWatchPos(p['AUDIO_POS']); }
  var text = p['ASK'];
  if (typeof text === 'string' && text.length) { handleAsk(text, !!p['CAN_SPEAK']); }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) { return; }
  try { clay.getSettings(e.response, false); } catch (err) { console.log('config parse failed'); }
});
