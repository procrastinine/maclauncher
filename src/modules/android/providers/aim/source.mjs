import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import source from './source.json' with {type:'json'};

export {source};

function replace(text, before, after, name) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) {
    throw new Error(`AIM source adaptation no longer matches: ${name}`);
  }
  return text.replace(before, after);
}

function functionBody(text, signature, body, name) {
  const at = text.indexOf(signature);
  if (at < 0 || text.indexOf(signature, at + signature.length) !== -1) throw new Error(`AIM source adaptation no longer matches: ${name}`);
  const start = text.indexOf('{', at), end = findBrace(text, start);
  return text.slice(0, start + 1) + '\n' + body + '\n' + text.slice(end);
}

function findBrace(text, start) {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('AIM adaptation found an incomplete source body');
}

export function adaptResidentProcessLiveness(text) {
  return replace(text,
    '    Ok(process_info(process.host_pid)?.is_some_and(|info| info_identity(&info) == process))',
    '    Ok(process_info(process.host_pid)?.is_some_and(|info| {\n        info.pbi_status != libc::SZOMB && info_identity(&info) == process\n    }))',
    'exited worker liveness');
}

/** Publish a fully initialized display before its first draw can compile effects. */
export function adaptDisplayReadiness(text) {
  text = replace(text,
    '    // The display is black until the first frame.\n    renderer.present(None, &targets, None);\n',
    '', 'display initial draw placement');
  return replace(text,
    `    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            std::thread::spawn(move || display.serve(conn.into()));
        }
    });`,
    `    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            std::thread::spawn(move || display.serve(conn.into()));
        }
    });
    // Readiness must not wait for synchronous graphics effect compilation.
    // Serialize the initial black draw with normal presents; a frame that
    // already arrived must not be covered by a later blank draw.
    {
        let last = display.last.lock().unwrap();
        if last.is_none() {
            let targets = display.targets.lock().unwrap().clone();
            display.renderer.present(None, &targets, None);
        }
    }`, 'display readiness before initial draw');
}

/** Device windows inherit their application bundle name unless --title is explicit. */
export function adaptDisplayTitle(text) {
  return replace(text,
    '    let mut title = "Android".to_string();',
    '    let mut title = shim::info("CFBundleDisplayName").unwrap_or_else(|| "Android".to_string());',
    'display application title');
}

/** Native lock workers close through their owner, independently of guest group signals. */
export function adaptPosixHolderProcessGroup(text) {
  text = replace(text,
    '    os::fd::{AsRawFd, FromRawFd},',
    '    os::fd::{AsRawFd, FromRawFd},\n    os::unix::process::CommandExt,',
    'POSIX holder process group import');
  return replace(text,
    '        let mut child = Command::new(&config.holder)\n            .args([',
    '        let mut child = Command::new(&config.holder)\n            .process_group(0)\n            .args([',
    'controller-owned POSIX holder group');
}

/** Shared mappings use anonymous files inside the application's temporary directory. */
export function adaptPrivateSharedMemory(text) {
  text = replace(text, 'use std::ffi::CString;', 'use std::ffi::CString;\nuse std::os::unix::ffi::OsStrExt;', 'shared memory path bytes');
  const before = /CString::new\(format!\("\/aim-(asm|pm)-\{:x\}-\{:x\}", std::process::id\(\), unsafe \{\n\s*libc::arc4random\(\)\n\s*\}\)\)/g;
  const matches = [...text.matchAll(before)];
  if (matches.length !== 1) throw new Error('AIM shared memory name boundary changed');
  text = text.replace(before, (_all, family) => `CString::new(std::env::temp_dir().join(format!("aim-${family}-{:x}-{:x}", std::process::id(), unsafe {
            libc::arc4random()
        })).as_os_str().as_bytes())`);
  if (text.split('libc::shm_open(').length !== 3 || text.split('libc::shm_unlink(').length !== 2) {
    throw new Error('AIM shared memory descriptor boundary changed');
  }
  text = text.replaceAll('libc::shm_open(', 'libc::open(').replace('libc::shm_unlink(', 'libc::unlink(');
  text = replace(text, 'libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,',
    'libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,', 'exclusive private mapping writer');
  return replace(text, 'libc::O_RDONLY, 0)', 'libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0)', 'read-only private mapping descriptor');
}

/** Observe already-stopping registered workers within the existing finish
 * budget. A registry entry never establishes authority to signal its PID. */
export function adaptResidentWorkerDrain(text) {
  text = replace(text,
    '    let workers = verify_registered_workers_ended(files);',
    '    let workers = wait_registered_workers_ended(files, deadline);',
    'registered worker finish observation');
  text = replace(text,
    'fn verify_registered_workers_ended(files: &Files) -> Result<(), String> {',
    `fn registered_worker_error(worker: ProcessIdentity) -> String {
    format!(
        "registered worker still live: {}:{}:{}; not signalled without owned ancestry",
        worker.host_pid, worker.start_seconds, worker.start_microseconds
    )
}

fn verify_registered_workers_ended(files: &Files) -> Result<(), String> {
    match live_registered_workers(files)?.first() {
        Some(worker) => Err(registered_worker_error(*worker)),
        None => Ok(()),
    }
}

fn wait_registered_workers_ended(files: &Files, deadline: Instant) -> Result<(), String> {
    loop {
        let live = live_registered_workers(files)?;
        let Some(worker) = live.first() else { return Ok(()); };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err(registered_worker_error(*worker)); }
        std::thread::sleep(remaining.min(Duration::from_millis(20)));
    }
}

fn live_registered_workers(files: &Files) -> Result<Vec<ProcessIdentity>, String> {
    let mut live = Vec::new();`,
    'registered worker bounded observation');
  text = replace(text,
    `        if same_birth(recorded)? {
            return Err(format!(
                "registered worker still live: {}:{}:{}; not signalled without owned ancestry",
                pid, recorded.start_seconds, recorded.start_microseconds
            ));
        }
    }
    Ok(())
}

fn process_info`,
    `        if same_birth(recorded)? {
            live.push(recorded);
        }
    }
    Ok(live)
}

fn process_info`,
    'registered worker typed live snapshot');
  return text;
}

