/* Leela: press SELECT, speak, read the reply.
 *
 * Watch side: DictationSession (speech-to-text happens via the phone's Pebble app),
 * text goes to PKJS over AppMessage, PKJS talks to the server and pushes the reply back
 * in <=200 byte chunks. With "Speak replies" on, PKJS then streams raw PCM which is played through
 * the speaker (speaker_stream_*, Pebble Time 2 only). See README.md. */
#include <pebble.h>

/* Keep in sync with src/pkjs/index.js */
enum { ST_READY = 1, ST_THINKING = 2, ST_CHUNK = 3, ST_DONE = 4, ST_ERROR = 5,
       ST_AUDIO_START = 6, ST_AUDIO_DATA = 7, ST_AUDIO_END = 8, ST_AUDIO_STOP = 9 };

/* Watches with a speaker. Everything else compiles the audio code out and never asks for speech. */
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_FLINT)
#define HAVE_SPEAKER 1
#endif

typedef enum { UI_IDLE, UI_LISTENING, UI_THINKING, UI_REPLY, UI_ERROR } UiState;

#define DICTATION_BUF 600
#define REPLY_BUF 4096
#define SCROLL_STEP 60

static Window *s_window;
static TextLayer *s_title;
static ScrollLayer *s_scroll;
static TextLayer *s_body;
static DictationSession *s_dictation;
static AppTimer *s_dots_timer;
static AppTimer *s_outbox_retry;

static UiState s_ui = UI_IDLE;
static bool s_phone_ready = false;
static char s_pending_ask[DICTATION_BUF + 1];
static char s_reply[REPLY_BUF];
static size_t s_reply_len = 0;
static char s_status[256];
static int s_dots = 0;

#define BODY_FONT FONT_KEY_GOTHIC_24_BOLD
#define BODY_FONT_SMALL FONT_KEY_GOTHIC_24

static void show_text(const char *text, const char *font_key) {
  Layer *sl = scroll_layer_get_layer(s_scroll);
  GRect b = layer_get_bounds(sl);
  text_layer_set_font(s_body, fonts_get_system_font(font_key));
  text_layer_set_text(s_body, text);
  GSize sz = text_layer_get_content_size(s_body);
  sz.h += 12;
  if (sz.h < b.size.h) { sz.h = b.size.h; }
  layer_set_frame(text_layer_get_layer(s_body), GRect(4, 0, b.size.w - 8, sz.h));
  scroll_layer_set_content_size(s_scroll, GSize(b.size.w, sz.h));
  scroll_layer_set_content_offset(s_scroll, GPointZero, false);
}

static void set_title(const char *t, GColor bg) {
  text_layer_set_text(s_title, t);
  text_layer_set_background_color(s_title, bg);
}

static void dots_tick(void *ctx) {
  s_dots_timer = NULL;
  if (s_ui != UI_THINKING) { return; }
  s_dots = (s_dots + 1) % 4;
  static const char *frames[4] = { "Thinking", "Thinking .", "Thinking . .", "Thinking . . ." };
  snprintf(s_status, sizeof(s_status), "%s", frames[s_dots]);
  text_layer_set_text(s_body, s_status);
  s_dots_timer = app_timer_register(450, dots_tick, NULL);
}

static void audio_stop(bool notify_phone);

