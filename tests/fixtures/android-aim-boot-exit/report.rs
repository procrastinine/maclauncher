use super::*;
use aim_storage::{mount_namespace::Namespace, process_namespace::{self, InitNamespaceEntry, InitRegistration, ProcessIdentity}};
use std::{fs, io::{self, Write}, time::{SystemTime, UNIX_EPOCH}};

#[test]
fn first_exit_is_visible_before_authenticated_namespace_retirement() {
    let root = std::env::temp_dir().join(format!("aim-first-exit-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let table = root.join("identity/by-pid");
    let image = root.join("image");
    fs::create_dir_all(&image).unwrap();
    let process = ProcessIdentity::running_strict(std::process::id() as i32).unwrap();
    let namespace = Namespace::open(&root, "original-init").unwrap();
    namespace.initialize(&format!("root\t/\t{}\n", image.display())).unwrap();
    let registration = InitRegistration::register(&table, process, namespace.id()).unwrap();
    process_namespace::register_mount_namespace(&table, process, namespace.id()).unwrap();
    process_namespace::register_init_signals(&table, process, 0).unwrap();
    registration.activate_pid_mapping(&table).unwrap();

    struct BeforeRetirement<'a> { table: &'a std::path::Path, process: ProcessIdentity, bytes: Vec<u8> }
    impl Write for BeforeRetirement<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            assert_eq!(InitNamespaceEntry::capture(self.table, self.process)?.id(), "original-init");
            self.bytes.extend_from_slice(bytes); Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    let mut output = BeforeRetirement { table: &table, process, bytes: Vec::new() };
    let service_events = vec!["launch command SECRET_ENV=do-not-report".into(), "Service 'apexd' (pid 42) exited with status 6".into()];
    maclauncher_boot_stop_report(&mut output, Some("critical process 'apexd' exited 4 times before boot completed"), Some("ignored-later-shutdown"), &[], &service_events).unwrap();
    let text = String::from_utf8(output.bytes).unwrap();
    assert_eq!(text, "guest-init: stopping before service teardown: fatal: critical process 'apexd' exited 4 times before boot completed\nguest-init: preceding service exit: Service 'apexd' (pid 42) exited with status 6\n");
    assert!(!text.contains("SECRET_ENV"));
    registration.remove(&table).unwrap();
    assert!(process.is_live());
    assert_eq!(InitNamespaceEntry::capture(&table, process).err().unwrap().kind(), io::ErrorKind::NotFound);

    let mut output = Vec::new();
    maclauncher_boot_stop_report(&mut output, None, Some("reboot,bootloader"), &["stop requested".into()], &[]).unwrap();
    assert_eq!(String::from_utf8(output).unwrap(), "guest-init: stopping before service teardown: shutdown requested: reboot,bootloader\n");
    let mut output = Vec::new();
    maclauncher_boot_stop_report(&mut output, None, None, &["unrelated private context".into(), "stop requested".into()], &[]).unwrap();
    assert_eq!(String::from_utf8(output).unwrap(), "guest-init: stopping before service teardown: stop requested\n");
    let mut output = Vec::new();
    maclauncher_boot_stop_report(&mut output, Some(&format!("bad\n{}", "x".repeat(2000))), None, &[], &[]).unwrap();
    assert_eq!(String::from_utf8(output).unwrap().lines().count(), 1);
    fs::remove_dir_all(root).unwrap();
}