export function adaptFuseTransport(text) {
  text = functionBody(text, 'fn transport_directory()', `    let base = std::env::temp_dir();
    for _ in 0..16 {
        let directory = base.join(format!("af-{:016x}", id()?));
        match fs::create_dir(&directory) {
            Ok(()) => {
                if let Err(error) = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)) {
                    let _ = fs::remove_dir(&directory);
                    return Err(io_error(error));
                }
                return Ok(directory);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(error)),
        }
    }
    Err(36)`, 'private FUSE transport allocation');
  text = replace(text,
    '    let key = SessionKey(socket_path(fd, true)?);\n    let local = socket_path(fd, false)?;',
    '    let key = SessionKey(registered_transport_path(&socket_path(fd, true)?)?);\n    let local = registered_transport_path(&socket_path(fd, false)?)?;\n    if local.parent() != key.0.parent() { return Err(EBADF); }',
    'registered FUSE descriptor identity');
  text = replace(text,
    `    let result = (|| {
        let local_address = address(&local)?;
        let remote = address(&key.0)?;`,
    `    let result = aim_storage::socket_path::in_parent(key.0.parent().ok_or(EINVAL)?, |directory| {
        let use_relative = local.as_os_str().as_bytes().len() >= unsafe { std::mem::zeroed::<libc::sockaddr_un>() }.sun_path.len();
        let relative_local = if use_relative { Path::new(directory).join(local.file_name().ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))?) } else { local.clone() };
        let relative_remote = if use_relative { Path::new(directory).join(key.0.file_name().ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))?) } else { key.0.clone() };
        Ok((|| {
        let local_address = address(&relative_local)?;
        let remote = address(&relative_remote)?;`,
    'directory-relative FUSE descriptor bind and connect');
  text = replace(text, '    })();\n    if result.is_err() {',
    '    })())\n    }).map_err(io_error).and_then(|result| result);\n    if result.is_err() {',
    'FUSE socket directory lifetime');
  text = replace(text, '    let stream = UnixStream::connect(&key.0).map_err(io_error)?;',
    `    let stream = aim_storage::socket_path::in_parent(key.0.parent().ok_or(EINVAL)?, |directory| {
        let address = if key.0.as_os_str().as_encoded_bytes().len() < unsafe { std::mem::zeroed::<libc::sockaddr_un>() }.sun_path.len() { key.0.clone() } else { Path::new(directory).join(key.0.file_name().ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))?) };
        UnixStream::connect(address)
    }).map_err(io_error)?;`, 'directory-relative FUSE RPC connection');
  return text + `
// Relative kernel socket addresses retain the private allocation nonce. Resolve
// only through the boot's existing explicit registration, never the caller cwd.
fn registered_transport_path(path: &Path) -> Result<PathBuf, Errno> {
    use std::os::unix::{ffi::OsStringExt, fs::{MetadataExt, OpenOptionsExt}};
    if path.is_absolute() { return Ok(path.to_owned()); }
    let value = path.to_str().ok_or(EBADF)?;
    let mut parts = value.split('/');
    let allocation = parts.next().ok_or(EBADF)?;
    let leaf = parts.next().ok_or(EBADF)?;
    if parts.next().is_some() || allocation.len() != 19 || !allocation.starts_with("af-")
        || !allocation[3..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(EBADF);
    }
    if leaf != "c.sock" && !leaf.strip_prefix("c.d").is_some_and(|n| !n.is_empty() && n.len() <= 16 && n.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(EBADF);
    }
    let runtime = crate::vfs::runtime_dir().ok_or(EBADF)?;
    let mut record = fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(runtime.join("fuse-sessions").join(allocation)).map_err(io_error)?;
    let metadata = record.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() > 4096 || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() } { return Err(EBADF); }
    let mut bytes = Vec::new();
    record.read_to_end(&mut bytes).map_err(io_error)?;
    if bytes.len() > 4096 { return Err(EBADF); }
    let directory = PathBuf::from(std::ffi::OsString::from_vec(bytes));
    if !directory.is_absolute() || directory.file_name() != Some(std::ffi::OsStr::new(allocation)) { return Err(EBADF); }
    let metadata = fs::symlink_metadata(&directory).map_err(io_error)?;
    if !metadata.is_dir() || metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } { return Err(EBADF); }
    Ok(directory.join(leaf))
}
`;
}

export function adaptFuseBroker(text) {
  text = replace(text, '    let listener = UnixListener::bind(path).map_err(io_error)?;',
    `    let listener = aim_storage::socket_path::in_parent(path.parent().ok_or(EINVAL)?, |directory| {
        let address = if path.as_os_str().as_encoded_bytes().len() < unsafe { std::mem::zeroed::<libc::sockaddr_un>() }.sun_path.len() { path.to_owned() } else { Path::new(directory).join(path.file_name().ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))?) };
        UnixListener::bind(address)
    }).map_err(io_error)?;`, 'directory-relative FUSE broker listener');
  text = replace(text, '            let local = socket_path(stream.as_raw_fd(), true)?;',
    `            let local = socket_path(stream.as_raw_fd(), true)?;
            let directory = owner.key.0.parent().ok_or(EBADF)?;
            let leaf = local.file_name().and_then(|name| name.to_str()).ok_or(EBADF)?;
            if !leaf.strip_prefix("c.d").is_some_and(|n| !n.is_empty() && n.len() <= 16 && n.bytes().all(|b| b.is_ascii_hexdigit())) { return Err(EBADF); }
            let local = if local.is_absolute() {
                if local.parent() != Some(directory) { return Err(EBADF); }
                local
            } else {
                if local.parent() != directory.file_name().map(Path::new) { return Err(EBADF); }
                directory.join(leaf)
            };`,
    'registered FUSE peer socket cleanup');
  return replace(text, '        std::thread::sleep(Duration::from_millis(2));',
    `        // Keep the original idle/retirement interval, but accept a ready
        // request immediately instead of delaying every broker round trip.
        let mut event = libc::pollfd { fd: listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut event, 1, 2) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted { return Err(io_error(error)); }
        }`, 'readiness-driven FUSE broker admission');
}

