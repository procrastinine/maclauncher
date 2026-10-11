// Owned macOS overlay for ramen ef715f65981f6c96f7f889258ff43b63cb472626.
// AppKit stays on the process main thread. Native objects never cross this ABI;
// window/view pointers are borrowed only for renderer attachment on that thread.
use crate::{connection, error::Error, event::Event, window};
use std::{ffi::{c_char, c_void, CString}, ptr::NonNull};

#[repr(C)]
#[derive(Default)]
struct NativeEvent { kind: u32, a: i32, b: i32 }

extern "C" {
    fn ml_ramen_is_main_thread() -> i32;
    fn ml_ramen_initialize() -> i32;
    fn ml_ramen_window_create(title: *const c_char, width: u32, height: u32,
        x: i32, y: i32, positioned: i32, borderless: i32, resizable: i32,
        visible: i32, maximised: i32, controls: u32, cursor: u32) -> *mut c_void;
    fn ml_ramen_window_destroy(window: *mut c_void);
    fn ml_ramen_pump_events();
    fn ml_ramen_window_next_event(window: *mut c_void, event: *mut NativeEvent) -> i32;
    fn ml_ramen_window_set_cursor(window: *mut c_void, cursor: u32);
    fn ml_ramen_window_set_borderless(window: *mut c_void, value: i32);
    fn ml_ramen_window_set_maximised(window: *mut c_void, value: i32);
    fn ml_ramen_window_set_resizable(window: *mut c_void, value: i32);
    fn ml_ramen_window_set_position(window: *mut c_void, x: i32, y: i32);
    fn ml_ramen_window_set_size(window: *mut c_void, width: u32, height: u32);
    fn ml_ramen_window_set_title(window: *mut c_void, title: *const c_char);
    fn ml_ramen_window_set_visible(window: *mut c_void, value: i32);
    fn ml_ramen_window_nsview(window: *mut c_void) -> *mut c_void;
    fn ml_ramen_window_nswindow(window: *mut c_void) -> *mut c_void;
}

fn assert_main_thread() {
    assert!(unsafe { ml_ramen_is_main_thread() } != 0, "ramen's AppKit window API must run on the main thread");
}

pub(crate) struct Connection;
impl Connection {
    pub(crate) fn new() -> Result<Self, Error> {
        if unsafe { ml_ramen_is_main_thread() } == 0 {
            return Err(Error::Text("AppKit window creation requires the process main thread".into()));
        }
        if unsafe { ml_ramen_initialize() } == 0 { return Err(Error::SystemResources); }
        Ok(Self)
    }
}

pub(crate) struct Window {
    handle: NonNull<c_void>,
    _connection: connection::Connection,
    event_buffer: Vec<Event>,
}

// All native access asserts the main thread. Off-thread Drop schedules native
// disposal on the main queue, preserving the upstream Send + Sync contract.
unsafe impl Send for Window {}
unsafe impl Sync for Window {}

impl Window {
    pub(crate) fn new(builder: window::Builder) -> Result<Self, Error> {
        assert_main_thread();
        let title = CString::new(builder.title.as_bytes()).map_err(|_| Error::Invalid)?;
        let (x, y) = builder.position.unwrap_or((0, 0));
        let controls = builder.style.controls.map(|c|
            u32::from(c.close) | (u32::from(c.minimise) << 1) | (u32::from(c.maximise) << 2)).unwrap_or(0);
        let handle = unsafe { ml_ramen_window_create(title.as_ptr(), u32::from(builder.size.0), u32::from(builder.size.1),
            i32::from(x), i32::from(y), i32::from(builder.position.is_some()), i32::from(builder.style.borderless),
            i32::from(builder.style.resizable), i32::from(builder.style.visible), i32::from(builder.maximised),
            controls, builder.cursor as u32) };
        let handle = NonNull::new(handle).ok_or(Error::SystemResources)?;
        Ok(Self { handle, _connection: builder.connection, event_buffer: Vec::with_capacity(256) })
    }

