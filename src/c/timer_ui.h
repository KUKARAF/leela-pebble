/* Timer screen, wakeups and phone sync for Leela.
 *
 * The server/Home Assistant own the timer. The watch keeps a local copy (persisted, so it keeps
 * counting with no connection), shows it with the Timer+ countdown face (src/c/timerplus, MIT) and
 * schedules wakeups so Leela reopens shortly before and at the end even after being closed. */
#pragma once
#include <pebble.h>

/* The countdown is Leela's home screen: it is always the bottom window (0:00 when no timer is set)
 * and the reply/error window is pushed over it. Hold SELECT on it starts voice input. */

/* Callbacks into main.c: start voice input; close the reply window (so a new timer shows). */
void timer_ui_set_ask_handler(void (*ask)(void));
void timer_ui_set_overlay_closer(void (*close_overlay)(void));

/* Load the persisted timer and subscribe to wakeups. */
void timer_ui_init(void);
/* Push the countdown as the root window; if a wakeup launched us, handle it. */
void timer_ui_handle_launch(void);
/* Persist the timer and (re)schedule wakeups. */
void timer_ui_deinit(void);

/* Apply what the phone fetched from the server (which mirrors the Home Assistant timer). A new
 * timer opens its countdown screen unless `may_open` is false. */
void timer_ui_apply_sync(bool active, bool paused, int32_t remaining_ms, int32_t length_ms,
                         const char *label, bool may_open);

/* Bring the countdown to the top. */
void timer_ui_show(void);
