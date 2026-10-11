use ramen::{connection::Connection, window::Window};
use std::{ffi::{c_char, c_void, CStr, CString}, ptr, sync::OnceLock};

extern "C" {
    fn ml_gm8_gl_create(view: *mut c_void, error: *mut c_char, capacity: usize) -> *mut c_void;
    fn ml_gm8_gl_destroy(context: *mut c_void);
    fn ml_gm8_gl_present(context: *mut c_void);
    fn ml_gm8_gl_set_interval(context: *mut c_void, interval: u32);
    fn ml_gm8_gl_get_interval(context: *mut c_void) -> u32;
}

/// A core-profile context attached to the native AppKit content view. AppKit
/// owns the window/input loop; this layer owns only the renderer context.
pub struct PlatformImpl { context: *mut c_void }

impl PlatformImpl {
    pub unsafe fn new(_connection: &Connection, window: &Window) -> Result<Self, String> {
        let mut error = [0 as c_char; 512];
        let context = ml_gm8_gl_create(window.nsview(), error.as_mut_ptr(), error.len());
        if context.is_null() {
            return Err(CStr::from_ptr(error.as_ptr()).to_string_lossy().into_owned());
        }
        Ok(Self { context })
    }

    pub unsafe fn get_function_loader() -> Result<impl FnMut(&str) -> *const c_void, String> {
        static OPENGL: OnceLock<usize> = OnceLock::new();
        let handle = *OPENGL.get_or_init(|| {
            libc::dlopen(c"/System/Library/Frameworks/OpenGL.framework/OpenGL".as_ptr(), libc::RTLD_NOW) as usize
        });
        if handle == 0 { return Err("macOS OpenGL.framework could not be loaded".into()); }
        Ok(move |name: &str| {
            CString::new(name).map(|symbol| libc::dlsym(handle as *mut c_void, symbol.as_ptr()).cast_const())
                .unwrap_or(ptr::null())
        })
    }

    pub unsafe fn clean_function_loader() { /* Framework stays loaded for the context lifetime. */ }
    pub unsafe fn swap_buffers(&self) { ml_gm8_gl_present(self.context); }
    pub unsafe fn set_swap_interval(&self, interval: u32) -> bool {
        ml_gm8_gl_set_interval(self.context, interval.min(1)); true
    }
    pub unsafe fn get_swap_interval(&self) -> u32 { ml_gm8_gl_get_interval(self.context) }
    pub unsafe fn wait_vsync(&self) {
        // Swapping another frame is not equivalent to the GM8 wait-only API.
        // Keep upstream's unsupported operation explicit in this beta.
        panic!("screen_wait_vsync is not implemented by the Mac OpenGMK beta");
    }
}

impl Drop for PlatformImpl {
    fn drop(&mut self) { unsafe { ml_gm8_gl_destroy(self.context); } }
}
