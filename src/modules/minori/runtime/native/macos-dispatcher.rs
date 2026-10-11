use eden_engine::{ContextMenuCommand, ContextMenuState, ScreenMode};
use std::ffi::{c_char, CString};
extern "C" {
    fn ml_minori_context_menu(flags: u32) -> i32;
    fn ml_minori_save_comment(initial: *const c_char, max_chars: u32, output: *mut c_char, capacity: u32) -> i32;
    fn ml_minori_open_url(value: *const c_char) -> i32;
    fn ml_minori_double_click_interval() -> f64;
}
pub fn context_menu(state: ContextMenuState) -> Option<ContextMenuCommand> {
    use ContextMenuCommand::*;
    let flags = state.panel_hidden as u32 | (state.panel_toggle_enabled as u32) << 1 |
        (state.auto_checked as u32) << 2 | (state.skip_checked as u32) << 3 |
        (state.save_load_enabled as u32) << 4 | ((state.screen_mode == ScreenMode::Borderless) as u32) << 5;
    let commands = [ReturnToTitle, ToggleMessagePanel, ToggleAuto, ToggleSkip, QuickSave,
        Save, Load, Config, ScreenBorderless, ScreenWindowed, Help, Website, Exit];
    let selected = unsafe { ml_minori_context_menu(flags) };
    selected.checked_sub(1).and_then(|index| commands.get(index as usize).copied())
}
pub fn comment(initial: &str, max_chars: u16) -> Option<String> {
    let initial = CString::new(initial).ok()?;
    let mut output = vec![0u8; max_chars as usize * 4 + 1];
    if unsafe { ml_minori_save_comment(initial.as_ptr(), max_chars as u32, output.as_mut_ptr().cast(), output.len() as u32) } == 0 { return None; }
    let count = output.iter().position(|byte| *byte == 0)?;
    String::from_utf8(output[..count].to_vec()).ok()
}
pub fn open_url(value: &str) { if let Ok(value) = CString::new(value) { unsafe { ml_minori_open_url(value.as_ptr()); } } }
pub fn double_click_interval() -> std::time::Duration {
    std::time::Duration::from_secs_f64(unsafe { ml_minori_double_click_interval() }.clamp(0.1, 2.0))
}
