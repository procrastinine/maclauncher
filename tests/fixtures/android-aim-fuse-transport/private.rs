use super::*;

#[path="walk.rs"]
mod path_walk;

const NAME: &str = "sys::fuse::tests::maclauncher_private_fuse::private_transport_keeps_original_protocol_and_descriptor_identity";

fn view(root: &Path) {
    crate::vfs::init(&root.join("image"), Some(&root.join("runtime/path-map"))).unwrap();
}

struct RegisteredConnection { connection: Connection, _allocation: TransportAllocation }
impl std::ops::Deref for RegisteredConnection {
    type Target=Connection;
    fn deref(&self)->&Connection { &self.connection }
}

fn registered_connection() -> RegisteredConnection {
    let directory = transport_directory().unwrap();
    assert!(directory.as_os_str().as_encoded_bytes().len() > 104);
    let registry = crate::vfs::runtime_dir().unwrap().join("fuse-sessions");
    fs::create_dir_all(&registry).unwrap();
    use std::os::unix::fs::OpenOptionsExt;
    let entry_path=registry.join(directory.file_name().unwrap());
    let mut entry = fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
        .open(&entry_path).unwrap();
    std::io::Write::write_all(&mut entry, directory.as_os_str().as_encoded_bytes()).unwrap();
    use std::os::unix::fs::MetadataExt;
    let metadata=fs::symlink_metadata(&directory).unwrap();
    let allocation=TransportAllocation{directory:directory.clone(),entry:Some(entry_path),identity:(metadata.dev(),metadata.ino()),connections:crate::vfs::runtime_dir().unwrap().join("fuse-connections")};
    let key = SessionKey(directory.join("c.sock"));
    let path = key.0.clone();
    let worker = std::thread::spawn(move || serve_broker(&path));
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !key.0.exists() {
        if worker.is_finished() { panic!("original broker stopped before binding: {:?}",worker.join()); }
        assert!(std::time::Instant::now() < deadline,"original broker has not bound {}",key.0.display());
        std::thread::sleep(Duration::from_millis(1));
    }
    let fd = open_on_key(&key, 0, OPEN_DEVICE, &[]).unwrap();
    assert_eq!(session_for_fd(fd).unwrap(), key);
    assert!(socket_path(fd, true).unwrap().is_relative());
    assert!(socket_path(fd, false).unwrap().is_relative());
    RegisteredConnection { connection:Connection {key,fd,worker:Some(worker)}, _allocation:allocation }
}

