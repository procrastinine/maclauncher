//! Prepare a user-acquired Android image with the included AIM adaptation.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use aim_android_image::{assemble, identity, load, validate, Entry, Kind, Manifest};
use aim_storage::system;
use aim_storage::{data, disk};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt};
use std::time::Duration;

fn prepare_data(dir: &Path) -> Result<(), String> {
    validate_data(dir)?;
    let mut image = data::DataImage::attach(dir, None)?;
    image.handoff_detach()?;
    Ok(())
}
fn detach_data(dir: &Path) -> Result<(), String> {
    validate_data(dir)?;
    let dir = data::mount_point(dir)?;
    let image = data::image_of(&dir);
    if !image.exists() { return Ok(()); }
    if !fs::symlink_metadata(&image).map_err(|e| e.to_string())?.is_file() {
        return Err("Android data backing is not a regular file".into());
    }
    let lock = dir.with_file_name(format!("{}.lock", dir.file_name().unwrap().to_string_lossy()));
    let lock = fs::OpenOptions::new().read(true).write(true).open(lock).map_err(|e| e.to_string())?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Android data is still in use".into());
    }
    for attachment in disk::attachments_of(&image)? {
        if attachment.shadow.is_some() || !attachment.writable || attachment.mounts.iter().any(|mount| mount != &dir) {
            return Err("Android data attachment differs from its private directory".into());
        }
        disk::detach(&attachment.device, Duration::from_secs(20))?;
    }
    Ok(())
}
fn validate_data(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() { return Err("Android private data needs an absolute path".into()); }
    for (path, directory) in [(dir.to_path_buf(), true), (data::image_of(dir), false)] {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() || if directory { !meta.is_dir() } else { !meta.is_file() } =>
                return Err("Android private data cannot use an alias or a special file".into()),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
            _ => {}
        }
    }
    Ok(())
}

// Keep the image's Android release and fingerprint. Only the virtual product
// profile changes; it carries no host serial number or hardware identity.
fn tablet_profile(original: &Path, output: &Path) -> Result<aim_android_image::plan::Plan, String> {
    let profile = output.join("profile");
    let mut entries = Vec::new();
    for file in ["system/build.prop", "system_ext/etc/build.prop", "product/etc/build.prop", "vendor/build.prop", "odm/etc/build.prop"] {
        let source = original.join(file);
        if !source.is_file() { continue; }
        let text = fs::read_to_string(source).map_err(|e| e.to_string())?;
        let text = text.lines().map(|line| {
            let Some((key, _)) = line.split_once('=') else { return line.to_string(); };
            if !key.starts_with("ro.product.") { return line.to_string(); }
            let value = match key.rsplit('.').next().unwrap_or("") {
                "model" => "Pixel Tablet", "manufacturer" => "Google", "brand" => "google",
                "device" | "name" => "tangorpro", _ => return line.to_string(),
            };
            format!("{key}={value}")
        }).collect::<Vec<_>>().join("\n") + "\n";
        let destination = profile.join(file);
        fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(destination, text).map_err(|e| e.to_string())?;
        entries.push(Entry { kind: Kind::Replace, path: format!("/{file}"), source: Some(file.into()),
            reason: Some("virtual Pixel Tablet product profile without host identity".into()), line: 0 });
    }
    validate(&Manifest { entries, includes: Vec::new() }, original, &profile)
        .map_err(|p| p.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))
}

const ORIGINAL: &str = "182f51ad2b04bbb9cd9464d3e0396a81201db6d9659e1fde5951b6efc1e0a00e";

