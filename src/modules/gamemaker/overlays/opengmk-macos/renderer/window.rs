//! Native desktop geometry for ordinary play, separate from TAS display spoofing.
use std::ffi::c_void;
extern "C" {
    fn ml_gm8_display_size(window: *mut c_void, width: *mut i32, height: *mut i32);
    fn ml_gm8_window_center(window: *mut c_void, x: *mut i32, y: *mut i32);
    fn ml_gm8_window_position(window: *mut c_void, x: *mut i32, y: *mut i32);
    fn ml_gm8_window_set_position(window: *mut c_void, x: i32, y: i32);
}
pub fn display_size(window: *mut c_void) -> (i32, i32) {
    let (mut width, mut height) = (0, 0);
    unsafe { ml_gm8_display_size(window, &mut width, &mut height); }
    (width, height)
}
pub fn center(window: *mut c_void) -> (i32, i32) {
    let (mut x, mut y) = (0, 0);
    unsafe { ml_gm8_window_center(window, &mut x, &mut y); }
    (x, y)
}
pub fn position(window: *mut c_void) -> (i32, i32) {
    let (mut x, mut y) = (0, 0);
    unsafe { ml_gm8_window_position(window, &mut x, &mut y); }
    (x, y)
}
pub fn set_position(window: *mut c_void, x: i32, y: i32) -> (i32, i32) {
    unsafe { ml_gm8_window_set_position(window, x, y); }
    position(window)
}