#[test]
fn private_transport_keeps_original_protocol_and_descriptor_identity() {
    let root = PathBuf::from(std::env::var_os("ANDROID_AIM_FUSE_FIXTURE_ROOT").unwrap());
    if let Ok(fd) = std::env::var("ANDROID_AIM_FUSE_INHERITED_FD") {
        view(&root);
        let fd: i32 = fd.parse().unwrap();
        assert_eq!(marker(fd),Some(DEVICE_MARKER));
        assert_eq!(session_for_fd(fd).unwrap().0,PathBuf::from(std::env::var_os("ANDROID_AIM_FUSE_KEY").unwrap()));
        assert_eq!(poll_device(fd).unwrap(),4);
        println!("FUSE_PRIVATE_EXEC: inherited descriptor recovers registered full identity and original broker");
        return;
    }
    if crate::sys::fdtab::isolated_kernel_test(NAME) {return;}
    let temporary = root.join("private-temp").join("long-component-".repeat(10));
    fs::create_dir_all(&temporary).unwrap();
    fs::create_dir_all(root.join("image")).unwrap();
    fs::create_dir_all(root.join("runtime")).unwrap();
    fs::write(root.join("runtime/path-map"),format!("root\t/\t{}\nrw\t/data\t{}\n",root.join("image").display(),root.join("runtime/data").display())).unwrap();
    unsafe {std::env::set_var("TMPDIR",&temporary);}
    view(&root);
    unsafe extern "C" {fn sandbox_init(profile:*const libc::c_char,flags:u64,error:*mut *mut libc::c_char)->i32;}
    let quoted=root.to_str().unwrap().replace('\\',"\\\\").replace('"',"\\\"");
    let profile=std::ffi::CString::new(format!("(version 1)(deny default)(allow file-read*)(allow process*)(allow sysctl-read)(allow file-write* (subpath \"{quoted}\"))(allow network-bind network-inbound (local unix-socket (subpath \"{quoted}\")))(allow network-outbound (remote unix-socket (subpath \"{quoted}\")))")).unwrap();
    let mut error=std::ptr::null_mut();assert_eq!(unsafe{sandbox_init(profile.as_ptr(),0,&mut error)},0);
    let denied=std::env::temp_dir().ancestors().last().unwrap().join(format!("tmp/aim-fuse-denied-{}",std::process::id()));
    assert!(matches!(fs::write(&denied,b"denied"),Err(ref e) if matches!(e.raw_os_error(),Some(libc::EPERM)|Some(libc::EACCES))));
    let cwd=std::env::current_dir().unwrap();
    let connection=registered_connection();initialize(&connection);
    assert_eq!(std::env::current_dir().unwrap(),cwd);
    let duplicate=unsafe{libc::dup(connection.fd)};assert!(duplicate>=0);
    assert_eq!(session_for_fd(duplicate).unwrap(),connection.key);
    assert_eq!(unsafe{libc::fcntl(duplicate,libc::F_GETFD)},0);
    let child=std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact",NAME,"--nocapture","--skip","isolated-kernel-instance"])
        .env("ANDROID_AIM_FUSE_INHERITED_FD",duplicate.to_string())
        .env("ANDROID_AIM_FUSE_KEY",&connection.key.0).output().unwrap();
    assert!(child.status.success(),"{}{}",String::from_utf8_lossy(&child.stdout),String::from_utf8_lossy(&child.stderr));
    assert!(String::from_utf8_lossy(&child.stdout).contains("FUSE_PRIVATE_EXEC"));
    unsafe{libc::close(duplicate);}
    let client=Client::from_key(&connection.key).unwrap();
    let call=std::thread::spawn(move||client.request(1,1,b"entry\0",10213,1078,42));
    let packet=next(connection.fd);
    assert_eq!(u32::from_le_bytes(packet[24..28].try_into().unwrap()),10213);
    assert_eq!(u32::from_le_bytes(packet[28..32].try_into().unwrap()),1078);
    assert_eq!(u32::from_le_bytes(packet[32..36].try_into().unwrap()),42);
    respond(connection.fd,&packet,-13,&[]);assert_eq!(call.join().unwrap().err(),Some(13));
    let destination=registered_connection();ioctl_clone(destination.fd,connection.fd).unwrap();assert_eq!(session_for_fd(destination.fd).unwrap(),connection.key);
    assert!(registered_transport_path(Path::new("af-0000000000000000/c.sock")).is_err());
    assert!(registered_transport_path(Path::new("../c.sock")).is_err());
    let registry=crate::vfs::runtime_dir().unwrap().join("fuse-sessions");
    let fake=registry.join("af-0000000000000000");
    std::os::unix::fs::symlink(registry.join(connection.key.0.parent().unwrap().file_name().unwrap()),&fake).unwrap();
    assert!(registered_transport_path(Path::new("af-0000000000000000/c.sock")).is_err());fs::remove_file(fake).unwrap();
    let destination_directory=destination.key.0.parent().unwrap().to_owned();
    let source_directory=connection.key.0.parent().unwrap().to_owned();
    drop(destination);drop(connection);
    assert!(!destination_directory.exists(),"original broker left its destination sockets");
    assert!(!source_directory.exists(),"original broker left its source sockets");
    println!("FUSE_PRIVATE_PASS: long private allocation, deny/tmp, native broker/device INIT, exact uid/gid/pid and errno, dup/clone, exec recovery, cwd and registration rejection");
}