fn execute(command: &mut Command) -> Result<(), String> {
    let program = command.get_program().to_string_lossy().into_owned();
    // Only the preparation result belongs on stdout. Upstream extraction and
    // translation progress stays on the caller's existing diagnostic stream.
    let error_output = unsafe { libc::dup(libc::STDERR_FILENO) };
    if error_output < 0 { return Err(std::io::Error::last_os_error().to_string()); }
    command.stdout(unsafe { fs::File::from_raw_fd(error_output) });
    let status = command.status().map_err(|e| format!("{program}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("{program}: {status}")) }
}

fn prepare(archive: &Path, payload: &Path, output: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(output).map_err(|e| e.to_string())?;
    let image = output.join("system.dmg");
    let original_mount = output.join("system");
    let derived_mount = output.join("derived");
    let shadow = output.join("derived.shadow");
    // Every game shares immutable prepared files. An already attached matching
    // image needs a shared lease, so another game's running lease is preserved.
    if image.exists() && system::root(&original_mount).is_dir() && system::root(&derived_mount).join(".identity").is_file() {
        let _reader = system::ImageLease::read(&image)?;
        let original = system::root(&original_mount);
        let (_, mut plan) = load(&payload.join("image/overlay.toml"), &original, payload)
            .map_err(|p| p.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))?;
        plan.steps.extend(tablet_profile(&original, output)?.steps);
        plan.steps.sort_by(|a, b| a.path.cmp(&b.path));
        let wanted = identity::compute(ORIGINAL, &plan);
        if identity::read_tree_identity(&system::root(&derived_mount))?.as_deref() == Some(wanted.hex.as_str()) {
            return Ok(system::root(&derived_mount));
        }
    }
    let _lease = system::ImageLease::write(&image)?;
    if !image.exists() {
        system::build(&image, "Android System", |mount| {
            execute(Command::new(payload.join("bin/android-image-extract"))
                .arg(archive).arg(system::root(mount)))?;
            let got = identity::original_identity(&system::root(mount), None)?;
            if got.as_deref() != Some(ORIGINAL) { return Err("Android system image identity differs from the selected version".into()); }
            execute(Command::new(payload.join("bin/linux-translate")).arg("--image").arg(mount))
        })?;
    }
    system::attach(&image, None, &original_mount, false)?;
    let original = system::root(&original_mount);
    if identity::original_identity(&original, None)?.as_deref() != Some(ORIGINAL) {
        return Err("Android system image identity differs from the selected version".into());
    }
    let (_, mut plan) = load(&payload.join("image/overlay.toml"), &original, payload)
        .map_err(|p| p.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))?;
    plan.steps.extend(tablet_profile(&original, output)?.steps);
    plan.steps.sort_by(|a, b| a.path.cmp(&b.path));
    let derived = identity::compute(ORIGINAL, &plan);
    if shadow.exists() {
        system::attach(&image, Some(&shadow), &derived_mount, false)?;
        if identity::read_tree_identity(&system::root(&derived_mount))?.as_deref() == Some(derived.hex.as_str()) {
            return Ok(system::root(&derived_mount));
        }
        system::detach(&image, Some(&shadow))?;
        fs::remove_file(&shadow).map_err(|e| e.to_string())?;
    }
    system::attach(&image, Some(&shadow), &derived_mount, true)?;
    let result = assemble::apply(&plan, &derived, &system::root(&derived_mount));
    system::detach(&image, Some(&shadow))?;
    result?;
    system::attach(&image, Some(&shadow), &derived_mount, true)?;
    let translated = execute(Command::new(payload.join("bin/linux-translate"))
        .arg("--image").arg(&derived_mount));
    system::detach(&image, Some(&shadow))?;
    translated?;
    system::attach(&image, Some(&shadow), &derived_mount, false)?;
    Ok(system::root(&derived_mount))
}

struct AppHostPlan { plan: aim_android_image::plan::Plan, inputs: PathBuf }
impl Drop for AppHostPlan {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.inputs); }
}