    pub(crate) fn events(&self) -> &[Event] { &self.event_buffer }
    pub(crate) fn poll_events(&mut self) {
        assert_main_thread();
        self.event_buffer.clear();
        unsafe { ml_ramen_pump_events(); }
        let mut native = NativeEvent::default();
        while unsafe { ml_ramen_window_next_event(self.handle.as_ptr(), &mut native) } != 0 {
            if let Some(event) = translate_event(&native) { self.event_buffer.push(event); }
        }
    }
    pub(crate) fn set_cursor(&self, cursor: window::Cursor) {
        assert_main_thread(); unsafe { ml_ramen_window_set_cursor(self.handle.as_ptr(), cursor as u32); }
    }
    pub(crate) fn set_borderless(&self, value: bool) {
        assert_main_thread(); unsafe { ml_ramen_window_set_borderless(self.handle.as_ptr(), i32::from(value)); }
    }
    pub(crate) fn set_maximised(&self, value: bool) {
        assert_main_thread(); unsafe { ml_ramen_window_set_maximised(self.handle.as_ptr(), i32::from(value)); }
    }
    pub(crate) fn set_resizable(&self, value: bool) {
        assert_main_thread(); unsafe { ml_ramen_window_set_resizable(self.handle.as_ptr(), i32::from(value)); }
    }
    pub(crate) fn set_position(&self, (x, y): (i16, i16)) {
        assert_main_thread(); unsafe { ml_ramen_window_set_position(self.handle.as_ptr(), i32::from(x), i32::from(y)); }
    }
    pub(crate) fn set_size(&self, (w, h): (u16, u16)) {
        assert_main_thread(); unsafe { ml_ramen_window_set_size(self.handle.as_ptr(), u32::from(w), u32::from(h)); }
    }
    pub(crate) fn set_title(&self, title: &str) {
        assert_main_thread();
        if let Ok(title) = CString::new(title) { unsafe { ml_ramen_window_set_title(self.handle.as_ptr(), title.as_ptr()); } }
    }
    pub(crate) fn set_visible(&self, value: bool) {
        assert_main_thread(); unsafe { ml_ramen_window_set_visible(self.handle.as_ptr(), i32::from(value)); }
    }
    pub(crate) fn nsview(&self) -> *mut c_void {
        assert_main_thread(); unsafe { ml_ramen_window_nsview(self.handle.as_ptr()) }
    }
    pub(crate) fn nswindow(&self) -> *mut c_void {
        assert_main_thread(); unsafe { ml_ramen_window_nswindow(self.handle.as_ptr()) }
    }
}
impl Drop for Window {
    fn drop(&mut self) { unsafe { ml_ramen_window_destroy(self.handle.as_ptr()); } }
}

fn translate_event(event: &NativeEvent) -> Option<Event> {
    let boolean = event.a != 0;
    let unsigned = (event.a.clamp(0, u16::MAX as i32) as u16, event.b.clamp(0, u16::MAX as i32) as u16);
    Some(match event.kind {
        1 => Event::CloseRequest, 2 => Event::Focus(boolean), 3 => Event::Maximise(boolean),
        4 => Event::Minimise(boolean), 5 => Event::Move((event.a.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            event.b.clamp(i16::MIN as i32, i16::MAX as i32) as i16)),
        6 => Event::Resize(unsigned), 7 => Event::Visible(boolean),
        #[cfg(feature = "input")]
        8 => Event::KeyboardDown(native_key(event.a)?),
        #[cfg(feature = "input")]
        9 => Event::KeyboardRepeat(native_key(event.a)?),
        #[cfg(feature = "input")]
        10 => Event::KeyboardUp(native_key(event.a)?),
        #[cfg(feature = "input")]
        11 => Event::Input(char::from_u32(event.a as u32)?),
        #[cfg(feature = "input")]
        12 | 13 => { let button = match event.a {
            0 => crate::input::MouseButton::Left, 1 => crate::input::MouseButton::Right,
            2 => crate::input::MouseButton::Middle, _ => return None };
            if event.kind == 12 { Event::MouseDown(button) } else { Event::MouseUp(button) } },
        #[cfg(feature = "input")]
        14 => Event::MouseMove(unsigned),
        #[cfg(feature = "input")]
        15 => Event::ScrollUp,
        #[cfg(feature = "input")]
        16 => Event::ScrollDown,
        #[cfg(feature = "input")]
        17 => Event::MouseEnter,
        #[cfg(feature = "input")]
        18 => Event::MouseLeave,
        _ => return None,
    })
}

