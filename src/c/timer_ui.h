/* Timer screen, wakeups and phone sync for Leela.
 *
 * The server/Home Assistant own the timer. The watch keeps a local copy (persisted, so it keeps
 * counting with no connection), shows it with the Timer+ countdown face (src/c/timerplus, MIT) and
 * schedules wakeups so Leela reopens shortly before and at the end even after being closed. */
#pragma once
#include <pebble.h>

/* Load the persisted timer and subscribe to wakeups. Call before pushing the main window. */
void timer_ui_init(void);
/* After the main window is pushed: if we were launched by a wakeup, show the timer. */
void timer_ui_handle_launch(void);
/* Persist the timer and (re)schedule wakeups. */
void timer_ui_deinit(void);

/* Apply what the phone fetched from the server. `open` = show the timer if it is new/changed. */
void timer_ui_apply_sync(bool active, bool paused, int32_t remaining_ms, int32_t length_ms,
                         const char *label, bool open);

bool timer_ui_has_timer(void);
/* Push the countdown window (no-op without a timer). */
void timer_ui_show(void);