// The same changes as tools/app-host-image.sh. Sources remain the complete
// upstream agent, AppSearch bootstrap, init declarations and service selection.
fn app_host_plan(original: &Path, payload: &Path, output: &Path) -> Result<AppHostPlan, String> {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let inputs = output.join(format!(".app-host-inputs-{}-{nonce}", std::process::id()));
    fs::create_dir(&inputs).map_err(|e| e.to_string())?;
    let mut prepared = AppHostPlan { plan: aim_android_image::plan::Plan { steps: Vec::new() }, inputs };
    let mut entries = Vec::new();
    for (guest, source) in [
        ("system_ext/bin/aim-app-host-agent", "target/aim/daemons/bin/aim-app-host-agent"),
        ("system_ext/etc/init/aim-app-host-agent.rc", "image/app-host/aim-app-host-agent.rc"),
        ("system_ext/bin/aim-system", "image/app-host/aim-system"),
        ("system_ext/etc/init/aim-system.rc", "image/app-host/aim-system.rc"),
        ("system/framework/aim-nearby.jar", "target/aim/device-services/aim-nearby.jar"),
        ("system/etc/aim/app-host-services", "image/app-host/services"),
        ("system/framework/aim-services.jar", "target/aim/device-services/aim-services.jar"),
    ] {
        let from = payload.join(source);
        let metadata = fs::symlink_metadata(&from).map_err(|e| format!("{source}: {e}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!("Android app host source is not a regular file: {source}"));
        }
        if guest == "system_ext/bin/aim-app-host-agent" && metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!("Android app host program is not executable: {source}"));
        }
        let to = prepared.inputs.join(source);
        fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::copy(&from, &to).map_err(|e| e.to_string())?;
        if guest.starts_with("system_ext/bin/") {
            fs::set_permissions(&to, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        entries.push(Entry { kind: if guest.ends_with("aim-services.jar") { Kind::Replace } else { Kind::Add },
            path: format!("/{guest}"), source: Some(source.into()),
            reason: Some("AIM app host services".into()), line: 0 });
    }
    let zygote = "system/etc/init/hw/init.zygote64.rc";
    let text = fs::read_to_string(original.join(zygote)).map_err(|e| e.to_string())?;
    if !text.contains(" --start-system-server") { return Err("Android zygote declaration has no system server argument".into()); }
    let native = "system/etc/aim/native-services";
    let mut services = fs::read_to_string(original.join(native)).map_err(|e| e.to_string())?;
    if services.lines().any(|line| line.split_whitespace().next() == Some("activity")) {
        return Err("Android activity service is already selected in the source image".into());
    }
    if !services.ends_with('\n') { services.push('\n'); }
    services.push_str("activity         com.android.server.am.ActivityManagerService$Lifecycle\n");
    for (guest, contents) in [(zygote, text.replace(" --start-system-server", "")), (native, services)] {
        let source = format!("app-host-profile/{guest}");
        let file = prepared.inputs.join(&source);
        fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(file, contents).map_err(|e| e.to_string())?;
        entries.push(Entry { kind: Kind::Replace, path: format!("/{guest}"), source: Some(source),
            reason: Some("AIM app host process selection".into()), line: 0 });
    }
    prepared.plan = validate(&Manifest { entries, includes: Vec::new() }, original, &prepared.inputs)
        .map_err(|p| p.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))?;
    Ok(prepared)
}

