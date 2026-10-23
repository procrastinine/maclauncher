// MacLauncher platform adapter. Uses installed CoreText fonts without copying them.
use fontdue::Font;
use std::ffi::{c_char, c_void};
use std::path::PathBuf;
type Ref = *const c_void;
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: Ref);
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFStringGetCString(value: Ref, buffer: *mut c_char, capacity: isize, encoding: u32) -> u8;
    fn CFURLGetFileSystemRepresentation(url: Ref, resolve: u8, buffer: *mut u8, capacity: isize) -> u8;
}
#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontCollectionCreateFromAvailableFonts(options: Ref) -> Ref;
    fn CTFontCollectionCreateMatchingFontDescriptors(collection: Ref) -> Ref;
    fn CTFontDescriptorCopyAttribute(descriptor: Ref, attribute: Ref) -> Ref;
    static kCTFontURLAttribute: Ref;
    static kCTFontNameAttribute: Ref;
}
struct Owned(Ref);
impl Drop for Owned { fn drop(&mut self) { if !self.0.is_null() { unsafe { CFRelease(self.0) }; } } }
#[derive(Clone)]
struct SystemFace { name: String, path: PathBuf }
fn system_faces() -> Vec<SystemFace> {
    unsafe {
        let collection = Owned(CTFontCollectionCreateFromAvailableFonts(std::ptr::null()));
        if collection.0.is_null() { return Vec::new(); }
        let descriptors = Owned(CTFontCollectionCreateMatchingFontDescriptors(collection.0));
        if descriptors.0.is_null() { return Vec::new(); }
        let mut result = Vec::new();
        for index in 0..CFArrayGetCount(descriptors.0).min(8192) {
            let descriptor = CFArrayGetValueAtIndex(descriptors.0, index);
            let name = Owned(CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute));
            let url = Owned(CTFontDescriptorCopyAttribute(descriptor, kCTFontURLAttribute));
            if name.0.is_null() || url.0.is_null() { continue; }
            let mut name_buffer = [0i8; 1024]; let mut path_buffer = [0u8; 4096];
            if CFStringGetCString(name.0, name_buffer.as_mut_ptr(), 1024, 0x08000100) == 0 ||
                CFURLGetFileSystemRepresentation(url.0, 1, path_buffer.as_mut_ptr(), 4096) == 0 { continue; }
            let name = std::ffi::CStr::from_ptr(name_buffer.as_ptr()).to_string_lossy().into_owned();
            let count = path_buffer.iter().position(|&byte| byte == 0).unwrap_or(path_buffer.len());
            use std::os::unix::ffi::OsStringExt;
            let path = PathBuf::from(std::ffi::OsString::from_vec(path_buffer[..count].to_vec()));
            if path.is_absolute() && !name.is_empty() { result.push(SystemFace { name, path }); }
        }
        result.sort_by(|left, right| left.name.cmp(&right.name));
        result.dedup_by(|left, right| left.name == right.name); result
    }
}
fn font_for_face(face: &SystemFace) -> anyhow::Result<Font> {
    let metadata = std::fs::metadata(&face.path)?;
    anyhow::ensure!(metadata.len() <= 64 * 1024 * 1024, "System font exceeds its size limit");
    let bytes = std::fs::read(&face.path)?;
    let count = ttf_parser::fonts_in_collection(&bytes).unwrap_or(1).min(256);
    for index in 0..count {
        let Ok(parsed) = ttf_parser::Face::parse(&bytes, index) else { continue; };
        let matches = count == 1 || parsed.names().into_iter().any(|name|
            [ttf_parser::name_id::POST_SCRIPT_NAME, ttf_parser::name_id::FULL_NAME,
                ttf_parser::name_id::FAMILY].contains(&name.name_id) &&
                name.to_string().is_some_and(|name| name.eq_ignore_ascii_case(&face.name)));
        if !matches || parsed.glyph_index('あ').is_none() || parsed.glyph_index('手').is_none() { continue; }
        return Font::from_bytes(bytes.clone(), fontdue::FontSettings { collection_index: index, ..Default::default() })
            .map_err(|error| anyhow::anyhow!("{}: {error}", face.name));
    }
    anyhow::bail!("{} has no compatible Japanese TrueType face", face.name)
}
pub(super) fn names() -> Vec<String> { system_faces().into_iter().map(|face| face.name).collect() }
pub(super) fn load(requested: &str) -> anyhow::Result<Font> {
    let face = system_faces().into_iter().find(|face| face.name.eq_ignore_ascii_case(requested))
        .ok_or_else(|| anyhow::anyhow!("System font is unavailable: {requested}"))?;
    font_for_face(&face)
}
pub(super) fn default_font(preferred: &str) -> anyhow::Result<(Font, Vec<String>, String)> {
    let faces = system_faces();
    let names = faces.iter().map(|face| face.name.clone()).collect();
    for name in [preferred, "HiraginoSans-W3", "HiraKakuProN-W3", "HiraginoKakuGothicProN-W3", "YuGothic-Regular"] {
        if let Some(face) = faces.iter().find(|face| face.name.eq_ignore_ascii_case(name)) {
            if let Ok(font) = font_for_face(face) { return Ok((font, names, face.name.clone())); }
        }
    }
    for face in &faces {
        if let Ok(font) = font_for_face(face) { return Ok((font, names, face.name.clone())); }
    }
    anyhow::bail!("No installed Japanese TrueType font is available")
}
#[cfg(test)]
mod tests {
    #[test] fn resolves_installed_japanese_font() {
        let (font, names, name) = super::default_font("").unwrap();
        assert!(!names.is_empty()); assert!(names.contains(&name));
        assert!(font.lookup_glyph_index('あ') != 0); assert!(font.lookup_glyph_index('手') != 0);
        assert!(super::load(&name).is_ok()); assert!(super::load("__missing_maclauncher_font__").is_err());
    }
}