#[cfg(feature = "input")]
fn native_key(code: i32) -> Option<crate::input::Key> {
    use crate::input::Key::*;
    Some(match code {
        0 => A, 1 => S, 2 => D, 3 => F, 4 => H, 5 => G, 6 => Z, 7 => X, 8 => C, 9 => V,
        10 => Oem102, 11 => B, 12 => Q, 13 => W, 14 => E, 15 => R, 16 => Y, 17 => T,
        18 => Alpha1, 19 => Alpha2, 20 => Alpha3, 21 => Alpha4, 22 => Alpha6, 23 => Alpha5,
        24 => Equals, 25 => Alpha9, 26 => Alpha7, 27 => Minus, 28 => Alpha8, 29 => Alpha0,
        30 => BracketRight, 31 => O, 32 => U, 33 => BracketLeft, 34 => I, 35 => P,
        36 => Return, 37 => L, 38 => J, 39 => Apostrophe, 40 => K, 41 => Semicolon,
        42 => Backslash, 43 => Comma, 44 => Slash, 45 => N, 46 => M, 47 => Period,
        48 => Tab, 49 => Space, 50 => Grave, 51 => Backspace, 53 => Escape,
        54 => RightSuper, 55 => LeftSuper, 56 => LeftShift, 57 => CapsLock,
        58 => LeftAlt, 59 => LeftControl, 60 => RightShift, 61 => RightAlt, 62 => RightControl,
        64 => F17, 65 => KeypadDecimal, 67 => KeypadMultiply, 69 => KeypadAdd,
        71 => Clear, 72 => MediaVolumeUp, 73 => MediaVolumeDown, 74 => MediaVolumeMute,
        75 => KeypadDivide, 76 => Return, 78 => KeypadSubtract, 79 => F18, 80 => F19,
        81 => Equals, 82 => Keypad0, 83 => Keypad1, 84 => Keypad2, 85 => Keypad3,
        86 => Keypad4, 87 => Keypad5, 88 => Keypad6, 89 => Keypad7, 91 => Keypad8, 92 => Keypad9,
        93 => Backslash, 94 => Underscore, 95 => KeypadSeparator, 96 => F5, 97 => F6,
        98 => F7, 99 => F3, 100 => F8, 101 => F9, 102 => ImeOn, 103 => F11,
        104 => ImeKanaOrHangul, 105 => F13, 106 => F16, 107 => F14, 109 => F10,
        111 => F12, 113 => F15, 114 => Insert, 115 => Home, 116 => PageUp,
        117 => Delete, 118 => F4, 119 => End, 120 => F2, 121 => PageDown,
        122 => F1, 123 => LeftArrow, 124 => RightArrow, 125 => DownArrow, 126 => UpArrow,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn close_focus_and_size_events_preserve_window_semantics() {
        assert_eq!(translate_event(&NativeEvent { kind: 1, a: 0, b: 0 }), Some(Event::CloseRequest));
        assert_eq!(translate_event(&NativeEvent { kind: 2, a: 1, b: 0 }), Some(Event::Focus(true)));
        assert_eq!(translate_event(&NativeEvent { kind: 5, a: -20, b: 80 }), Some(Event::Move((-20, 80))));
        assert_eq!(translate_event(&NativeEvent { kind: 6, a: 640, b: 480 }), Some(Event::Resize((640, 480))));
        assert_eq!(translate_event(&NativeEvent { kind: 6, a: -1, b: 70000 }), Some(Event::Resize((0, 65535))));
    }
    #[test]
    #[cfg(feature = "input")]
    fn physical_keys_preserve_both_sides_and_game_controls() {
        use crate::input::Key::*;
        for (native, key) in [(0, A), (6, Z), (7, X), (36, Return), (53, Escape), (56, LeftShift),
            (60, RightShift), (59, LeftControl), (62, RightControl), (55, LeftSuper), (54, RightSuper),
            (123, LeftArrow), (124, RightArrow), (125, DownArrow), (126, UpArrow), (122, F1), (51, Backspace), (117, Delete)] {
            assert_eq!(native_key(native), Some(key));
        }
        assert_eq!(native_key(127), None);
    }
    #[test]
    #[cfg(feature = "input")]
    fn input_is_unicode_and_unknown_buttons_are_rejected() {
        assert_eq!(translate_event(&NativeEvent { kind: 11, a: 0x1f680, b: 0 }), Some(Event::Input('🚀')));
        assert_eq!(translate_event(&NativeEvent { kind: 11, a: 0xd800, b: 0 }), None);
        assert_eq!(translate_event(&NativeEvent { kind: 12, a: 2, b: 0 }), Some(Event::MouseDown(crate::input::MouseButton::Middle)));
        assert_eq!(translate_event(&NativeEvent { kind: 12, a: 9, b: 0 }), None);
    }
}