static void set_ui(UiState st) {
  if (st != UI_REPLY) { audio_stop(true); }
  s_ui = st;
  if (s_dots_timer) { app_timer_cancel(s_dots_timer); s_dots_timer = NULL; }
  switch (st) {
    case UI_IDLE:
      set_title("Leela", PBL_IF_COLOR_ELSE(GColorVividViolet, GColorBlack));
      show_text("Press SELECT to talk to Leela", BODY_FONT);
      break;
    case UI_LISTENING:
      set_title("Listening", PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
      show_text("Speak now...", BODY_FONT);
      break;
    case UI_THINKING:
      set_title("Leela", PBL_IF_COLOR_ELSE(GColorVividViolet, GColorBlack));
      s_dots = 0;
      show_text("Thinking", BODY_FONT);
      s_dots_timer = app_timer_register(450, dots_tick, NULL);
      break;
    case UI_REPLY:
      set_title("Leela - SELECT to ask", PBL_IF_COLOR_ELSE(GColorVividViolet, GColorBlack));
      show_text(s_reply, BODY_FONT_SMALL);
      break;
    case UI_ERROR:
      set_title("Error - SELECT to retry", PBL_IF_COLOR_ELSE(GColorDarkCandyAppleRed, GColorBlack));
      show_text(s_status, BODY_FONT_SMALL);
      break;
  }
}

static void show_error(const char *msg) {
  snprintf(s_status, sizeof(s_status), "%s", msg);
  set_ui(UI_ERROR);
}


/* ---- spoken replies ----
 * PKJS sends raw signed PCM in <=480 byte AppMessages (ST_AUDIO_DATA). They go into a ring buffer;
 * a 40 ms timer moves what the speaker accepts from the ring into speaker_stream_write(). The
 * phone never has more than 12 KB unconsumed on the watch (it learns our progress from AUDIO_POS),
 * so the 16 KB ring cannot overflow. Playback starts after a small prebuffer to ride out gaps in
 * the Bluetooth link; if the speaker runs dry mid-reply we rebuffer and reopen the stream.
 * Anything that goes wrong just ends playback; the text reply is never affected. */
#ifdef HAVE_SPEAKER
#define RING_BYTES 16384
#define AUDIO_VOLUME 80
#define AUDIO_TICK_MS 40
#define POS_REPORT_BYTES 2048
#define CLOSE_TICKS_MAX 150   /* 6 s for the speaker to drain after close */

static uint8_t s_ring[RING_BYTES];
static size_t s_rhead, s_rtail, s_rcount;
static bool s_audio_active, s_audio_end, s_stream_open, s_audio_closing;
static SpeakerPcmFormat s_audio_fmt;
static uint32_t s_audio_prebuffer;
static uint32_t s_consumed, s_reported;
static int s_close_ticks;
static AppTimer *s_audio_timer;
static AppTimer *s_stop_notify_timer;
static int s_stop_notify_tries;

static uint32_t audio_bytes_per_sec(SpeakerPcmFormat f) {
  switch (f) {
    case SpeakerPcmFormat_8kHz_8bit: return 8000;
    case SpeakerPcmFormat_16kHz_8bit: return 16000;
    case SpeakerPcmFormat_8kHz_16bit: return 16000;
    default: return 32000;
  }
}

static void send_phone_int(uint32_t key, int32_t v) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) { return; }
  dict_write_int32(it, key, v);
  app_message_outbox_send();
}

static bool try_send_audio_pos(void) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) { return false; }
  dict_write_int32(it, MESSAGE_KEY_AUDIO_POS, (int32_t)s_consumed);
  if (app_message_outbox_send() != APP_MSG_OK) { return false; }
  s_reported = s_consumed;
  return true;
}

static void notify_stop_tick(void *ctx) {
  s_stop_notify_timer = NULL;
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) == APP_MSG_OK) {
    dict_write_int32(it, MESSAGE_KEY_AUDIO_STOP, 1);
    if (app_message_outbox_send() == APP_MSG_OK) { return; }
  }
  if (++s_stop_notify_tries < 6) {
    s_stop_notify_timer = app_timer_register(250, notify_stop_tick, NULL);
  }
}

static void audio_title(bool speaking) {
  if (s_ui != UI_REPLY) { return; }
  set_title(speaking ? "Leela - BACK to stop" : "Leela - SELECT to ask",
            PBL_IF_COLOR_ELSE(GColorVividViolet, GColorBlack));
}