export function adaptFuseMountBindings(text) {
  text = replace(text, `    refresh_fuse_mounts()?;
    let mut route = fuse_route(source_guest);`,
    `    refresh_fuse_mounts()?;
    // Imported mount objects must have their original peer/slave identity
    // recorded before a bind copies them. No mount-table locks span this sync.
    if let Some(id) = mount_namespace_id() { namespace_mount_points(&id)?; }
    let mut route = fuse_route(source_guest);`, 'bind source mount object identity');
  return replace(text, `            route,
            child.bind_source,
        )?;`,
    `            route,
            Some(child.guest),
        )?;`, 'recursive child bind source identity');
}

export function adaptFuseMountRecords(text) {
  return replace(text, `        if let ["bind-source", target, source] = fields.as_slice() {
            let origin = mounts
                .iter()
                .filter(|mount| {
                    mount.guest != *target
                        && (mount.guest == *source || below(&mount.guest, source))
                })`,
    `        if let ["bind-source", target, source] = fields.as_slice() {
            // A self-bind copies the previous mount object at the same path.
            // Exclude only the destination object just installed, not its peers.
            let destination = mounts.iter().rev().find(|mount| mount.guest == *target).map(|mount| mount.id);
            let origin = mounts
                .iter()
                .filter(|mount| {
                    Some(mount.id) != destination
                        && (mount.guest == *source || below(&mount.guest, source))
                })`, 'bind prior mount object identity');
}

export function adaptFuseMountRootTraversal(text) {
  return replace(text, `        if let Some(route) = fuse_route(&current) {
            let node = match crate::sys::fuse_client::lookup(&route) {`,
    `        if let Some(route) = fuse_route(&current) {
            // A FUSE mount root is already a directory (fuse_mount::parse).
            // Preserve ancestor checks and explicit stat, but do not ask the
            // daemon for root attributes merely to discover a symlink.
            if route.relative.is_empty() { continue; }
            let node = match crate::sys::fuse_client::lookup(&route) {`, 'FUSE root directory traversal');
}

export function adaptAimFsTrace(text) {
  text = replace(text, '    resolve_w_bytes(dirfd, &owned, follow)',
    `    let result = resolve_w_bytes(dirfd, &owned, follow);
    if let Err(error) = &result {
        aim_fs_trace(|| format!("op=resolve-w guest={:?} result={}", String::from_utf8_lossy(&owned), error));
    }
    result`, 'filesystem resolution diagnostic');
  const start = text.indexOf('pub fn mkdirat(a: [u64; 6]) -> i64 {');
  if (start < 0) throw new Error('AIM source adaptation no longer matches: mkdir diagnostic');
  const functionEnd = findBrace(text, text.indexOf('{', start));
  let functionText = text.slice(start, functionEnd + 1);
  const arm = functionText.indexOf('        Ok(r) => {');
  const open = functionText.indexOf('{', arm), close = findBrace(functionText, open);
  let body = functionText.slice(open + 1, close);
  body = replace(body, 'if let Some(route) = vfs::fuse_route(&r.guest)', 'if let Some(route) = selected_route.as_ref()', 'mkdir selected route diagnostic');
  const wrapped = `
            let selected_route = vfs::fuse_route(&r.guest);
            let result = (|| {${body}
            })();
            aim_fs_trace(|| format!("op=mkdir guest={:?} host={:?} fuse={:?} result={}", r.guest, r.host, selected_route, result));
            result
        `;
  functionText = functionText.slice(0, open + 1) + wrapped + functionText.slice(close);
  functionText = replace(functionText, '        Err(e) => e,', '        Err(e) => { aim_fs_trace(|| format!("op=mkdir phase=resolve result={e}")); e },', 'mkdir resolution result diagnostic');
  text = text.slice(0, start) + functionText + text.slice(functionEnd + 1);
  return text + `
// Explicit filesystem diagnostics preserve native errno and stay bounded.
static AIM_FS_TRACE_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
pub(super) fn aim_fs_trace_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    static PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let saved = unsafe { *libc::__error() };
    let enabled = *ENABLED.get_or_init(|| std::env::var_os("MACLAUNCHER_AIM_FS_TRACE").is_some_and(|v| v == "1"));
    if enabled {
        let pid = std::process::id();
        if PID.swap(pid, std::sync::atomic::Ordering::Relaxed) != pid {
            AIM_FS_TRACE_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
            crate::diag!("[aim-fs-trace-enabled] host_pid={pid} limit=64");
        }
    }
    unsafe { *libc::__error() = saved; }
    enabled
}
pub(super) fn aim_fs_trace(message: impl FnOnce() -> String) {
    let saved = unsafe { *libc::__error() };
    if aim_fs_trace_enabled() && AIM_FS_TRACE_COUNT.fetch_update(std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed, |n| (n < 64).then_some(n + 1)).is_ok() {
        let identity = super::cred::current();
        let mut message = message();
        if message.len() > 2048 {
            let mut end = 2048;
            while !message.is_char_boundary(end) { end -= 1; }
            message.truncate(end);
            message.push_str("<truncated>");
        }
        crate::diag!("[aim-fs-trace] host_pid={} guest_pid={} euid={} egid={} fsuid={} fsgid={} groups={:?} group_count={} {}", std::process::id(), super::process::getpid(), identity.uid[1], identity.gid[1], identity.uid[3], identity.gid[3], &identity.groups[..identity.groups.len().min(16)], identity.groups.len(), message);
    }
    unsafe { *libc::__error() = saved; }
}
`;
}

