//! @file timer.h
//! @brief Data and controls for timer
//!
//! Contains data and all functions for setting and accessing
//! a timer. Also saves and loads timers between closing and reopening.
//!
//! @author Eric D. Phillips
//! @data October 26, 2015
//! @bugs No known bugs

#include <pebble.h>

//! Get timer value
//! @param hr A pointer to where to store the hour value of the timer
//! @param min A pointer to where to store the minute value of the timer
//! @param sec A pointer to where to store the second value of the timer
void timer_get_time_parts(uint16_t *hr, uint16_t *min, uint16_t *sec);

//! Get the timer time in milliseconds
//! @return The current value of the timer in milliseconds
int64_t timer_get_value_ms(void);

//! Get the total timer time in milliseconds
//! @return The total value of the timer in milliseconds
int64_t timer_get_length_ms(void);

//! Check if the timer is vibrating
//! @return True if the timer is currently vibrating
bool timer_is_vibrating(void);

//! Check if timer is in stopwatch mode
//! @return True if it is counting up as a stopwatch
bool timer_is_chrono(void);

//! Check if timer or stopwatch is paused
//! @return True if the timer is paused
bool timer_is_paused(void);

//! Check if the timer is elapsed and vibrate if this is the first call after elapsing
void timer_check_elapsed(void);

//! Increment timer value currently being edited
//! @param increment The amount to increment by
void timer_increment(int64_t increment);

//! Toggle play pause state for timer
void timer_toggle_play_pause(void);

//! Rewind the timer back to its original value
void timer_rewind(void);

//! Reset the timer to zero
void timer_reset(void);

//! Save the timer to persistent storage
void timer_persist_store(void);

//! Read the timer from persistent storage
void timer_persist_read(void);

// ---- Leela additions: the phone/server owns the timer, this copy is what the watch keeps ----

//! Check if a timer exists (running, paused or ringing)
bool timer_is_set(void);

//! Adopt a timer reported by the server
//! @param remaining_ms Time left (0 or less means it is ringing)
//! @param length_ms The timer's full length (for the progress ring)
//! @param paused True if the timer is paused
void timer_set_remote(int64_t remaining_ms, int64_t length_ms, bool paused);

//! Short text shown instead of "Timer" in the header ("" for none)
const char *timer_get_label(void);
void timer_set_label(const char *label);