static void audio_stop(bool notify_phone) {
  if (!s_audio_active) { return; }
  s_audio_active = false;
  if (s_audio_timer) { app_timer_cancel(s_audio_timer); s_audio_timer = NULL; }
  if (s_stream_open) { speaker_stop(); }
  s_stream_open = false;
  s_audio_closing = false;
  s_rhead = s_rtail = s_rcount = 0;
  if (notify_phone) {
    if (s_stop_notify_timer) { app_timer_cancel(s_stop_notify_timer); }
    s_stop_notify_tries = 0;
    notify_stop_tick(NULL);
  }
  audio_title(false);
}

static void speaker_finished(SpeakerFinishReason reason, void *ctx) {
  if (!s_audio_active) { return; }
  if (s_audio_closing || reason == SpeakerFinishReasonPreempted) {
    audio_stop(reason == SpeakerFinishReasonPreempted);
    return;
  }
  /* Ran dry (or errored) while more audio is still coming: rebuffer, then reopen. */
  s_stream_open = false;
}

static void audio_tick(void *ctx) {
  s_audio_timer = NULL;
  if (!s_audio_active) { return; }

  if (!s_stream_open && !s_audio_closing) {
    if (s_rcount >= s_audio_prebuffer || (s_audio_end && s_rcount > 0)) {
      if (!speaker_stream_open(s_audio_fmt, AUDIO_VOLUME)) { audio_stop(true); return; }
      s_stream_open = true;
    } else if (s_audio_end) {   /* nothing left to play */
      audio_stop(false);
      return;
    }
  }

  if (s_stream_open && s_rcount > 0) {
    size_t n = RING_BYTES - s_rtail;
    if (n > s_rcount) { n = s_rcount; }
    uint32_t w = speaker_stream_write(&s_ring[s_rtail], (uint32_t)n);
    if (w > n) { w = (uint32_t)n; }
    s_rtail = (s_rtail + w) % RING_BYTES;
    s_rcount -= w;
    s_consumed += w;
  }

  if (s_audio_end && s_stream_open && s_rcount == 0 && !s_audio_closing) {
    speaker_stream_close();   /* buffered audio keeps playing; the finish callback ends us */
    s_audio_closing = true;
    s_close_ticks = 0;
  }
  if (s_audio_closing) {
    if (++s_close_ticks > CLOSE_TICKS_MAX || speaker_get_status() == SpeakerStatusIdle) {
      audio_stop(false);
      return;
    }
  }

  if (s_consumed - s_reported >= POS_REPORT_BYTES || (s_rcount == 0 && s_consumed != s_reported)) {
    try_send_audio_pos();
  }
  s_audio_timer = app_timer_register(AUDIO_TICK_MS, audio_tick, NULL);
}

static void audio_start(int sdk_fmt) {
  if (s_audio_active) { audio_stop(false); }
  if (s_stop_notify_timer) { app_timer_cancel(s_stop_notify_timer); s_stop_notify_timer = NULL; }
  if (s_ui != UI_REPLY || sdk_fmt < 0 || sdk_fmt >= SpeakerPcmFormatCount || speaker_is_muted()) {
    send_phone_int(MESSAGE_KEY_AUDIO_STOP, 1);
    return;
  }
  s_audio_fmt = (SpeakerPcmFormat)sdk_fmt;
  uint32_t pre = audio_bytes_per_sec(s_audio_fmt) / 2;
  s_audio_prebuffer = pre < 2048 ? 2048 : (pre > 8192 ? 8192 : pre);
  s_rhead = s_rtail = s_rcount = 0;
  s_consumed = s_reported = 0;
  s_audio_end = s_stream_open = s_audio_closing = false;
  s_audio_active = true;
  audio_title(true);
  s_audio_timer = app_timer_register(AUDIO_TICK_MS, audio_tick, NULL);
}

static void audio_data(const uint8_t *data, uint16_t len) {
  if (!s_audio_active || s_audio_end) { return; }
  size_t room = RING_BYTES - s_rcount;
  size_t n = len < room ? len : room;   /* flow control keeps this from ever truncating */
  for (size_t i = 0; i < n; i++) {
    s_ring[s_rhead] = data[i];
    s_rhead = (s_rhead + 1) % RING_BYTES;
  }
  s_rcount += n;
}