export function adaptAimFuseTrace(text) {
  text = replace(text, 'fn request(route: &FuseRoute, opcode: u32, node: u64, data: &[u8]) -> Result<Vec<u8>, Errno> {',
    'fn request(route: &FuseRoute, opcode: u32, node: u64, data: &[u8]) -> Result<Vec<u8>, Errno> {\n    super::fsops::aim_fs_trace_enabled();', 'FUSE diagnostic activation');
  text = replace(text, '        if next == 0 {\n            return Err(crate::errno::ENOENT);',
    '        if next == 0 {\n            super::fsops::aim_fs_trace(|| format!("op=fuse-lookup-negative session={:?} relative={:?} parent={} component={:?} result=-2", route.session, route.relative, node, component));\n            return Err(crate::errno::ENOENT);', 'negative FUSE entry diagnostic');
  text = replace(text, '    let reply = request(route, 3, node, &data)?;',
    '    let reply = request(route, 3, node, &data).map_err(|error| {\n        super::fsops::aim_fs_trace(|| format!("op=fuse-getattr session={:?} relative={:?} node={} result={}", route.session, route.relative, node, -(error as i64)));\n        error\n    })?;', 'FUSE getattr error diagnostic');
  return replace(text, '    if reply.len() < 104 {\n        return Err(EIO);',
    '    if reply.len() < 104 {\n        super::fsops::aim_fs_trace(|| format!("op=fuse-getattr session={:?} relative={:?} node={} reply_bytes={} result=-5", route.session, route.relative, node, reply.len()));\n        return Err(EIO);', 'FUSE getattr reply diagnostic');
}

export function adaptAimFsTraceLaunch(text) {
  return replace(text, '"MACLAUNCHER_AIM_IPC_PREFIX", "MACLAUNCHER_CLIPBOARD_SOCKET", "TMPDIR", "HOME", "CFFIXED_USER_HOME"',
    '"MACLAUNCHER_AIM_IPC_PREFIX", "MACLAUNCHER_AIM_FS_TRACE", "MACLAUNCHER_CLIPBOARD_SOCKET", "TMPDIR", "HOME", "CFFIXED_USER_HOME"', 'service filesystem diagnostic opt-in');
}

/** Export the exact Git supplier and adapt only the owned build projection. */
/** Preserve init's first exit cause before its teardown can block. */
export function adaptGuestInitExitReport(text) {
  if (text.includes('fn maclauncher_boot_stop_report(')) throw new Error('AIM source adaptation no longer matches: native init first exit already applied');
  text = replace(text, '        self.finish();\n        &self.report',
    `        if self.options.mode == RunMode::Run {
            let shutdown = self.report.shutdown.as_deref().or(self.executor.shutdown.as_deref());
            let _ = maclauncher_boot_stop_report(
                &mut std::io::stderr(), self.executor.fatal.as_deref(), shutdown,
                &self.report.log, &self.executor.log,
            );
        }
        self.finish();
        &self.report`, 'native init first exit before retirement');
  return text + `
// Emit only the stop reason and the latest typed service-exit event. Never
// include a service command, environment or arbitrary accumulated log tail.
fn maclauncher_boot_stop_report(
    output: &mut impl std::io::Write,
    fatal: Option<&str>, shutdown: Option<&str>,
    boot_log: &[String], service_log: &[String],
) -> std::io::Result<()> {
    let bounded = |text: &str| text.chars().filter(|c| !c.is_control()).take(512).collect::<String>();
    let reason = if let Some(reason) = fatal {
        format!("fatal: {}", bounded(reason))
    } else if let Some(target) = shutdown {
        format!("shutdown requested: {}", bounded(target))
    } else {
        boot_log.iter().rev().find(|line| matches!(line.as_str(),
            "step limit reached" | "timeout reached" | "stop requested"))
            .cloned().unwrap_or_else(|| "boot loop completed".into())
    };
    writeln!(output, "guest-init: stopping before service teardown: {reason}")?;
    if let Some(event) = service_log.iter().rev().find(|line| line.starts_with("Service '")) {
        writeln!(output, "guest-init: preceding service exit: {}", bounded(event))?;
    }
    output.flush()
}
`;
}

export function prepareAimSources({checkout, output}) {
  checkout = path.resolve(checkout);
  output = path.resolve(output);
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
  if (commit !== source.commit) throw new Error('AIM source revision does not match the selected runtime');
  fs.mkdirSync(output, {recursive:true});
  const archive = path.join(output, '.source.tar');
  execFileSync('git', ['-C', checkout, 'archive', '--format=tar', '-o', archive, source.commit]);
  execFileSync('/usr/bin/tar', ['-xf', archive, '-C', output]);
  fs.unlinkSync(archive);
  adaptAimSources(output);
  return output;
}

