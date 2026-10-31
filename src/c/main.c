/* Leela: press SELECT, speak, read the reply.
 *
 * Watch side: DictationSession (speech-to-text happens via the phone's Pebble app),
 * text goes to PKJS over AppMessage, PKJS talks to the server and pushes the reply back
 * in <=200 byte chunks. See README.md. */
#include <pebble.h>

/* Keep in sync with src/pkjs/index.js */
enum { ST_READY = 1, ST_THINKING = 2, ST_CHUNK = 3, ST_DONE = 4, ST_ERROR = 5 };

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

static void set_ui(UiState st) {
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
static void select_click(ClickRecognizerRef r, void *c) { start_listening(); }
static void scroll_by(int dy) {
  GPoint o = scroll_layer_get_content_offset(s_scroll);
  o.y += dy;
  scroll_layer_set_content_offset(s_scroll, o, true);
}
static void up_click(ClickRecognizerRef r, void *c) { scroll_by(SCROLL_STEP); }
static void down_click(ClickRecognizerRef r, void *c) { scroll_by(-SCROLL_STEP); }
static void click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
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
  app_message_open(512, DICTATION_BUF + 64);

  s_dictation = dictation_session_create(DICTATION_BUF, dictation_cb, NULL);
  dictation_session_enable_confirmation(s_dictation, true);
  dictation_session_enable_error_dialogs(s_dictation, false);

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers){ .load = window_load, .unload = window_unload });
  window_stack_push(s_window, true);
}

static void deinit(void) {
  dictation_session_destroy(s_dictation);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