static void audio_init(void) { speaker_set_finish_callback(speaker_finished, NULL); }
static void audio_deinit(void) {
  audio_stop(false);
  speaker_set_finish_callback(NULL, NULL);
  if (s_stop_notify_timer) { app_timer_cancel(s_stop_notify_timer); }
}
static bool audio_can_speak(void) { return !speaker_is_muted(); }
static bool audio_is_active(void) { return s_audio_active; }
static void audio_mark_end(void) { s_audio_end = true; }
#else
static void audio_stop(bool notify_phone) {}
static void audio_start(int sdk_fmt) {}
static void audio_data(const uint8_t *data, uint16_t len) {}
static void audio_init(void) {}
static void audio_deinit(void) {}
static bool audio_can_speak(void) { return false; }
static bool audio_is_active(void) { return false; }
static void audio_mark_end(void) {}
#endif

/* ---- watch -> phone ---- */
static void try_send_ask(void *ctx);

static void schedule_send_retry(void) {
  if (s_outbox_retry) { app_timer_cancel(s_outbox_retry); }
  s_outbox_retry = app_timer_register(500, try_send_ask, NULL);
}

static void try_send_ask(void *ctx) {
  s_outbox_retry = NULL;
  if (!s_pending_ask[0]) { return; }
  if (!s_phone_ready) { return; }   /* sent when the phone announces ST_READY */
  DictionaryIterator *it;
  AppMessageResult r = app_message_outbox_begin(&it);
  if (r != APP_MSG_OK) {
    if (r == APP_MSG_BUSY) { schedule_send_retry(); }
    else { show_error("Could not talk to the phone app."); s_pending_ask[0] = 0; }
    return;
  }
  dict_write_cstring(it, MESSAGE_KEY_ASK, s_pending_ask);
  dict_write_int32(it, MESSAGE_KEY_CAN_SPEAK, audio_can_speak() ? 1 : 0);
  if (app_message_outbox_send() != APP_MSG_OK) {
    show_error("Could not talk to the phone app.");
  }
  s_pending_ask[0] = 0;
}

static void outbox_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  if (s_ui == UI_THINKING) {
    show_error("Phone not reachable. Is the Pebble app connected?");
  }
}

/* ---- phone -> watch ---- */
static void inbox_received(DictionaryIterator *it, void *ctx) {
  Tuple *st = dict_find(it, MESSAGE_KEY_STATE);
  Tuple *tx = dict_find(it, MESSAGE_KEY_TEXT);
  if (!st) { return; }
  switch (st->value->int32) {
    case ST_READY:
      s_phone_ready = true;
      if (s_pending_ask[0]) { try_send_ask(NULL); }
      break;
    case ST_THINKING:
      s_reply_len = 0; s_reply[0] = 0;
      if (s_ui != UI_THINKING) { set_ui(UI_THINKING); }
      break;
    case ST_CHUNK:
      if (tx && s_ui == UI_THINKING) {
        size_t n = strlen(tx->value->cstring);
        if (s_reply_len + n < REPLY_BUF) {
          memcpy(s_reply + s_reply_len, tx->value->cstring, n);
          s_reply_len += n; s_reply[s_reply_len] = 0;
        }
      }
      break;
    case ST_DONE:
      if (s_ui == UI_THINKING) {
        if (s_reply_len == 0) { snprintf(s_reply, sizeof(s_reply), "(empty reply)"); }
        set_ui(UI_REPLY);
        vibes_short_pulse();
      }
      break;
    case ST_AUDIO_START: {
      Tuple *f = dict_find(it, MESSAGE_KEY_AUDIO_FORMAT);
      audio_start(f ? (int)f->value->int32 : -1);
      break;
    }
    case ST_AUDIO_DATA: {
      Tuple *a = dict_find(it, MESSAGE_KEY_AUDIO);
      if (a && a->type == TUPLE_BYTE_ARRAY) { audio_data(a->value->data, a->length); }
      break;
    }
    case ST_AUDIO_END:
      audio_mark_end();
      break;
    case ST_AUDIO_STOP:
      audio_stop(false);
      break;
    case ST_ERROR:
      show_error(tx ? tx->value->cstring : "Something went wrong.");
      vibes_double_pulse();
      break;
  }
}

