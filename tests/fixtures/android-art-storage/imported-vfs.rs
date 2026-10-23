use std::collections::HashSet;
use std::io;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock, RwLock};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy, PartialEq)]
enum Area { Image, Writable, Kernfs }
struct Mount { host: PathBuf, area: Area, hidden: bool }
struct Vfs { mapped: bool, root: PathBuf, mounts: RwLock<Vec<Mount>> }
static VFS: OnceLock<Vfs> = OnceLock::new();
static CANONICAL_CALLS: AtomicUsize = AtomicUsize::new(0);
static DECLARATION_READS: AtomicUsize = AtomicUsize::new(0);
static HIDDEN_CHECKS: AtomicUsize = AtomicUsize::new(0);
static DECLARATION_ERRORS: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);
fn hidden(_: &[Mount], mount: &Mount) -> bool {
    HIDDEN_CHECKS.fetch_add(1, Ordering::SeqCst);
    mount.hidden
}
fn strip_host_prefix<'a>(path: &'a Path, prefix: &Path) -> Option<&'a Path> { path.strip_prefix(prefix).ok() }

// Preserve the VFS owner's cache rule, counting actual filesystem resolutions.
fn canonical_host(path: &Path) -> Option<PathBuf> {
    static CANONICAL: LazyLock<Mutex<HashSet<std::ffi::OsString>>> = LazyLock::new(Default::default);
    if CANONICAL.lock().unwrap().contains(path.as_os_str()) { return Some(path.to_path_buf()); }
    CANONICAL_CALLS.fetch_add(1, Ordering::SeqCst);
    let canonical = std::fs::canonicalize(path).ok()?;
    if canonical == path { CANONICAL.lock().unwrap().insert(canonical.clone().into_os_string()); }
    Some(canonical)
}

// Only the declaration boundary is substituted. The existing native storage
// integration verifies its actual xattr codec and guest ownership behavior.
mod aim_storage {
    pub mod imported_inodes {
        pub fn code_tree(path: &std::path::Path) -> std::io::Result<bool> {
            crate::DECLARATION_READS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if crate::DECLARATION_ERRORS.lock().unwrap().contains(path) {
                return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
            }
            match std::fs::symlink_metadata(path) {
                Ok(value) if value.file_type().is_symlink() => Ok(false),
                Ok(_) => Ok(path.join(".declared-code").is_file()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error),
            }
        }
    }
}
include!("../../../src/modules/android/art/native/imported-vfs.rs");

fn mount(path: &Path, area: Area) -> Mount { Mount { host: path.to_path_buf(), area, hidden: false } }
fn directory(path: &Path, declared: bool) {
    std::fs::create_dir_all(path).unwrap();
    if declared { std::fs::write(path.join(".declared-code"), b"code").unwrap(); }
}
fn check(label: &str, mounts: Vec<Mount>, host: &Path, expected: Option<&Path>, resolutions: usize, declarations: usize, visibility: usize) {
    *VFS.get().unwrap().mounts.write().unwrap() = mounts;
    CANONICAL_CALLS.store(0, Ordering::SeqCst);
    DECLARATION_READS.store(0, Ordering::SeqCst);
    HIDDEN_CHECKS.store(0, Ordering::SeqCst);
    assert_eq!(imported_root(host).as_deref(), expected, "{label}: imported root");
    assert_eq!(CANONICAL_CALLS.load(Ordering::SeqCst), resolutions, "{label}: actual canonicalizations");
    assert_eq!(DECLARATION_READS.load(Ordering::SeqCst), declarations, "{label}: declaration reads");
    assert_eq!(HIDDEN_CHECKS.load(Ordering::SeqCst), visibility, "{label}: matching-candidate visibility checks");
    println!("PASS {label}");
}

fn main() -> io::Result<()> {
    let root = PathBuf::from(std::env::args_os().nth(1).expect("temporary root"));
    VFS.set(Vfs { mapped: true, root: root.clone(), mounts: RwLock::new(Vec::new()) }).ok().unwrap();

    let image: Vec<_> = (0..128).map(|index| {
        let path = root.join(format!("image-{index}")); directory(&path, index >= 64);
        assert_eq!(canonical_host(&path).as_deref(), Some(path.as_path()));
        mount(&path, Area::Image)
    }).collect();
    check("64 ordinary and 64 declared warmed image roots avoid canonicalization, declarations and visibility scans for a foreign inode", image, &root.join("foreign/inode"), None, 0, 0, 0);

    let actual = root.join("ancestor-target/code"); directory(&actual, true);
    let ancestor = root.join("ancestor-alias"); symlink(root.join("ancestor-target"), &ancestor)?;
    check("declared code through an ancestor alias", vec![mount(&ancestor.join("code"), Area::Image)], &actual.join("file"), Some(&actual), 1, 1, 1);

    let final_target = root.join("final-target"); directory(&final_target, true);
    let final_alias = root.join("final-alias"); symlink(&final_target, &final_alias)?;
    check("declared code through a final symlink", vec![mount(&final_alias, Area::Image)], &final_target.join("file"), Some(&final_target), 1, 1, 1);

    let writable = root.join("writable-target"); directory(&writable, false);
    let writable_alias = root.join("writable-alias"); symlink(&writable, &writable_alias)?;
    check("writable alias needs no code declaration", vec![mount(&writable_alias, Area::Writable)], &writable.join("file"), Some(&writable), 1, 0, 1);

    let first = root.join("retarget-first"); let second = root.join("retarget-second");
    directory(&first, true); directory(&second, true);
    let changing = root.join("changing-alias"); symlink(&first, &changing)?;
    check("symlink initially targets first code root", vec![mount(&changing, Area::Image)], &first.join("file"), Some(&first), 1, 1, 1);
    std::fs::remove_file(&changing)?; symlink(&second, &changing)?;
    check("host symlink retarget is observed", vec![mount(&changing, Area::Image)], &second.join("file"), Some(&second), 1, 1, 1);
    check("retarget does not retain the previous root", vec![mount(&changing, Area::Image)], &first.join("file"), None, 1, 0, 0);

    let mut hidden_alias = mount(&final_alias, Area::Image); hidden_alias.hidden = true;
    let mut hidden_direct = mount(&final_target, Area::Writable); hidden_direct.hidden = true;
    canonical_host(&final_target).unwrap();
    check("hidden mounts never supply imported defaults", vec![hidden_alias, hidden_direct, mount(&root, Area::Kernfs)], &final_target.join("file"), None, 1, 0, 3);

    // A missing mount retains the original canonical fallback attempt without
    // reading unrelated metadata or qualifying a missing code declaration.
    check("metadata errors retain canonical fallback", vec![mount(&root.join("missing"), Area::Image)], &root.join("foreign/file"), None, 1, 0, 0);
    DECLARATION_ERRORS.lock().unwrap().insert(ancestor.join("code"));
    check("declaration errors retain a successful canonical fallback", vec![mount(&ancestor.join("code"), Area::Image)], &actual.join("file"), Some(&actual), 1, 1, 1);
    let unreadable = root.join("declaration-error"); directory(&unreadable, true);
    DECLARATION_ERRORS.lock().unwrap().insert(unreadable.clone());
    check("matching declaration errors do not grant imported defaults", vec![mount(&unreadable, Area::Image)], &unreadable.join("file"), None, 1, 2, 2);
    Ok(())
}