export function adaptAimSources(root) {
  function edit(file, change) {
    const target = path.join(root, file);
    fs.writeFileSync(target, change(fs.readFileSync(target, 'utf8')));
  }
  edit('crates/aim-paths/src/lib.rs', text => functionBody(text, "pub fn root() -> &'static Path", `    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| std::env::var_os("MACLAUNCHER_AIM_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/aim")))
        .as_path()`, 'runtime resource root'));
  edit('crates/aim-build/src/tools.rs', text => replace(text,
    'pub fn jdk() -> Result<PathBuf, String> {',
    'pub fn jdk() -> Result<PathBuf, String> {\n    if let Some(home) = std::env::var_os("JAVA_HOME") { return Ok(PathBuf::from(home)); }', 'JDK selection'));
  edit('tools/art-android/gen_build.py', text => replace(text,
    '        target = f"--target=aarch64-linux-android{self.args.api}"',
    '        source_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\n        maps = " ".join(shlex.quote(f"-{flag}={source_root}=/aim") for flag in ("ffile-prefix-map", "fdebug-prefix-map"))\n        target = f"--target=aarch64-linux-android{self.args.api} {maps}"', 'portable ART source paths'));
  fs.copyFileSync(new URL('./socket_path.rs', import.meta.url), path.join(root, 'crates/aim-storage/src/socket_path.rs'));
  edit('crates/aim-storage/src/lib.rs', text => text + '\npub mod socket_path;\n');
  edit('crates/aim-storage/src/verity_control.rs', text => {
    text = replace(text, '        let mut template = b"/tmp/av-XXXXXX\\0".to_vec();',
      '        let mut template = std::env::temp_dir().join("av-XXXXXX").as_os_str().as_bytes().to_vec();\n        template.push(0);', 'private verity endpoint directory');
    for (const argument of ['path', '&admission_path', '&endpoint']) {
      const before = 'std::os::unix::net::UnixListener::bind(' + argument + ')?';
      text = replace(text, before, 'crate::socket_path::in_parent(' + argument + ', |name| std::os::unix::net::UnixListener::bind(std::path::Path::new(name)))?', 'directory-relative verity socket ' + argument);
    }
    text = replace(text, '        let bytes = path.as_os_str().as_bytes();',
      '        let bytes = path.file_name().ok_or_else(|| error(libc::EINVAL))?.as_bytes();', 'directory-relative verity address');
    text = replace(text, '        if bytes.len() >= 104 {', '        if bytes.len() >= 4096 {', 'directory-relative owner locator');
    text = replace(text, "        if text.len() > 512 || !text.ends_with('\\n') {", "        if text.len() > 16384 || !text.ends_with('\\n') {", 'bounded full owner locator');
    const before = `            if unsafe {
                libc::connect(
                    fd,
                    (&address as *const libc::sockaddr_un).cast(),
                    std::mem::size_of_val(&address) as _,
                )
            } < 0
            {
                let failure = io::Error::last_os_error();
                if !matches!(
                    failure.raw_os_error(),
                    Some(libc::EINPROGRESS) | Some(libc::EAGAIN)
                ) {
                    return Err(failure);
                }
            }`;
    return replace(text, before, `            crate::socket_path::in_parent(path, |_| {
                if unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), std::mem::size_of_val(&address) as _) } < 0 {
                    let failure = io::Error::last_os_error();
                    if !matches!(failure.raw_os_error(), Some(libc::EINPROGRESS) | Some(libc::EAGAIN)) { return Err(failure); }
                }
                Ok(())
            })?;`, 'directory-relative native verity connect');
  });
  edit('crates/aim-storage/src/posix_control.rs', text => {
    const before = 'CString::new(name).map_err(|_| error(libc::EINVAL))?';
    if (text.split(before).length !== 5) throw new Error('AIM native control service boundary changed');
    text = text.replaceAll(before, 'CString::new(scoped_name(name)).map_err(|_| error(libc::EINVAL))?');
    return text + '\nfn scoped_name(name: &str) -> String {\n    let Some(suffix) = name.strip_prefix("com.aim.").or_else(|| name.strip_prefix("dev.aim.")) else { return name.into(); };\n    let Ok(prefix) = std::env::var("MACLAUNCHER_AIM_IPC_PREFIX") else { return name.into(); };\n    if !prefix.starts_with("org.maclauncher.android.aim.") || !prefix.ends_with(\'.\') || !prefix.bytes().all(|c| c.is_ascii_alphanumeric() || c == b\'.\' || c == b\'-\') { return name.into(); }\n    format!("{prefix}storage.{suffix}")\n}\n';
  });
  edit('crates/aim-storage/src/posix_broker.rs', adaptPosixHolderProcessGroup);
  edit('crates/aim-services/src/app_host/bind.rs', adaptPrivateSharedMemory);
  edit('crates/aim-services/src/package/scan_snapshot/version_page.rs', text => {
    // Keep the supplier's grouped imports intact while applying the same
    // file creation and descriptor access policy to its publication page.
    const marker = 'use std::{\n    ffi::CString,';
    text = replace(text, marker, 'use std::ffi::CString;\nuse std::{', 'publication mapping import');
    return adaptPrivateSharedMemory(text);
  });
  edit('crates/aim-binder-host/src/socket_scm.rs', text => {
    text = replace(text, '            || path.len() >= 104', '            || path.len() >= 4096', 'full private SCM endpoint locator');
    text = replace(text, '        let listener = std::os::unix::net::UnixListener::bind(directory.join("s"))?;',
      '        let listener = aim_storage::socket_path::in_parent(&directory.join("s"), |name| std::os::unix::net::UnixListener::bind(std::path::Path::new(name)))?;', 'directory-relative SCM listener');
    return text.replaceAll('UnixStream::connect(', 'aim_storage::socket_path::connect(');
  });
  for (const file of ['crates/aim-services/src/media/mod.rs', 'crates/aim-services/src/notifications/mod.rs', 'crates/aim-services/src/statusbar/mod.rs']) {
    edit(file, text => replace(text, 'UnixStream::connect(display)', 'aim_storage::socket_path::connect(display)', 'private display channel ' + file));
  }
  for (const file of ['crates/aim-services/src/app_host/tasks.rs', 'crates/aim-services/src/app_host/input_method.rs']) {
    edit(file, text => replace(text, 'UnixStream::connect(socket)', 'aim_storage::socket_path::connect(socket)', 'private app display channel ' + file));
  }
  edit('crates/aim-linux-abi/src/sys/net/socket_scm.rs', text => {
    text = replace(text, '    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };',
      '    use std::os::unix::ffi::OsStrExt;\n    let path = std::path::Path::new(std::ffi::OsStr::from_bytes(&endpoint.path));\n    let name = path.file_name().ok_or(errno::EINVAL)?.as_bytes();\n    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };', 'directory-relative SCM peer address');
    text = replace(text, 'endpoint.path.len() >= address.sun_path.len()', 'name.len() >= address.sun_path.len()', 'SCM socket name bound');
    text = replace(text, '(2 + endpoint.path.len() + 1)', '(2 + name.len() + 1)', 'SCM socket address size');
    text = replace(text, 'address.sun_path.iter_mut().zip(&endpoint.path)', 'address.sun_path.iter_mut().zip(name)', 'SCM socket name');
    text = replace(text, `    let result = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_un).cast(),
            address.sun_len as _,
        )
    };`, `    let (result, connect_error) = aim_storage::socket_path::in_parent(path, |_| {
        let result = unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), address.sun_len as _) };
        Ok((result, if result < 0 { std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO) } else { 0 }))
    }).map_err(io)?;`, 'directory-relative SCM peer connect');
    return replace(text, '    if result < 0 {\n        let error = std::io::Error::last_os_error()\n            .raw_os_error()\n            .unwrap_or(libc::EIO);',
      '    if result < 0 {\n        let error = connect_error;', 'SCM connect error preservation');
  });
  edit('crates/aim-linux-abi/src/sys/fuse.rs', adaptFuseTransport);
  edit('crates/aim-linux-abi/src/sys/fuse/broker.rs', adaptFuseBroker);
  edit('crates/aim-linux-abi/src/vfs.rs', adaptFuseMountBindings);
  edit('crates/aim-linux-abi/src/vfs.rs', adaptFuseMountRootTraversal);
  edit('crates/aim-storage/src/mount_namespace/records.rs', adaptFuseMountRecords);
  edit('crates/aim-linux-abi/src/sys/fsops.rs', adaptAimFsTrace);
  edit('crates/aim-linux-abi/src/sys/fuse_client.rs', adaptAimFuseTrace);
  edit('crates/aim-storage/src/system.rs', text => replace(text,
    '        let file = fs::OpenOptions::new()\n            .create(true)\n            .read(true)\n            .write(true)\n            .truncate(false)\n            .open(&path)\n            .map_err(|e| format!("{}: {e}", path.display()))?;',
    '        let file = if !write && path.exists() {\n            File::open(&path)\n        } else {\n            fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&path)\n        }.map_err(|e| format!("{}: {e}", path.display()))?;', 'read-only shared image lease'));
  edit('crates/aim-storage/src/data.rs', text => {
    text = replace(text, '    pub fn handoff_detach(&mut self) -> Result<(), String> {',
      '    pub fn handoff_detach(&mut self) -> Result<(), String> {\n        if std::env::var_os("MACLAUNCHER_AIM_MOUNTED_DATA").is_some() { return Ok(()); }', 'externally owned image reboot');
    return replace(text,
    '        for stale in disk::attachments_of(&image)? {',
    `        if std::env::var_os("MACLAUNCHER_AIM_MOUNTED_DATA").is_some() {
            let attached = disk::attachments_of(&image)?;
            if attached.len() != 1 || attached[0].shadow.is_some() || !attached[0].writable
                || attached[0].mounts.as_slice() != [dir.clone()] || !disk::is_mount_point(&dir) {
                return Err("launcher-owned Android data is not mounted at its private directory".into());
            }
            return Ok(Self { dir, image, device: None, _lock: lock });
        }
        for stale in disk::attachments_of(&image)? {`, 'launcher-owned private image attachment');
  });
  edit('crates/aim-host-display/src/bin/aim-display/main.rs', adaptDisplayTitle);
  edit('crates/aim-host-display/src/bin/aim-display/main.rs', adaptDisplayReadiness);
  edit('crates/aim-host-display/src/bin/aim-display/window.rs', text => replace(text,
    '    send!(app, c"activateIgnoringOtherApps:" => (), bool = true);',
    '    if std::env::var_os("MACLAUNCHER_AIM_NO_ACTIVATE").is_none() {\n        send!(app, c"activateIgnoringOtherApps:" => (), bool = true);\n    }', 'optional background display'));
  edit('crates/aimctl/src/resident.rs', text => replace(text,
    '    let mut display = Command::new(selected.program("aim-display"))',
    `    let display_program = match std::env::var_os("MACLAUNCHER_AIM_DISPLAY") {
        Some(value) => {
            let path = std::path::PathBuf::from(value);
            if !path.is_absolute() { return Err("Android display requires an absolute application path".into()); }
            path
        }
        None => selected.program("aim-display"),
    };
    let mut display = Command::new(display_program)`, 'per-game Mac application entry'));
  edit('crates/aim-services/src/clipboard.rs', text => {
    text = replace(text, 'mac_seen: pasteboard::change_count(),', 'mac_seen: 0,', 'private guest clipboard');
    const start = text.indexOf('        let count = pasteboard::change_count();', text.indexOf('fn tick(&self)'));
    const end = text.indexOf('        let due:', start);
    if (start < 0 || end < 0) throw new Error('AIM clipboard polling boundary changed');
    text = text.slice(0, start) + text.slice(end);
    const hostStart = text.indexOf('        if device_id == DEVICE_ID_DEFAULT {', text.indexOf('    fn set_primary('));
    const hostEnd = findBrace(text, text.indexOf('{', hostStart));
    text = text.slice(0, hostStart) + `        if device_id == DEVICE_ID_DEFAULT {
            if let Some(text) = clip.as_ref().and_then(|(clip, _)| clip.items.first()?.text.as_deref()) {
                crate::clipboard_bridge::copy(text);
            }
        }` + text.slice(hostEnd + 1);
    text = replace(text, 'pasteboard::text()\n                .map(|text| ClipData::host(&text, pasteboard::html().as_deref(), *timestamp))', 'None', 'explicit clipboard import');
    text = replace(text, 'pasteboard::has_text()', 'false', 'private clipboard metadata');
    text = replace(text, 'pasteboard::has_html()', 'false', 'private clipboard HTML metadata');
    text = replace(text, '                    clip = self.state.lock().unwrap().clipboards[&(user, device)]',
      '                    clip = crate::clipboard_bridge::paste().map(|text| ClipData::host(&text, None, now_millis()));\n                    if clip.is_none() { clip = self.state.lock().unwrap().clipboards[&(user, device)]', 'gesture paste');
    text = replace(text, '                        .and_then(Self::clip_of);', '                        .and_then(Self::clip_of); }', 'private clipboard fallback');
    return text;
  });
  fs.copyFileSync(new URL('./clipboard_bridge.rs', import.meta.url), path.join(root, 'crates/aim-services/src/clipboard_bridge.rs'));
  edit('crates/aim-services/src/lib.rs', text => text + '\nmod clipboard_bridge;\n');
  edit('crates/aim-services/Cargo.toml', text => replace(text, '[dependencies]', '[dependencies]\nserde_json = "1.0"', 'clipboard broker JSON'));
  fs.copyFileSync(new URL('./runtime_prepare.rs', import.meta.url), path.join(root, 'crates/aim-android-image/src/bin/prepare-runtime.rs'));
  fs.mkdirSync(path.join(root, 'crates/aimctl/src/bin'), {recursive:true});
  fs.copyFileSync(new URL('./keeper.rs', import.meta.url), path.join(root, 'crates/aimctl/src/bin/maclauncher-aim.rs'));
  edit('crates/aimctl/Cargo.toml', text => replace(text, '[dependencies]', '[dependencies]\nserde_json = "1.0"', 'native controller JSON'));
  edit('crates/aim-android-image/Cargo.toml', text => replace(text, '[dependencies]',
    '[[bin]]\nname = "android-runtime-prepare"\npath = "src/bin/prepare-runtime.rs"\n\n[dependencies]\naim-storage = { path = "../aim-storage" }\nserde_json = "1.0"', 'automatic image preparation'));
  edit('crates/aim-host-location/src/lib.rs', text => {
    text = functionBody(text, 'pub fn set_updates(on: bool)', '    let _ = on; // Location is supplied only through the launcher.', 'manual location updates');
    return functionBody(text, 'pub fn read() -> Fix', '    Fix::default()', 'absent location');
  });
  edit('crates/aim-host-health/src/lib.rs', text => functionBody(text, 'pub fn battery() -> Battery', `    Battery {
        present: 1, ac_online: 1, status: status::FULL, health: condition::GOOD,
        level_percent: 100, voltage_millivolts: 4000,
        ..Battery::default()
    }`, 'virtual battery'));
  edit('crates/aim-host-sensors/src/lib.rs', text => {
    text = functionBody(text, 'pub fn thermal_state() -> u32', '    state::NOMINAL', 'virtual thermal state');
    text = functionBody(text, 'pub fn read_thermal() -> Thermal', '    Thermal { state: state::NOMINAL, cpu_celsius: f32::NAN, battery_celsius: f32::NAN }', 'private temperatures');
    return functionBody(text, 'pub fn read_sensors() -> Readings', '    Readings::default()', 'absent host sensors');
  });
  edit('crates/aim-host-camera/src/lib.rs', text => {
    text = functionBody(text, 'pub fn has_built_in() -> bool', '    false', 'camera absence');
    text = functionBody(text, 'fn devices() -> Devices', '    Devices::default()', 'private cameras');
    return functionBody(text, 'fn open(a: &mut Open) -> i64', '    let _ = a;\n    err(errno::ENODEV)', 'camera access boundary');
  });
  edit('crates/aim-host-bluetooth/src/lib.rs', text => functionBody(text,
    'fn new_backend(generation: u64) -> Option<Box<dyn Backend>>', '    let _ = generation;\n    None', 'absent physical Bluetooth'));
  edit('crates/aim-host-audio/src/lib.rs', text => {
    text = replace(text, '        input: coreaudio::describe(true),', '        input: Device::default(),', 'private microphone');
    return replace(text, '            let shared: Arc<stream::Shared> = match stream::Shared::new(open, 0) {',
      '            if open.direction == DIRECTION_INPUT { return neg(errno::ENODEV); }\n            let shared: Arc<stream::Shared> = match stream::Shared::new(open, 0) {', 'microphone access boundary');
  });
  edit('crates/aim-uplink/src/lib.rs', text => replace(text, 'pub fn uplink() -> Option<Uplink> {',
    'pub fn uplink() -> Option<Uplink> {\n    if std::env::var("MACLAUNCHER_AIM_NETWORK").as_deref() != Ok("allow") { return None; }', 'network state policy'));
  edit('crates/aimctl/src/resident.rs', text => {
    text = adaptResidentProcessLiveness(text);
    text = adaptResidentWorkerDrain(text);
    text = replace(text, '    if state.windows {\n        children.0.push(',
      '    if state.windows && std::env::var_os("MACLAUNCHER_AIM_NO_SHIMS").is_none() {\n        children.0.push(', 'owned process tree');
    text = replace(text, '["--size", "1080x1920"]', '["--size", "2560x1600"]', 'tablet display');
    text = replace(text, '        let attached = aim_storage::disk::attachments_of(&self.image)?;',
      '        if std::env::var_os("MACLAUNCHER_AIM_MOUNTED_DATA").is_some() { return Ok(()); }\n        let attached = aim_storage::disk::attachments_of(&self.image)?;', 'launcher-owned image detach');
    return replace(text, 'fn verify_data_detached(files: &Files) -> Result<(), String> {',
      'fn verify_data_detached(files: &Files) -> Result<(), String> {\n    if std::env::var_os("MACLAUNCHER_AIM_MOUNTED_DATA").is_some() { return Ok(()); }', 'launcher image lifecycle');
  });
  edit('crates/aim-host-display/src/bin/aim-display/window.rs', text => replace(text,
    '    let (dpi_x, dpi_y) = main_display_dpi();', '    let (dpi_x, dpi_y) = (320.0, 320.0);', 'tablet density'));
  edit('crates/aim-host-display/src/bin/aim-display/window.rs', text => functionBody(text,
    'pub fn device_density(scale: f64) -> u32', '    let _ = scale;\n    320', 'virtual tablet density'));
  edit('crates/aim-guest-init/src/boot.rs', text => replace(text,
    `            for (name, value) in crate::soc::properties() {
                properties.init_set(name, &value);
            }
            if let Some(density) = aim_host_display::density::main_display() {
                properties.init_set(aim_host_display::density::PROP, &density.to_string());
            }`,
    `            properties.init_set("ro.soc.manufacturer", "Google");
            properties.init_set("ro.soc.model", "Tensor G2");
            properties.init_set(aim_host_display::density::PROP, "320");`, 'virtual tablet hardware properties'));
  edit('crates/aimctl/src/args.rs', text => {
    text = replace(text, '    Shell(Vec<String>),', '    Shell(Vec<String>),\n    Exec(Vec<String>),', 'literal guest command');
    text = replace(text, '(name == "shell" && !rest.is_empty())', '(matches!(name, "shell" | "exec") && !rest.is_empty())', 'literal guest arguments');
    return replace(text, '        "shell" => Command::Shell(rest),', '        "shell" => Command::Shell(rest),\n        "exec" if rest.is_empty() => return Err(usage_error("exec needs a guest program".into())),\n        "exec" => Command::Exec(rest),', 'literal guest command parser');
  });
  edit('crates/aimctl/src/main.rs', text => {
    text = replace(text, '        Cmd::Shell(command) => shell(&files, &command),', '        Cmd::Shell(command) => shell(&files, &command),\n        Cmd::Exec(command) => {\n            let (_, guest) = running(&files)?;\n            let argv: Vec<&str> = command.iter().map(String::as_str).collect();\n            let status = guest.command(&argv).status().map_err(|e| format!("linux-run: {e}"))?;\n            Ok(exit_code(status))\n        },', 'literal guest execution');
    return replace(text, '    if state.windows\n        && let Some(shim)', '    if state.windows\n        && std::env::var_os("MACLAUNCHER_AIM_NO_SHIMS").is_none()\n        && let Some(shim)', 'direct app launch');
  });
  edit('crates/aimctl/src/guest.rs', text => replace(text,
    '        command\n            .arg("--root")', `        for key in ["MACLAUNCHER_AIM_ROOT", "MACLAUNCHER_AIM_NETWORK", "MACLAUNCHER_CLIPBOARD_SOCKET"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        command
            .arg("--root")`, 'control process policy'));
  edit('crates/aimctl/src/guest.rs', text => {
    text = replace(text, '    pub environ: PathBuf,', '    pub environ: PathBuf,\n    pub display: PathBuf,', 'saved control display field');
    text = replace(text, '            environ: files.environ(),', '            environ: files.environ(),\n            display: files.display(),', 'saved control display selection');
    return replace(text, '            .arg("--path-map")', '            .arg("--display")\n            .arg(&self.display)\n            .arg("--path-map")', 'control input device routing');
  });
  edit('crates/aim-guest-init/src/launch.rs', text => replace(text,
    '    let c_env: Vec<CString> = env', `    let mut host_environment = env.to_vec();
    for key in ["MACLAUNCHER_AIM_ROOT", "MACLAUNCHER_AIM_NETWORK", "MACLAUNCHER_CLIPBOARD_SOCKET"] {
        if let Ok(value) = std::env::var(key) { host_environment.push((key.into(), value)); }
    }
    let c_env: Vec<CString> = host_environment`, 'service process policy'));
  edit('crates/aim-services/src/package/installer/native.rs', text => replace(text,
    '            Ok(Arc::new(move |uid, id| {', '            Ok(Arc::new(move |uid: u32, id: i32| {', 'installer closure argument types'));
  for (const file of ['crates/aimctl/src/guest.rs', 'crates/aim-guest-init/src/launch.rs'])
    edit(file, text => text.replaceAll('"MACLAUNCHER_AIM_NETWORK", "MACLAUNCHER_CLIPBOARD_SOCKET"', '"MACLAUNCHER_AIM_NETWORK", "MACLAUNCHER_AIM_IPC_PREFIX", "MACLAUNCHER_CLIPBOARD_SOCKET", "TMPDIR", "HOME", "CFFIXED_USER_HOME"'));
  edit('crates/aim-guest-init/src/launch.rs', adaptAimFsTraceLaunch);
  edit('crates/aim-guest-init/src/boot.rs', adaptGuestInitExitReport);
  edit('crates/aim-binder-host/src/mach.rs', text => {
    const before = '    let c = CString::new(name).map_err(|_| 4)?;';
    if (text.split(before).length !== 3) throw new Error('AIM Mach service boundaries changed');
    text = text.replaceAll(before, '    let c = CString::new(scoped_name(name)).map_err(|_| 4)?;');
    return text + '\nfn scoped_name(name: &str) -> String {\n    let Some(suffix) = name.strip_prefix("dev.aim.") else { return name.into(); };\n    let Ok(prefix) = std::env::var("MACLAUNCHER_AIM_IPC_PREFIX") else { return name.into(); };\n    if !prefix.starts_with("org.maclauncher.android.aim.") || !prefix.ends_with(\'.\') || !prefix.bytes().all(|c| c.is_ascii_alphanumeric() || c == b\'.\' || c == b\'-\') { return name.into(); }\n    format!("{prefix}{suffix}")\n}\n';
  });
  edit('Cargo.lock', text => {
    for (const [name, dependency] of [['aim-services', 'serde_json'], ['aim-android-image', 'aim-storage'], ['aim-android-image', 'serde_json'], ['aimctl', 'serde_json']]) {
      const expression = new RegExp('(\\[\\[package\\]\\]\\nname = "' + name + '"[\\s\\S]*?dependencies = \\[\\n)([\\s\\S]*?)(\\n\\])');
      if (!expression.test(text)) throw new Error('AIM dependency lock no longer matches: ' + name);
      text = text.replace(expression, (_all, head, rows, tail) => head + [...rows.split('\n'), ' "' + dependency + '",'].sort().join('\n') + tail);
    }
    return text;
  });
}