/* ---- dictation ---- */
static void dictation_cb(DictationSession *session, DictationSessionStatus status,
                         char *transcription, void *ctx) {
  if (status == DictationSessionStatusSuccess) {
    snprintf(s_pending_ask, sizeof(s_pending_ask), "%s", transcription);
    set_ui(UI_THINKING);
    try_send_ask(NULL); /* if PKJS is not ready yet this waits for ST_READY */
    return;
  }
  /* Cancelled by the user: go back to where we were without a scary message. */
  if (status == DictationSessionStatusFailureTranscriptionRejected ||
      status == DictationSessionStatusFailureSystemAborted) {
    set_ui(s_reply_len ? UI_REPLY : UI_IDLE);
    return;
  }
  switch (status) {
    case DictationSessionStatusFailureNoSpeechDetected: show_error("I did not hear anything."); break;
    case DictationSessionStatusFailureConnectivityError: show_error("Voice needs the phone connected."); break;
    case DictationSessionStatusFailureDisabled: show_error("Voice dictation is disabled on this watch."); break;
    default: show_error("Dictation failed."); break;
  }
}

static void start_listening(void) {
  if (s_ui == UI_LISTENING || s_ui == UI_THINKING) { return; }
  set_ui(UI_LISTENING);
  dictation_session_start(s_dictation);
}

/* ---- buttons ---- */
static void select_click(ClickRecognizerRef r, void *c) {
  if (audio_is_active()) { audio_stop(true); return; }   /* SELECT while speaking = stop */
  start_listening();
}
static void back_click(ClickRecognizerRef r, void *c) {
  if (audio_is_active()) { audio_stop(true); return; }   /* BACK while speaking = stop, stay in app */
  window_stack_pop(true);
}
static void scroll_by(int dy) {
  GPoint o = scroll_layer_get_content_offset(s_scroll);
  o.y += dy;
  scroll_layer_set_content_offset(s_scroll, o, true);
}
static void up_click(ClickRecognizerRef r, void *c) { scroll_by(SCROLL_STEP); }
static void down_click(ClickRecognizerRef r, void *c) { scroll_by(-SCROLL_STEP); }
static void click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click);
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 120, up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 120, down_click);
}

/* ---- window ---- */
static void window_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  window_set_background_color(w, GColorWhite);

  s_title = text_layer_create(GRect(0, 0, b.size.w, 28));
  text_layer_set_font(s_title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_color(s_title, GColorWhite);
  text_layer_set_text_alignment(s_title, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_title));

  s_scroll = scroll_layer_create(GRect(0, 28, b.size.w, b.size.h - 28));
  s_body = text_layer_create(GRect(4, 0, b.size.w - 8, 2000));
  text_layer_set_text_color(s_body, GColorBlack);
  text_layer_set_background_color(s_body, GColorClear);
  scroll_layer_add_child(s_scroll, text_layer_get_layer(s_body));
  layer_add_child(root, scroll_layer_get_layer(s_scroll));

  set_ui(UI_IDLE);
}

static void window_unload(Window *w) {
  if (s_dots_timer) { app_timer_cancel(s_dots_timer); }
  if (s_outbox_retry) { app_timer_cancel(s_outbox_retry); }
  text_layer_destroy(s_body);
  scroll_layer_destroy(s_scroll);
  text_layer_destroy(s_title);
}

static void init(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(600, DICTATION_BUF + 96);
  audio_init();

  s_dictation = dictation_session_create(DICTATION_BUF, dictation_cb, NULL);
  dictation_session_enable_confirmation(s_dictation, true);
  dictation_session_enable_error_dialogs(s_dictation, false);

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers){ .load = window_load, .unload = window_unload });
  window_stack_push(s_window, true);
}

static void deinit(void) {
  audio_deinit();
  dictation_session_destroy(s_dictation);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
