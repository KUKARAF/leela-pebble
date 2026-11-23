// Compatibility shim for the Timer+ drawing code (https://github.com/YclepticStudios/pebble-timer-plus,
// MIT, see licenses/timer-plus-MIT.md). Timer+ has an edit mode; Leela's timer screen only ever
// counts, so the drawing code is always told it is in counting mode.
#pragma once
#include <pebble.h>

#define BUTTON_HOLD_RESET_MS 750

typedef enum {
  ControlModeEditHr,
  ControlModeEditMin,
  ControlModeEditSec,
  ControlModeCounting
} ControlMode;

ControlMode main_get_control_mode(void);