fn clone_shadow(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("Android source shadow is not a regular file".into()); }
    let from = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to = std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    if unsafe { libc::clonefile(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        return Err(format!("Android app host needs copy-on-write shadow cloning: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

fn attach_app_host(image: &Path, shadow: &Path, mount: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(shadow).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Android app host shadow is not a regular file".into());
    }
    for attachment in disk::attachments_of(image)? {
        if attachment.shadow.as_deref() == Some(shadow)
            && (attachment.writable || attachment.mounts.iter().any(|path| path != mount)) {
            return Err("Android app host image is attached with different ownership".into());
        }
    }
    system::attach(image, Some(shadow), mount, false)
}

fn prepare_app_host(payload: &Path, output: &Path, original: &Path) -> Result<PathBuf, String> {
    let output = fs::canonicalize(output).map_err(|e| e.to_string())?;
    let image = output.join("system.dmg");
    // A new app-host shadow never rewrites the base or another generation.
    // Retain their existing shared image lease throughout cloning/publication.
    let _base = system::ImageLease::read(&image)?;
    let base_identity = identity::read_tree_identity(original)?.ok_or("Android source image has no content identity")?;
    let prepared = app_host_plan(original, payload, &output)?;
    let wanted = identity::compute(&base_identity, &prepared.plan);
    let directory = output.join("app-host");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let shadow = directory.join(format!("{}.shadow", wanted.hex));
    let mount = directory.join(&wanted.hex);
    let _generation = system::ImageLease::write(&shadow)?;
    if shadow.exists() {
        attach_app_host(&image, &shadow, &mount)?;
        if identity::read_tree_identity(&system::root(&mount))?.as_deref() != Some(wanted.hex.as_str()) {
            return Err("Android app host image content identity differs from its generation".into());
        }
        return Ok(system::root(&mount));
    }
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let staging = directory.join(format!(".{}-{}-{nonce}", wanted.hex, std::process::id()));
    let staging_shadow = staging.with_extension("shadow");
    clone_shadow(&output.join("derived.shadow"), &staging_shadow)?;
    let built = (|| {
        system::attach(&image, Some(&staging_shadow), &staging, true)?;
        assemble::apply(&prepared.plan, &wanted, &system::root(&staging))?;
        execute(Command::new(payload.join("bin/linux-translate")).arg("--image").arg(&staging))
    })();
    if let Err(error) = system::detach(&image, Some(&staging_shadow)) {
        return Err(match built { Ok(()) => error, Err(first) => format!("{first}; {error}") });
    }
    if let Err(error) = built {
        let _ = fs::remove_file(&staging_shadow);
        let _ = fs::remove_dir(&staging);
        return Err(error);
    }
    // An exclusive hard-link publication cannot overwrite another generation.
    // The temporary name is retired before the completed shadow is attached.
    fs::hard_link(&staging_shadow, &shadow).map_err(|e| e.to_string())?;
    fs::remove_file(&staging_shadow).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir(&staging);
    attach_app_host(&image, &shadow, &mount)?;
    if identity::read_tree_identity(&system::root(&mount))?.as_deref() != Some(wanted.hex.as_str()) {
        return Err("Android app host image publication has a different content identity".into());
    }
    Ok(system::root(&mount))
}

#[cfg(test)]
mod app_host_tests {
    use super::*;
    #[test]
    fn app_host_projection_preserves_base_and_seals_all_inputs() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let work = std::env::temp_dir().join(format!("aim-app-host-plan-{}-{nonce}", std::process::id()));
        let base = work.join("base");
        let payload = work.join("payload");
        let original_zygote = "service zygote /system/bin/app_process64 -Xzygote /system/bin --zygote --start-system-server\n";
        for (file, bytes, executable) in [
            (base.join("system/etc/init/hw/init.zygote64.rc"), original_zygote.as_bytes(), false),
            (base.join("system/etc/aim/native-services"), &b"package package.Class\n"[..], false),
            (base.join("system/framework/aim-services.jar"), &b"existing-services"[..], false),
            (payload.join("target/aim/daemons/bin/aim-app-host-agent"), &b"original-agent-product"[..], true),
            (payload.join("target/aim/device-services/aim-services.jar"), &b"complete-device-services"[..], false),
            (payload.join("target/aim/device-services/aim-nearby.jar"), &b"complete-nearby-services"[..], false),
        ] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();fs::write(&file, bytes).unwrap();
            if executable { fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap(); }
        }
        for dir in ["system_ext/bin", "system_ext/etc/init"] { fs::create_dir_all(base.join(dir)).unwrap(); }
        let upstream = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        for source in ["aim-app-host-agent.rc", "aim-system", "aim-system.rc", "services"] {
            let destination = payload.join("image/app-host").join(source);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(upstream.join("image/app-host").join(source), destination).unwrap();
        }
        let first = app_host_plan(&base, &payload, &work).unwrap();
        assert_eq!(first.plan.steps.len(), 9);
        let base_identity = "a".repeat(64);
        let wanted = identity::compute(&base_identity, &first.plan);
        let repeated = app_host_plan(&base, &payload, &work).unwrap();
        assert_eq!(wanted, identity::compute(&base_identity, &repeated.plan));
        assert_ne!(wanted, identity::compute(&"b".repeat(64), &first.plan));
        let generated = |guest: &str| &first.plan.steps.iter().find(|s| s.path == guest).unwrap().source.as_ref().unwrap().resolved;
        assert_eq!(fs::read_to_string(generated("/system/etc/init/hw/init.zygote64.rc")).unwrap(), original_zygote.replace(" --start-system-server", ""));
        assert_eq!(fs::read_to_string(base.join("system/etc/init/hw/init.zygote64.rc")).unwrap(), original_zygote);
        assert_eq!(fs::read_to_string(generated("/system/etc/aim/native-services")).unwrap().lines().filter(|l| l.split_whitespace().next() == Some("activity")).count(), 1);
        assert_eq!(fs::read(generated("/system/etc/aim/app-host-services")).unwrap(), fs::read(upstream.join("image/app-host/services")).unwrap());
        let shadow = work.join("derived.shadow");let clone = work.join("app-host.shadow");
        fs::write(&shadow, b"immutable original shadow").unwrap();clone_shadow(&shadow, &clone).unwrap();
        fs::write(&clone, b"private app host writes").unwrap();
        assert_eq!(fs::read(&shadow).unwrap(), b"immutable original shadow");
        fs::write(payload.join("target/aim/daemons/bin/aim-app-host-agent"), b"changed-agent-product").unwrap();
        let changed = app_host_plan(&base, &payload, &work).unwrap();
        assert_ne!(wanted, identity::compute(&base_identity, &changed.plan));
        fs::write(payload.join("target/aim/device-services/aim-services.jar"), b"changed-services").unwrap();
        let changed_jar = app_host_plan(&base, &payload, &work).unwrap();
        assert_ne!(identity::compute(&base_identity, &changed.plan), identity::compute(&base_identity, &changed_jar.plan));
        fs::write(payload.join("target/aim/device-services/aim-nearby.jar"), b"changed-nearby-services").unwrap();
        let changed_nearby = app_host_plan(&base, &payload, &work).unwrap();
        assert_ne!(identity::compute(&base_identity, &changed_jar.plan), identity::compute(&base_identity, &changed_nearby.plan));
        fs::remove_file(payload.join("image/app-host/services")).unwrap();
        assert!(app_host_plan(&base, &payload, &work).is_err());
        drop((first, repeated, changed, changed_jar, changed_nearby));
        fs::remove_dir_all(work).unwrap();
    }
}

fn main() {
    let args = std::env::args_os().skip(1).map(PathBuf::from).collect::<Vec<_>>();
    if args.len() == 2 && (args[0] == Path::new("--data-attach") || args[0] == Path::new("--data-detach")) {
        let result = if args[0] == Path::new("--data-attach") { prepare_data(&args[1]) } else { detach_data(&args[1]) };
        if let Err(error) = result { eprintln!("Android private data preparation failed: {error}"); std::process::exit(1); }
        return;
    }
    let app_host = args.first().is_some_and(|arg| arg == Path::new("--app-host"));
    let args = if app_host { &args[1..] } else { &args[..] };
    if args.len() != 3 {
        eprintln!("usage: android-runtime-prepare [--app-host] ARCHIVE PAYLOAD OUTPUT");
        std::process::exit(2);
    }
    let result = prepare(&args[0], &args[1], &args[2]).and_then(|original| {
        if app_host {
            let original = fs::canonicalize(original).map_err(|e| e.to_string())?;
            let app_host = prepare_app_host(&args[1], &args[2], &original)?;
            println!("{}", serde_json::json!({ "originalImage": original, "appHostImage": app_host }));
        } else { println!("{}", original.display()); }
        Ok(())
    });
    if let Err(error) = result {
        eprintln!("Android system image preparation failed: {error}");
        std::process::exit(1);
    }
}
