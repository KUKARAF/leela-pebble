#include "timer_ui.h"

#include "timerplus/drawing.h"
#include "timerplus/main.h"
#include "timerplus/timer.h"
#include "timerplus/utility.h"

/* Wakeup cookies */
enum { WAKE_NEAR = 1, WAKE_END = 2 };
#define NEAR_BEFORE_END_S 90     /* reopen this long before the end... */
#define NEAR_MIN_REMAINING_MS 150000 /* ...but only if that is still comfortably in the future */
#define SYNC_TOLERANCE_MS 2500   /* a local timer this close to the server's is "the same" */

static Window *s_win;
static Layer *s_layer;
static AppTimer *s_tick;
static void (*s_ask)(void);
static void (*s_close_overlay)(void);

void timer_ui_set_ask_handler(void (*ask)(void)) { s_ask = ask; }
void timer_ui_set_overlay_closer(void (*close_overlay)(void)) { s_close_overlay = close_overlay; }

/* Timer+'s drawing code asks the app which mode it is in: this screen only ever counts. */
ControlMode main_get_control_mode(void) { return ControlModeCounting; }

/* ---- wakeups ---- */
static void schedule_wakeups(void) {
  wakeup_cancel_all();
  if (!timer_is_set() || timer_is_paused() || timer_is_chrono()) { return; }
  int64_t value = timer_get_value_ms();
  time_t end = (time_t)((int64_t)(epoch() / MSEC_IN_SEC) + value / MSEC_IN_SEC);
  wakeup_schedule(end, WAKE_END, true);
  if (value > NEAR_MIN_REMAINING_MS) {
    wakeup_schedule(end - NEAR_BEFORE_END_S, WAKE_NEAR, false);
  }
}

static void wakeup_handler(WakeupId id, int32_t cookie) {
  if (!timer_is_set()) { return; }
  if (cookie == WAKE_NEAR) { vibes_short_pulse(); }
  timer_ui_show();
}

/* ---- countdown window ---- */
static void tick(void *ctx) {
  s_tick = NULL;
  if (!s_win || !window_stack_contains_window(s_win)) { return; }
  timer_check_elapsed();
  drawing_update();
  layer_mark_dirty(s_layer);
  if (!timer_is_paused()) {
    uint32_t d = (uint32_t)(timer_get_value_ms() % MSEC_IN_SEC);
    if (timer_is_chrono()) { d = MSEC_IN_SEC - d; }
    s_tick = app_timer_register(d + 5, tick, NULL);
  }
}

static void restart_tick(void) {
  if (s_tick) { app_timer_cancel(s_tick); s_tick = NULL; }
  tick(NULL);
}

/* Ringing, or past its end and still counting up. */
static bool is_ringing(void) { return timer_is_set() && timer_is_chrono(); }

bool timer_ui_is_ringing(void) { return is_ringing(); }

static void dismiss(void) {
  vibes_cancel();
  timer_reset();
  timer_set_label("");
  timer_persist_store();
  wakeup_cancel_all();
  restart_tick();   /* back to 0:00 */
}

static void any_click(ClickRecognizerRef r, void *c) {
  if (is_ringing()) { dismiss(); }   /* any button stops the alarm */
}
static void back_click(ClickRecognizerRef r, void *c) {
  if (is_ringing()) { dismiss(); } else { window_stack_pop(true); }   /* last window: leaves the app */
}
static void select_hold(ClickRecognizerRef r, void *c) {
  if (is_ringing()) { dismiss(); return; }
  if (s_ask) { s_ask(); }
}
static void click_config(void *ctx) {
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, select_hold, NULL);
  window_single_click_subscribe(BUTTON_ID_SELECT, any_click);
  window_single_click_subscribe(BUTTON_ID_UP, any_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, any_click);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click);
}

static void layer_proc(Layer *layer, GContext *ctx) { drawing_render(layer, ctx); }

static void win_appear(Window *w) { restart_tick(); }
static void win_disappear(Window *w) {
  if (s_tick) { app_timer_cancel(s_tick); s_tick = NULL; }
}

/* Created once and kept: Timer+'s drawing code loads its font in drawing_initialize. */
static void ensure_window(void) {
  if (s_win) { return; }
  s_win = window_create();
  window_set_background_color(s_win, GColorBlack);
  window_set_click_config_provider(s_win, click_config);
  window_set_window_handlers(s_win, (WindowHandlers){ .appear = win_appear, .disappear = win_disappear });
  Layer *root = window_get_root_layer(s_win);
  s_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_layer, layer_proc);
  layer_add_child(root, s_layer);
  drawing_initialize(s_layer);
}

void timer_ui_show(void) {
  ensure_window();
  if (!window_stack_contains_window(s_win)) {
    window_stack_push(s_win, true);
  } else if (window_stack_get_top_window() != s_win && s_close_overlay) {
    s_close_overlay();   /* a reply/error window is on top: take it away */
  }
  restart_tick();
}

/* ---- lifecycle ---- */
void timer_ui_init(void) {
  timer_persist_read();
  wakeup_service_subscribe(wakeup_handler);
}

void timer_ui_handle_launch(void) {
  timer_ui_show();   /* the countdown is always the home screen */
  if (launch_reason() == APP_LAUNCH_WAKEUP) {
    WakeupId id;
    int32_t cookie;
    if (wakeup_get_launch_event(&id, &cookie)) { wakeup_handler(id, cookie); }
  }
  schedule_wakeups();
}

void timer_ui_deinit(void) {
  if (s_tick) { app_timer_cancel(s_tick); s_tick = NULL; }
  timer_persist_store();
  schedule_wakeups();
  if (s_win) { window_destroy(s_win); s_win = NULL; }
  if (s_layer) { layer_destroy(s_layer); s_layer = NULL; }
  drawing_terminate();
}

/* ---- phone sync ---- */
void timer_ui_apply_sync(bool active, bool paused, int32_t remaining_ms, int32_t length_ms,
                         const char *label, bool may_open) {
  const char *lbl = label ? label : "";
  bool had = timer_is_set();
  if (!active) {
    /* Gone on the server (cancelled, or finished and dismissed). Keep a ringing local timer
     * until the user stops it. */
    if (had && !timer_is_chrono()) {
      timer_reset();
      timer_set_label("");
      timer_persist_store();
      wakeup_cancel_all();
      if (s_win && window_stack_contains_window(s_win)) { restart_tick(); }
    }
    return;
  }
  int64_t diff = timer_get_value_ms() - remaining_ms;
  /* A different timer (vs. the same one drifting or being paused/resumed): worth showing. */
  bool is_new = !had || timer_is_chrono() || timer_get_length_ms() != length_ms;
  bool differs = is_new || timer_is_paused() != paused || llabs(diff) > SYNC_TOLERANCE_MS ||
                 strcmp(timer_get_label(), lbl) != 0;
  if (differs) {
    timer_set_remote(remaining_ms, length_ms, paused);
    timer_set_label(lbl);
    timer_persist_store();
    schedule_wakeups();
  }
  if (is_new && may_open) {
    timer_ui_show();
  } else if (differs && s_win && window_stack_contains_window(s_win)) {
    restart_tick();
  }
}