#[test]
fn broker_readiness_preserves_metadata_requests_and_notifications() {
    const NAME: &str = "sys::fuse::tests::maclauncher_private_fuse::broker_readiness_preserves_metadata_requests_and_notifications";
    if crate::sys::fdtab::isolated_kernel_test(NAME) { return; }
    let root = PathBuf::from(std::env::var_os("ANDROID_AIM_FUSE_FIXTURE_ROOT").unwrap()).join(format!("readiness-{}",std::process::id()));
    let temporary = root.join("private-temp").join("long-component-".repeat(10));
    for directory in [&temporary,&root.join("image"),&root.join("runtime/data")] { fs::create_dir_all(directory).unwrap(); }
    fs::write(root.join("runtime/path-map"),format!("root\t/\t{}\nrw\t/data\t{}\n",root.join("image").display(),root.join("runtime/data").display())).unwrap();
    unsafe { std::env::set_var("TMPDIR",&temporary); } view(&root);
    let connection = registered_connection(); initialize(&connection);
    let fd = connection.fd;
    let daemon = std::thread::spawn(move || {
        let (mut lookups,mut attributes,mut forgets,mut missing) = (0u64,0u64,0u64,false);
        loop {
            let packet = next(fd);
            let op = u32::from_le_bytes(packet[4..8].try_into().unwrap());
            let node = u64::from_le_bytes(packet[16..24].try_into().unwrap());
            let uid = u32::from_le_bytes(packet[24..28].try_into().unwrap());
            let gid = u32::from_le_bytes(packet[28..32].try_into().unwrap());
            assert_eq!(uid,gid); assert_eq!(uid,if lookups < 16 {10213} else if op == 1 && lookups == 16 {10214} else if lookups <= 16 {10213} else {10214});
            match op {
                1 => {
                    lookups += 1; assert_eq!(node,1);
                    let name = &packet[40..];
                    if name == b"denied\0" { respond(fd,&packet,-13,&[]); continue; }
                    let node = if name == b"missing\0" { let value=if missing {43u64}else{0}; missing=true; value } else { assert_eq!(name,b"entry\0");42u64 };
                    let mut entry = vec![0;128]; entry[..8].copy_from_slice(&node.to_le_bytes());
                    // Alternate the daemon's real TTL values. Admission must
                    // not add a cache, retain a negative entry, or reuse attrs.
                    if lookups % 2 == 0 { entry[16..24].copy_from_slice(&u64::MAX.to_le_bytes()); }
                    entry[100..104].copy_from_slice(&0o100644u32.to_le_bytes()); respond(fd,&packet,0,&entry);
                }
                3 => { attributes += 1; assert!([42,43].contains(&node)); let mut attr=vec![0;104];attr[16..24].copy_from_slice(&node.to_le_bytes());attr[24..32].copy_from_slice(&attributes.to_le_bytes());attr[76..80].copy_from_slice(&0o100644u32.to_le_bytes());respond(fd,&packet,0,&attr); }
                FORGET => { assert!([42,43].contains(&node));assert_eq!(u64::from_le_bytes(packet[40..48].try_into().unwrap()),1);forgets+=1;if forgets==33 { break; } }
                _ => panic!("unexpected metadata request {op}")
            }
        }
        (lookups,attributes,forgets)
    });
    let route = crate::vfs::FuseRoute { session:connection.key.0.clone(),relative:"entry".into(),uid:0,gid:0,allow_other:true,default_permissions:false,read_only:false };
    let started = std::time::Instant::now();
    for iteration in 0..32u64 {
        let uid=if iteration<16 {10213}else{10214};crate::sys::cred::init(crate::sys::cred::Identity {uid:[uid;4],gid:[uid;4],groups:vec![uid],..Default::default()},None);
        let node=crate::sys::fuse_client::lookup(&route).unwrap();assert_eq!(node,42);
        let attr=crate::sys::fuse_client::getattr(&route,node,None).unwrap();assert_eq!(u64::from_le_bytes(attr[8..16].try_into().unwrap()),iteration+1);
        crate::sys::fuse_client::forget(&route,node,1).unwrap();
    }
    let elapsed = started.elapsed();
    let mut notification=Vec::new();notification.extend(40u32.to_le_bytes());notification.extend(2i32.to_le_bytes());notification.extend(0u64.to_le_bytes());notification.extend(42u64.to_le_bytes());notification.extend((-1i64).to_le_bytes());notification.extend(0u64.to_le_bytes());
    assert_eq!(write_device(fd,&notification).unwrap(),40);
    let client=Client::from_key(&connection.key).unwrap();let notifications=client.take_notifications().unwrap();assert_eq!(notifications.len(),1);assert_eq!(notifications[0].code,2);assert_eq!(notifications[0].body,&notification[16..]);assert!(client.take_notifications().unwrap().is_empty());
    let mut denied=route.clone();denied.relative="denied".into();assert_eq!(crate::sys::fuse_client::lookup(&denied),Err(13));
    denied.allow_other=false;assert_eq!(crate::sys::fuse_client::lookup(&denied),Err(13));
    let mut missing=route.clone();missing.relative="missing".into();assert_eq!(crate::sys::fuse_client::lookup(&missing),Err(2));
    let node=crate::sys::fuse_client::lookup(&missing).unwrap();assert_eq!(node,43);let attr=crate::sys::fuse_client::getattr(&missing,node,None).unwrap();assert_eq!(u64::from_le_bytes(attr[8..16].try_into().unwrap()),33);crate::sys::fuse_client::forget(&missing,node,1).unwrap();
    assert_eq!(daemon.join().unwrap(),(35,33,33));
    let key=connection.key.clone();let retired=std::time::Instant::now();drop(connection);assert!(!key.0.exists());assert!(Client::from_key(&key).is_err());
    fs::write(std::env::var_os("ANDROID_AIM_FUSE_READINESS_RESULT").unwrap(),format!("{{\"cycles\":32,\"lookup\":35,\"getattr\":33,\"forget\":33,\"elapsed_us\":{},\"retirement_us\":{},\"credentialsTtlNegativeAttributesNotificationsRetirement\":true}}\n",elapsed.as_micros(),retired.elapsed().as_micros())).unwrap();
}
