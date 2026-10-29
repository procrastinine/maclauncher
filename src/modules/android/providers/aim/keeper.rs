//! Owned process and package controller around the original AIM runtime.
//! It runs entirely inside the launcher's inherited per-game OS sandbox.
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::os::unix::process::CommandExt;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::{Duration, Instant};

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) { STOP.store(true, Ordering::Relaxed); }

fn string(value: &Value, key: &str) -> Result<String, String> {
    value[key].as_str().map(str::to_owned).ok_or_else(|| "The Android launch configuration is invalid.".into())
}
fn absolute(value: &Value, key: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(string(value, key)?);
    if !path.is_absolute() { return Err("The Android launch path is invalid.".into()); }
    Ok(path)
}
fn read_output(mut pipe: impl Read, exceeded: Arc<AtomicBool>) -> Vec<u8> {
    let mut output = Vec::new();
    if pipe.by_ref().take(4 * 1024 * 1024 + 1).read_to_end(&mut output).is_err() || output.len() > 4 * 1024 * 1024 {
        exceeded.store(true, Ordering::Relaxed);
        output.truncate(4 * 1024 * 1024);
    }
    output
}
fn command_output(program: &Path, args: &[String], timeout: Duration) -> Result<(String, String), String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Each bounded control call owns its group, including its linux-run child.
    unsafe { command.pre_exec(|| if libc::setpgid(0, 0) == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }); }
    let mut child = command.spawn().map_err(|e| format!("Android command could not start: {e}"))?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let flag = exceeded.clone(); let out = thread::spawn(move || read_output(out, flag));
    let flag = exceeded.clone(); let err = thread::spawn(move || read_output(err, flag));
    let deadline = Instant::now() + timeout;
    let mut failure = None;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if STOP.load(Ordering::Relaxed) || Instant::now() >= deadline || exceeded.load(Ordering::Relaxed) {
            failure = Some(if exceeded.load(Ordering::Relaxed) { "Android command output exceeded its limit." }
                else if STOP.load(Ordering::Relaxed) { "Android startup was canceled." } else { "Android command timed out." });
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            break child.wait().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(25));
    };
    // Successful calls must not leave descendants holding inherited pipes.
    unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
    let out = out.join().map_err(|_| "Android output reader stopped.")?;
    let err = err.join().map_err(|_| "Android output reader stopped.")?;
    if let Some(failure) = failure { return Err(failure.into()); }
    if !status.success() {
        let error = [String::from_utf8_lossy(&err).trim(), String::from_utf8_lossy(&out).trim()]
            .into_iter().filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n");
        return Err(if error.is_empty() { format!("Android command failed ({status}).") } else { error });
    }
    Ok((String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned()))
}
fn command(program: &Path, args: &[String], timeout: Duration) -> Result<String, String> {
    command_output(program, args, timeout).map(|(out, _)| out)
}
fn exec_output(ctl: &Path, data: &Path, args: &[&str], timeout: Duration) -> Result<(String, String), String> {
    command_output(ctl, &[vec!["--data".into(), data.to_string_lossy().into(), "exec".into()], args.iter().map(|s| s.to_string()).collect()].concat(), timeout)
        .map_err(|error| format!("Android {}: {error}", args.first().and_then(|value| Path::new(value).file_name()).and_then(|value| value.to_str()).unwrap_or("command")))
}
fn exec(ctl: &Path, data: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    exec_output(ctl, data, args, timeout).map(|(out, _)| out)
}
fn activity_result(output: &str) -> Result<(), String> {
    // ActivityManager's shell command can exit successfully after a timed-out
    // startActivityAndWait. Only its original WaitResult confirms the launch.
    if output.lines().any(|line| line.trim_start().starts_with("Error:")) {
        return Err(format!("Android am: {}", output.trim()));
    }
    match output.lines().find_map(|line| line.trim().strip_prefix("Status:").map(str::trim)) {
        // Cleanup of a failed activity also clears timeout, but reports
        // INVALID_DELAY. The original shell omits TotalTime in that case.
        // Already-visible activities retain their valid zero launch time.
        Some("ok") if output.lines().find_map(|line| line.trim().strip_prefix("TotalTime:"))
            .is_some_and(|time| time.trim().parse::<i64>().is_ok_and(|time| time >= 0)) => Ok(()),
        Some(_) => Err(format!("Android activity did not finish starting.\nAndroid am: {}", output.trim())),
        None => Err(format!("Android did not report an activity launch result.\nAndroid am: {}", output.trim())),
    }
}
fn startup_timeout(deadline: Instant, maximum: Duration) -> Result<Duration, String> {
    deadline.checked_duration_since(Instant::now()).filter(|remaining| !remaining.is_zero())
        .map(|remaining| remaining.min(maximum))
        .ok_or_else(|| "Android did not finish starting within five minutes.".into())
}
#[derive(Clone, Copy, PartialEq)]
enum LaunchMode { AndroidServices, AppHost }
fn launch_mode(config: &Value) -> Result<LaunchMode, String> {
    match config.get("launchMode").and_then(Value::as_str) {
        None if config.get("launchMode").is_none() => Ok(LaunchMode::AndroidServices),
        Some("android-services") => Ok(LaunchMode::AndroidServices),
        Some("app-host") => Ok(LaunchMode::AppHost),
        _ => Err("The Android launch mode is invalid.".into()),
    }
}
fn wait_for_ready(ctl: &Path, data: &Path, child: &mut Child, mode: LaunchMode, deadline: Instant) -> Result<(), String> {
    let (property, ready) = match mode {
        LaunchMode::AndroidServices => ("sys.boot_completed", "1"),
        LaunchMode::AppHost => ("init.svc.aim-app-host-agent", "running"),
    };
    loop {
        if STOP.load(Ordering::Relaxed) { return Ok(()); }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("Android stopped before startup completed.".into()); }
        if exec(ctl, data, &["/system/bin/getprop", property], startup_timeout(deadline, Duration::from_secs(10))?).is_ok_and(|s| s.trim() == ready) {
            if mode == LaunchMode::AndroidServices || exec(ctl, data, &["/system/bin/service", "check", "aim.app_host"], startup_timeout(deadline, Duration::from_secs(10))?)
                .is_ok_and(|s| s.lines().any(|line| line.trim() == "Service aim.app_host: found")) { return Ok(()); }
        }
        thread::sleep(startup_timeout(deadline, Duration::from_millis(500))?);
    }
}
fn wait_for_user(ctl: &Path, data: &Path, child: &mut Child, deadline: Instant) -> Result<(), String> {
    let mut requested = false;
    loop {
        if STOP.load(Ordering::Relaxed) { return Ok(()); }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("Android stopped before user 0 was unlocked.".into()); }
        let (state, error) = exec_output(ctl, data, &["/system/bin/am", "get-started-user-state", "0"], startup_timeout(deadline, Duration::from_secs(10))?)?;
        if !error.trim().is_empty() { return Err(format!("Android am: {}", error.trim())); }
        match state.trim() {
            "RUNNING_UNLOCKED" => return Ok(()),
            "RUNNING_LOCKED" if !requested => {
                // Original Android unlock-user supports no credential arguments. It
                // can report failure on stderr even with a successful exit status.
                let (out, error) = exec_output(ctl, data, &["/system/bin/am", "unlock-user", "0"], startup_timeout(deadline, Duration::from_secs(30))?)?;
                if !error.trim().is_empty() || !out.lines().any(|line| line.trim() == "Success: user unlocked") {
                    // Android also returns this zero-exit refusal if another caller
                    // has already advanced the user beyond RUNNING_LOCKED.
                    let state = if out.trim().is_empty() && error.trim() == "Error: could not unlock user" {
                        let (state, error) = exec_output(ctl, data, &["/system/bin/am", "get-started-user-state", "0"], startup_timeout(deadline, Duration::from_secs(10))?)?;
                        if !error.trim().is_empty() { return Err(format!("Android am: {}", error.trim())); }
                        Some(state)
                    } else { None };
                    match state.as_deref().map(str::trim) {
                        Some("RUNNING_UNLOCKED") => return Ok(()),
                        Some("RUNNING_UNLOCKING") => {},
                        _ => {
                            let detail = [error.trim(), out.trim()].into_iter().filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n");
                            let state = state.map(|state| format!("\nAndroid user 0 state: {}", state.trim())).unwrap_or_default();
                            return Err(format!("Android user 0 could not be unlocked. If a PIN, pattern or password is configured, unlock the Android user before starting the game.{state}\nAndroid am: {}", if detail.is_empty() { "No unlock result was returned." } else { &detail }));
                        }
                    }
                }
                requested = true;
            }
            "BOOTING" | "RUNNING_LOCKED" | "RUNNING_UNLOCKING" => {},
            _ => return Err(format!("Android user 0 is unavailable: {}", state.trim())),
        }
        thread::sleep(startup_timeout(deadline, Duration::from_millis(500))?);
    }
}
fn install(ctl: &Path, data: &Path, files: &[PathBuf]) -> Result<(), String> {
    let temporary = data.join("data/local/tmp");
    fs::create_dir_all(&temporary).map_err(|e| e.to_string())?;
    let mut copies = Vec::new(); let mut session = None;
    let operation: Result<(), String> = (|| {
        for (index, file) in files.iter().enumerate() {
            let copy = temporary.join(format!("maclauncher-{}-{index}.apk", std::process::id()));
            fs::copy(file, &copy).map_err(|e| e.to_string())?;
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&copy, fs::Permissions::from_mode(0o644)).map_err(|e| e.to_string())?;
            copies.push(copy);
        }
        let created = exec(ctl, data, &["/system/bin/pm", "install-create", "-r"], Duration::from_secs(600))?;
        let id = created.split_once('[').and_then(|(_, rest)| rest.split_once(']')).map(|(id, _)| id.to_string())
            .filter(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit())).ok_or("Android did not create an installation session.")?;
        session = Some(id.clone());
        for (index, copy) in copies.iter().enumerate() {
            let size = fs::metadata(copy).map_err(|e| e.to_string())?.len().to_string();
            let name = if index == 0 { "base.apk".into() } else { format!("split_{index}.apk") };
            let guest = format!("/data/local/tmp/{}", copy.file_name().unwrap().to_string_lossy());
            let result = exec(ctl, data, &["/system/bin/pm", "install-write", "-S", &size, &id, &name, &guest], Duration::from_secs(600))?;
            if !result.lines().any(|line| line.starts_with("Success")) { return Err("Android could not prepare the package installation.".into()); }
        }
        let result = exec(ctl, data, &["/system/bin/pm", "install-commit", &id], Duration::from_secs(600))?;
        if !result.lines().any(|line| line.starts_with("Success")) { return Err(format!("Android could not install the package: {}", result.trim())); }
        session = None; Ok(())
    })();
    if let Some(session) = session { let _ = exec(ctl, data, &["/system/bin/pm", "install-abandon", &session], Duration::from_secs(10)); }
    for copy in copies { let _ = fs::remove_file(copy); }
    operation
}
fn shutdown(child: &mut Child) -> Result<ExitStatus, String> {
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Ok(status); }
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
    // AIM permits 240s for guest, display, worker and DATA cleanup, then
    // 10s for forced retirement. Preserve that complete budget and delivery.
    let deadline = Instant::now() + Duration::from_secs(260);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Ok(status); }
        if Instant::now() >= deadline { let _ = child.kill(); return child.wait().map_err(|e| e.to_string()); }
        thread::sleep(Duration::from_millis(50));
    }
}
fn stop_resident(child: &mut Option<Child>) -> Result<(), String> {
    if let Some(mut current) = child.take() {
        let status = shutdown(&mut current)?;
        if !status.success() { return Err(format!("Android shutdown failed ({status}).")); }
    }
    Ok(())
}
fn wait_for_app_host_user(ctl: &Path, data: &Path, child: &mut Child, transaction: u32, deadline: Instant) -> Result<(), String> {
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("Android stopped before its user was ready.".into()); }
        let output=exec(ctl, data, &["/system/bin/service", "call", "user", &transaction.to_string(), "i32", "0"], startup_timeout(deadline, Duration::from_secs(10))?)?;
        match binder_result_words(&output).as_slice() {
            [0, 1] => return Ok(()),
            [0, 0] => {},
            _ => return Err(format!("AIM user state: {}", output.trim())),
        }
        thread::sleep(startup_timeout(deadline, Duration::from_millis(500))?);
    }
}
fn start_resident(child: &mut Option<Child>, ctl: &Path, data: &Path, runtime: &Path, userdata: &Path, image: &Path, mode: LaunchMode, user_unlock_transaction: Option<u32>) -> Result<(), String> {
    if child.is_some() { return Err("Android is already running for this game.".into()); }
    *child = Some(Command::new(ctl).arg("--data").arg(data).arg("run").arg("--image").arg(image)
        .arg("--host-runtime").arg(runtime.join("bin")).arg("--userdata").arg(userdata)
        .stdin(Stdio::null()).spawn().map_err(|e| format!("Android could not start: {e}"))?);
    let deadline = Instant::now() + Duration::from_secs(300);
    wait_for_ready(ctl, data, child.as_mut().unwrap(), mode, deadline)?;
    if mode == LaunchMode::AndroidServices { wait_for_user(ctl, data, child.as_mut().unwrap(), deadline)?; }
    else if let Some(transaction)=user_unlock_transaction { wait_for_app_host_user(ctl, data, child.as_mut().unwrap(), transaction, deadline)?; }
    Ok(())
}
fn installation_matches(record: &Path, key: &str, package: &str) -> bool {
    fs::read(record).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).is_some_and(|value|
        value["key"].as_str() == Some(key) && value.get("packageName").is_none_or(|name| name.as_str() == Some(package)))
}
fn package_installed(ctl: &Path, data: &Path, package: &str, mode: LaunchMode) -> Result<bool, String> {
    if mode == LaunchMode::AppHost {
        // The app host implements its own package shell. The supplier's
        // launcher list reads the actual enabled user-0 launcher entries.
        return command(ctl, &["--data".into(), data.to_string_lossy().into(), "apps".into()], Duration::from_secs(120))
            .map(|output| output.lines().any(|line| line.split_whitespace().next() == Some(package)))
            .map_err(|error| format!("AIM application list: {error}"));
    }
    Ok(exec(ctl, data, &["/system/bin/pm", "path", package], Duration::from_secs(120))
        .is_ok_and(|output| output.lines().any(|line| line.strip_prefix("package:").is_some_and(|path| !path.trim().is_empty()))))
}
fn binder_result_words(output: &str) -> Vec<u32> {
    let parcel = output.split_once("Result: Parcel(").and_then(|(_, rest)| rest.split_once(')').map(|(body, _)| body));
    parcel.into_iter().flat_map(|body| body.lines()).flat_map(|line| {
        let line = line.trim();
        let values = if line.starts_with("0x") { line.split_once(':').map_or(line, |(_, values)| values) } else { line };
        values.split_whitespace().take_while(|word| word.len() == 8 && word.bytes().all(|byte| byte.is_ascii_hexdigit()))
    }).take(2).filter_map(|word| u32::from_str_radix(word, 16).ok()).collect()
}
fn app_host_result(output: &str) -> Result<(), String> {
    // The original startActivity control reply is no-exception plus the
    // started process PID. The service shell may exit zero for an exception.
    let words=binder_result_words(output);
    if matches!(words.as_slice(), [0, pid] if *pid > 0 && *pid <= i32::MAX as u32) { return Ok(()); }
    Err(format!("Android could not start the activity.\n{}", output.trim()))
}
fn record_installation(record: &Path, key: &str, package: &str) -> Result<(), String> {
    let temporary = record.with_extension(format!("json.tmp-{}", std::process::id()));
    let result = fs::write(&temporary, json!({"key":key,"packageName":package}).to_string())
        .and_then(|()| fs::rename(&temporary, record)).map_err(|e| e.to_string());
    let _ = fs::remove_file(temporary);
    result
}
fn run() -> Result<(), String> {
    let config = std::env::args_os().nth(1).ok_or("Android needs a launch configuration.")?;
    let config = fs::read(config).map_err(|e| e.to_string())?;
    if config.len() > 1024 * 1024 { return Err("The Android launch configuration is too large.".into()); }
    let config: Value = serde_json::from_slice(&config).map_err(|_| "The Android launch configuration is invalid.")?;
    if config["schemaVersion"].as_u64() != Some(1) { return Err("The Android launch configuration is invalid.".into()); }
    let runtime = absolute(&config, "runtime")?;
    let image = absolute(&config, if config.get("originalImage").is_some() { "originalImage" } else { "image" })?;
    let data = absolute(&config, "data")?; let root = absolute(&config, "root")?; let userdata = absolute(&config, "userdata")?;
    let package = string(&config, "packageName")?; let activity = string(&config, "activity")?; let key = string(&config, "key")?;
    let game_arguments = if let Some(value) = config.get("gameArguments") {
        let text=value.as_str().ok_or("Android launch arguments must be a JSON string array.")?;
        let arguments:Value=serde_json::from_str(text).map_err(|_|"Android launch arguments must be a JSON string array.")?;
        let arguments=arguments.as_array().ok_or("Android launch arguments must be a JSON string array.")?;
        if arguments.len()>256 || arguments.iter().any(|value|value.as_str().is_none_or(|value|value.contains('\0'))) {
            return Err("Android launch arguments must be a JSON string array.".into());
        }
        Some(text.to_owned())
    } else { None };
    let requested_mode = launch_mode(&config)?;
    // The original app-host control API accepts a component only, with no
    // Intent extras. The launcher resolves automatic mode before preparation.
    if requested_mode == LaunchMode::AppHost && game_arguments.is_some() {
        return Err("Custom launch arguments require Android services mode.".into());
    }
    let mode = requested_mode;
    let user_unlock_transaction=config.get("appHostUserUnlockTransaction").map(|value|
        value.as_u64().filter(|code| *code>0 && *code<=u32::MAX as u64).map(|code| code as u32)
            .ok_or("The Android user-state interface is invalid.")
    ).transpose()?;
    let app_host_image = if mode == LaunchMode::AppHost { Some(absolute(&config, "appHostImage")?) } else { None };
    if !package.contains('.') || !package.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_') { return Err("The Android package name is invalid.".into()); }
    let files = config["apks"].as_array().ok_or("Android packages are missing.")?.iter()
        .map(|file| file.as_str().map(PathBuf::from).filter(|p| p.is_absolute()).ok_or("The Android package path is invalid."))
        .collect::<Result<Vec<_>, _>>()?;
    if files.is_empty() || files.len() > 64 { return Err("Android needs a base package and its selected splits.".into()); }
    unsafe { for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] { libc::signal(signal, stop as *const () as libc::sighandler_t); } }
    let ctl = runtime.join("bin/aimctl");
    let mut child = None;
    let operation: Result<(), String> = (|| {
        let record = root.join("runtime/aim-installed.json");
        if mode == LaunchMode::AppHost && installation_matches(&record, &key, &package) {
            start_resident(&mut child, &ctl, &data, &runtime, &userdata, app_host_image.as_ref().unwrap(), LaunchMode::AppHost, user_unlock_transaction)?;
            if STOP.load(Ordering::Relaxed) { return Ok(()); }
            if !package_installed(&ctl, &data, &package, LaunchMode::AppHost)? { stop_resident(&mut child)?; }
        }
        if child.is_none() {
            start_resident(&mut child, &ctl, &data, &runtime, &userdata, &image, LaunchMode::AndroidServices, user_unlock_transaction)?;
            if STOP.load(Ordering::Relaxed) { return Ok(()); }
            exec(&ctl, &data, &["/system/bin/settings", "put", "secure", "location_mode", "0"], Duration::from_secs(120))?;
            if !installation_matches(&record, &key, &package) || !package_installed(&ctl, &data, &package, LaunchMode::AndroidServices)? {
                install(&ctl, &data, &files)?;
                record_installation(&record, &key, &package)?;
            }
            if mode == LaunchMode::AppHost {
                stop_resident(&mut child)?;
                if STOP.load(Ordering::Relaxed) { return Ok(()); }
                start_resident(&mut child, &ctl, &data, &runtime, &userdata, app_host_image.as_ref().unwrap(), LaunchMode::AppHost, user_unlock_transaction)?;
                if STOP.load(Ordering::Relaxed) { return Ok(()); }
                if !package_installed(&ctl, &data, &package, LaunchMode::AppHost)? {
                    return Err("The installed Android package is unavailable in app-host mode. Select Android services for this game.".into());
                }
            }
        }
        if STOP.load(Ordering::Relaxed) { return Ok(()); }
        let launched = if mode == LaunchMode::AppHost || activity.is_empty() && game_arguments.is_none() {
            let component = if mode == LaunchMode::AppHost && !activity.is_empty() { format!("{package}/{activity}") } else { package.clone() };
            command(&ctl, &["--data".into(), data.to_string_lossy().into(), "open".into(), component], Duration::from_secs(120))?
        } else {
            let mut arguments=vec!["/system/bin/am".to_owned(),"start".into(),"-W".into()];
            if activity.is_empty() { arguments.extend(["-a".into(),"android.intent.action.MAIN".into(),"-c".into(),"android.intent.category.LAUNCHER".into(),"-p".into(),package.clone()]); }
            else { arguments.extend(["-n".into(),format!("{package}/{activity}")]); }
            if let Some(value)=&game_arguments { arguments.extend(["--es".into(),"maclauncher.arguments".into(),value.clone()]); }
            let (out, error) = exec_output(&ctl,&data,&arguments.iter().map(String::as_str).collect::<Vec<_>>(),Duration::from_secs(120))?;
            let result = [out.trim(), error.trim()].into_iter().filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n");
            activity_result(&result)?;
            result
        };
        if mode == LaunchMode::AppHost { app_host_result(&launched)?; }
        if launched.lines().any(|line| line.starts_with("Error:")) { return Err(launched.trim().into()); }
        println!("Android game started."); let _ = std::io::stdout().flush();
        while !STOP.load(Ordering::Relaxed) {
            if let Some(status) = child.as_mut().unwrap().try_wait().map_err(|e| e.to_string())? {
                return if status.success() { Ok(()) } else { Err("Android stopped unexpectedly.".into()) };
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    })();
    let cleanup = stop_resident(&mut child);
    operation.and(cleanup)
}
fn main() { if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); } }
