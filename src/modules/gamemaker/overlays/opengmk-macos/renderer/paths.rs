//! Original content is read in place. Writes in the original game namespace
//! resolve into a private directory; append/read-write copies one existing file.
use std::{fs, io, path::{Component, Path, PathBuf}, sync::OnceLock};
struct Roots { original: PathBuf, writable: PathBuf }
static ROOTS: OnceLock<Roots> = OnceLock::new();

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component { Component::CurDir => (), Component::ParentDir => { out.pop(); }, _ => out.push(component.as_os_str()) }
    }
    out
}
fn normalized_input(path: impl AsRef<Path>) -> PathBuf {
    PathBuf::from(path.as_ref().to_string_lossy().replace('\\', "/"))
}
fn canonicalize_existing_parent(path: &Path) -> PathBuf {
    let mut current = path;
    let mut missing = Vec::new();
    loop {
        if let Ok(mut observed) = current.canonicalize() {
            for component in missing.iter().rev() { observed.push(component); }
            return observed;
        }
        match (current.file_name(), current.parent()) {
            (Some(name), Some(parent)) => { missing.push(name.to_os_string()); current = parent; },
            _ => return path.to_path_buf(),
        }
    }
}
pub fn configure(original: &Path, writable: &Path) -> io::Result<()> {
    let original = original.canonicalize()?;
    let writable = writable.canonicalize()?;
    if !original.is_dir() || !writable.is_dir() || writable.starts_with(&original) || original.starts_with(&writable) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Writable game directory must be separate from the original content"));
    }
    ROOTS.set(Roots { original, writable }).map_err(|_|io::Error::new(io::ErrorKind::AlreadyExists, "Game directories already configured"))
}
pub fn working_directory(original: &Path) -> PathBuf { ROOTS.get().map(|roots|roots.writable.clone()).unwrap_or_else(||original.to_path_buf()) }

fn names(path: impl AsRef<Path>) -> (PathBuf, Option<PathBuf>) {
    let input = normalized_input(path);
    let cwd = std::env::current_dir().unwrap_or_default();
    let absolute = normalize(&if input.is_absolute() { input } else { cwd.join(input) });
    let Some(roots) = ROOTS.get() else { return (absolute, None) };
    // Resolve existing source aliases before deciding whether a path belongs to
    // the original namespace, while never treating private aliases as writable.
    let observed = canonicalize_existing_parent(&absolute);
    if let Ok(relative) = observed.strip_prefix(&roots.original) {
        return (roots.writable.join(relative), Some(observed))
    }
    if let Ok(relative) = absolute.strip_prefix(&roots.writable) {
        return (absolute.clone(), Some(roots.original.join(relative)))
    }
    (absolute, None)
}
pub fn read_path(path: impl AsRef<Path>) -> PathBuf {
    let (writable, original) = names(path);
    if writable.exists() { writable } else { original.filter(|path|path.exists()).unwrap_or(writable) }
}
pub fn write_path(path: impl AsRef<Path>, copy_existing: bool) -> io::Result<PathBuf> {
    let (writable, original) = names(path);
    if let Some(roots) = ROOTS.get() {
        if writable.starts_with(&roots.original) { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "Original game content is read-only")) }
        if writable.starts_with(&roots.writable) {
            let mut current = roots.writable.clone();
            for part in writable.strip_prefix(&roots.writable).unwrap().components() {
                current.push(part.as_os_str());
                if fs::symlink_metadata(&current).is_ok_and(|stat|stat.file_type().is_symlink()) {
                    return Err(io::Error::new(io::ErrorKind::PermissionDenied, "Private game writes cannot follow symlinks"))
                }
            }
            if let Some(parent) = writable.parent() { fs::create_dir_all(parent)?; }
        }
    }
    if copy_existing && !writable.exists() {
        if let Some(original) = original.filter(|path|path.is_file()) { fs::copy(original, &writable)?; }
    }
    Ok(writable)
}
pub fn create_file(path: impl AsRef<Path>) -> io::Result<fs::File> { fs::File::create(write_path(path, false)?) }
pub fn open_file(path: impl AsRef<Path>) -> io::Result<fs::File> { fs::File::open(read_path(path)) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_reads_and_private_writes_preserve_creator_files() {
        let root = std::env::temp_dir().join(format!("opengmk-paths-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let original = root.join("original");
        let writable = root.join("writable");
        fs::create_dir_all(&original).unwrap(); fs::create_dir_all(&writable).unwrap();
        let original = original.canonicalize().unwrap();
        let writable = writable.canonicalize().unwrap();
        fs::write(original.join("settings.cfg"), b"creator settings").unwrap();
        let old = std::env::current_dir().unwrap();
        configure(&original, &writable).unwrap(); std::env::set_current_dir(&writable).unwrap();
        assert_eq!(fs::read(read_path("settings.cfg")).unwrap(), b"creator settings");
        let append = write_path("settings.cfg", true).unwrap();
        assert_eq!(fs::read(&append).unwrap(), b"creator settings");
        fs::write(&append, b"player settings").unwrap();
        assert_eq!(fs::read(read_path("settings.cfg")).unwrap(), b"player settings");
        assert_eq!(fs::read(original.join("settings.cfg")).unwrap(), b"creator settings");
        let absolute = write_path(original.join("new-save.dat"), false).unwrap();
        assert_eq!(absolute, writable.join("new-save.dat"));
        fs::write(absolute, b"save").unwrap(); assert!(!original.join("new-save.dat").exists());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&original, writable.join("alias")).unwrap();
            let target = write_path(writable.join("alias/settings.cfg"), false).unwrap();
            assert_eq!(target, writable.join("settings.cfg"));
        }
        std::env::set_current_dir(old).unwrap(); fs::remove_dir_all(root).unwrap();
    }
}
