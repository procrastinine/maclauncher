//! Directory-relative host socket operations keep all IPC in Application
//! Support without truncating Darwin's sockaddr_un pathname.
use std::ffi::{CString, OsStr};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

unsafe extern "C" { fn pthread_fchdir_np(fd: libc::c_int) -> libc::c_int; }

pub fn in_parent<T>(path: &Path, operation: impl FnOnce(&OsStr) -> io::Result<T>) -> io::Result<T> {
    let parent = path.parent().ok_or_else(|| io::Error::other("socket parent is absent"))?;
    let name = path.file_name().ok_or_else(|| io::Error::other("socket name is absent"))?;
    let parent = CString::new(parent.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let fd = unsafe { libc::open(parent.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    if unsafe { pthread_fchdir_np(fd) } != 0 {
        let error = io::Error::last_os_error(); unsafe { libc::close(fd); } return Err(error);
    }
    struct Guard(libc::c_int);
    impl Drop for Guard { fn drop(&mut self) { unsafe { pthread_fchdir_np(-1); libc::close(self.0); } } }
    let _guard = Guard(fd);
    operation(name)
}

pub fn connect(path: &Path) -> io::Result<std::os::unix::net::UnixStream> {
    in_parent(path, |name| std::os::unix::net::UnixStream::connect(Path::new(name)))
}
