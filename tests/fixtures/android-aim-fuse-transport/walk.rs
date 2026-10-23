use super::*;
use std::sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU32,Ordering}};

const NAME:&str="sys::fuse::tests::maclauncher_private_fuse::path_walk::original_syscalls_cross_late_lower_mount_after_fuse_ancestors";

struct ServiceStdio{saved:[std::os::fd::OwnedFd;3],diagnostics:i32}
impl ServiceStdio{
    fn original_null()->Self{
        use std::os::fd::{AsRawFd,FromRawFd};
        let saved=[0,1,2].map(|fd|{let copy=unsafe{libc::fcntl(fd,libc::F_DUPFD_CLOEXEC,3)};assert!(copy>=0);unsafe{std::os::fd::OwnedFd::from_raw_fd(copy)}});
        let diagnostics=crate::diag::log_fd();
        let hidden=crate::diag::stdio_null().unwrap();assert!(hidden>2);assert_eq!(crate::diag::log_fd(),hidden);
        assert_ne!(hidden,saved[2].as_raw_fd());
        Self{saved,diagnostics}
    }
}
impl Drop for ServiceStdio{
    fn drop(&mut self){use std::os::fd::AsRawFd;for (fd,saved) in self.saved.iter().enumerate(){unsafe{libc::dup2(saved.as_raw_fd(),fd as i32);}}crate::diag::log_to(self.diagnostics);}
}

#[test]
fn original_syscalls_cross_late_lower_mount_after_fuse_ancestors(){
    if crate::sys::fdtab::isolated_kernel_test(NAME){return;}
    let root=PathBuf::from(std::env::var_os("ANDROID_AIM_FUSE_FIXTURE_ROOT").unwrap()).join(format!("walk-{}",std::process::id()));
    let temporary=root.join("private-temp").join("long-component-".repeat(10));
    for p in [&temporary,&root.join("image/storage"),&root.join("image/mnt"),&root.join("runtime/data"),&root.join("anchor"),&root.join("lower/pkg/files")]{fs::create_dir_all(p).unwrap();}
    fs::write(root.join("runtime/path-map"),format!("root\t/\t{}\nrw\t/data\t{}\n",root.join("image").display(),root.join("runtime/data").display())).unwrap();
    unsafe{std::env::set_var("TMPDIR",&temporary);}view(&root);
    let _service_stdio=ServiceStdio::original_null();
    let connection=registered_connection();initialize(&connection);
    let lower=root.join("lower");let anchor=root.join("anchor");
    crate::vfs::set_mount_propagation("/",(1<<20)|0x4000).unwrap();
    crate::vfs::add_mount("/mnt/walk-user",anchor.clone(),crate::vfs::Area::Writable,"user","tmpfs").unwrap();
    crate::vfs::add_mount("/data/walk-lower",lower.clone(),crate::vfs::Area::Writable,"lower","tmpfs").unwrap();
    let parent=crate::vfs::own_mounts_text();
    crate::vfs::private_mount_namespace().unwrap();crate::vfs::set_mount_propagation("/",(1<<19)|0x4000).unwrap();
    let early_slave=crate::vfs::own_mounts_text();
    crate::vfs::load_own_mounts(&parent).unwrap();
    let options=crate::sys::fuse_mount::Options{fd:connection.fd,root_mode:0o040000,uid:0,gid:0,default_permissions:false,allow_other:true,max_read:None};
    crate::vfs::add_fuse_mount("/mnt/walk-user/emulated",connection.key.0.clone(),anchor.clone(),"/dev/fuse",&options,false).unwrap();
    let fuse_parent=crate::vfs::own_mounts_text();
    crate::vfs::load_own_mounts(&early_slave).unwrap();crate::vfs::refresh_fuse_mounts().unwrap();
    crate::vfs::private_mount_namespace().unwrap();crate::vfs::set_mount_propagation("/",(1<<19)|0x4000).unwrap();
    crate::vfs::bind_mount_recursive("/mnt/walk-user","/storage/walk",anchor,crate::vfs::Area::Writable,true).unwrap();
    let app=crate::vfs::own_mounts_text();
    crate::vfs::load_own_mounts(&fuse_parent).unwrap();
    crate::vfs::bind_mount("/data/walk-lower","/mnt/walk-user/emulated/0/Android/data",lower.clone(),crate::vfs::Area::Writable,"/data/walk-lower","bind").unwrap();
    crate::vfs::load_own_mounts(&app).unwrap();crate::vfs::refresh_fuse_mounts().unwrap();
    for suffix in ["","pkg","pkg/files"]{
        let c=std::ffi::CString::new(lower.join(suffix).as_os_str().as_encoded_bytes()).unwrap();
        crate::sys::attrs::record(crate::sys::attrs::Host::Path(&c),||format!("/data/walk-lower/{suffix}"),crate::sys::attrs::Attr{uid:Some(10213),gid:Some(1078),mode:Some(0o2770)});
    }
    let trace=std::env::var_os("MACLAUNCHER_AIM_FS_TRACE").is_some_and(|v|v=="1");
    let root_mode=Arc::new(AtomicU32::new(0o040771));
    let stop=Arc::new(AtomicBool::new(false));let deny=Arc::new(AtomicBool::new(false));let deny_root_getattr=Arc::new(AtomicBool::new(true));let negative=Arc::new(AtomicBool::new(false));let getattr_error=Arc::new(AtomicBool::new(false));let seen=Arc::new(Mutex::new(Vec::new()));
    let daemon_stop=stop.clone();let daemon_deny=deny.clone();let daemon_deny_root_getattr=deny_root_getattr.clone();let daemon_root_mode=root_mode.clone();let daemon_negative=negative.clone();let daemon_getattr_error=getattr_error.clone();let daemon_seen=seen.clone();let fd=connection.fd;
    let daemon=std::thread::spawn(move||{
        while !daemon_stop.load(Ordering::Acquire){
            if poll_device(fd).unwrap()&1==0{std::thread::sleep(Duration::from_millis(1));continue;}
            let packet=next(fd);let op=u32::from_le_bytes(packet[4..8].try_into().unwrap());let node=u64::from_le_bytes(packet[16..24].try_into().unwrap());let uid=u32::from_le_bytes(packet[24..28].try_into().unwrap());let gid=u32::from_le_bytes(packet[28..32].try_into().unwrap());
            let name=if op==1{String::from_utf8_lossy(&packet[40..]).trim_end_matches('\0').to_owned()}else{String::new()};
            daemon_seen.lock().unwrap().push((op,node,uid,gid,name.clone()));
            match op{
                1=>{
                    if daemon_deny.load(Ordering::Acquire)&&name=="Android"{respond(fd,&packet,-13,&[]);continue;}
                    let next=match (node,name.as_str()){(1,"0")=>2u64,(2,"Android")=>if daemon_negative.load(Ordering::Acquire){0u64}else{3u64},(2,"jump")=>4u64,_=>{respond(fd,&packet,-2,&[]);continue;}};
                    let mode=if next==4{0o120777u32}else{0o040771u32};
                    let mut entry=vec![0;128];entry[..8].copy_from_slice(&next.to_le_bytes());entry[100..104].copy_from_slice(&mode.to_le_bytes());respond(fd,&packet,0,&entry);
                }
                3=>{assert!((1..=4).contains(&node));if node==1&&uid>=10000&&daemon_deny_root_getattr.load(Ordering::Acquire){respond(fd,&packet,-2,&[]);continue;}if node==3&&daemon_getattr_error.load(Ordering::Acquire){respond(fd,&packet,-2,&[]);continue;}let mode=if node==1{daemon_root_mode.load(Ordering::Acquire)}else if node==4{0o120777}else{0o040771};let mut attr=vec![0;104];attr[16..24].copy_from_slice(&node.to_le_bytes());attr[76..80].copy_from_slice(&mode.to_le_bytes());respond(fd,&packet,0,&attr);}
                5=>{assert_eq!(node,4);respond(fd,&packet,0,b"/storage/walk/emulated/0/Android/data/pkg/files/Minetest/builtin/profiler/instrumentation.lua");}
                34=>{assert_eq!(node,1);assert_eq!(u32::from_le_bytes(packet[40..44].try_into().unwrap()),1);respond(fd,&packet,0,&[]);}
                FORGET=>{}
                _=>panic!("unexpected path-walk operation {op} node {node}")
            }
        }
    });
    let identity=crate::sys::cred::Identity{uid:[10213;4],gid:[10213;4],groups:vec![1078],cap_eff:0,cap_perm:0,cap_bset:0,..Default::default()};crate::sys::cred::init(identity.clone(),None);
    let base="/storage/walk/emulated/0/Android/data/pkg/files";
    for name in ["Minetest","Minetest/builtin","Minetest/builtin/profiler"]{
        let c=std::ffi::CString::new(format!("{base}/{name}")).unwrap();let result=crate::sys::fsops::mkdirat([(-100i64)as u64,c.as_ptr()as u64,0o777,0,0,0]);assert_eq!(result,0,"original mkdirat {name}; requests={:?}",seen.lock().unwrap());
    }
    let file=std::ffi::CString::new(format!("{base}/Minetest/builtin/profiler/instrumentation.lua")).unwrap();
    let opened=crate::sys::fs::openat([(-100i64)as u64,file.as_ptr()as u64,0x241,0o666,0,0]);assert!(opened>=0,"original openat errno {opened}; requests={:?}",seen.lock().unwrap());
    let bytes=b"original lower write";assert_eq!(crate::sys::fs::write([opened as u64,bytes.as_ptr()as u64,bytes.len()as u64,0,0,0]),bytes.len()as i64);assert_eq!(crate::sys::fs::close([opened as u64,0,0,0,0,0]),0);
    assert_eq!(fs::read(lower.join("pkg/files/Minetest/builtin/profiler/instrumentation.lua")).unwrap(),bytes);
    assert!(!seen.lock().unwrap().iter().any(|(op,node,_,_,_)|*op==3&&*node==1),"traversal must not stat the mounted directory root");
    let mount_root=std::ffi::CString::new("/storage/walk/emulated").unwrap();let mut stat=[0xa5u8;256];
    for flags in [0,0x100]{assert_eq!(crate::sys::fs::newfstatat([(-100i64)as u64,mount_root.as_ptr()as u64,stat.as_mut_ptr()as u64,flags,0,0]),-2,"explicit root stat/lstat stays denied");assert!(stat.iter().all(|b|*b==0xa5));}
    assert_eq!(crate::sys::fs::faccessat((-100i64)as u64,mount_root.as_ptr()as u64,1,0),0,"original root X_OK traversal remains allowed");
    let jump=std::ffi::CString::new("/storage/walk/emulated/0/jump").unwrap();
    let linked=crate::sys::fs::openat([(-100i64)as u64,jump.as_ptr()as u64,0,0,0,0]);assert!(linked>=0,"nonroot symlink must resolve");assert_eq!(crate::sys::fs::close([linked as u64,0,0,0,0,0]),0);
    assert!(seen.lock().unwrap().iter().any(|(op,node,_,_,_)|*op==5&&*node==4),"nonroot READLINK is preserved");
    assert!(seen.lock().unwrap().iter().all(|(_,_,uid,gid,name)|*uid==10213&&*gid==10213&&name!="data"));
    let mut foreign=identity.clone();foreign.uid=[10214;4];foreign.gid=[10214;4];foreign.groups.clear();crate::sys::cred::init(foreign,None);
    assert_eq!(crate::sys::fs::openat([(-100i64)as u64,file.as_ptr()as u64,0,0,0,0]),-13,"lower DAC permission must remain enforced");
    crate::sys::cred::init(identity,None);deny.store(true,Ordering::Release);
    assert_eq!(crate::sys::fs::openat([(-100i64)as u64,file.as_ptr()as u64,0,0,0,0]),-13,"mounted child must not bypass ancestor FUSE search");
    deny.store(false,Ordering::Release);
    let existing=std::ffi::CString::new(format!("{base}/Minetest")).unwrap();
    assert_eq!(crate::sys::fsops::mkdirat([(-100i64)as u64,existing.as_ptr()as u64,0o777,0,0,0]),-17);
    negative.store(true,Ordering::Release);
    let missing=std::ffi::CString::new(format!("{base}/missing-child")).unwrap();
    assert_eq!(crate::sys::fsops::mkdirat([(-100i64)as u64,missing.as_ptr()as u64,0o777,0,0,0]),-2,"negative FUSE entry preserves ENOENT");
    assert!(!lower.join("pkg/files/missing-child").exists());
    negative.store(false,Ordering::Release);getattr_error.store(true,Ordering::Release);
    assert_eq!(crate::sys::fs::openat([(-100i64)as u64,file.as_ptr()as u64,0,0,0,0]),-2,"FUSE GETATTR error preserves ENOENT");
    getattr_error.store(false,Ordering::Release);deny_root_getattr.store(false,Ordering::Release);
    let mut checked_options=options.clone();checked_options.default_permissions=true;
    crate::vfs::add_fuse_mount("/mnt/walk-checked",connection.key.0.clone(),root.join("anchor"),"/dev/fuse",&checked_options,false).unwrap();
    let checked=std::ffi::CString::new("/mnt/walk-checked/0/jump").unwrap();
    root_mode.store(0o040000,Ordering::Release);
    assert_eq!(crate::sys::fs::openat([(-100i64)as u64,checked.as_ptr()as u64,0,0,0,0]),-13,"default_permissions must retain root search DAC");
    root_mode.store(0o040771,Ordering::Release);
    let checked_open=crate::sys::fs::openat([(-100i64)as u64,checked.as_ptr()as u64,0,0,0,0]);assert!(checked_open>=0,"default_permissions allows original permitted traversal");assert_eq!(crate::sys::fs::close([checked_open as u64,0,0,0,0,0]),0);
    stop.store(true,Ordering::Release);daemon.join().unwrap();drop(connection);
    unsafe{*libc::__error()=libc::EINTR;}
    crate::sys::fsops::aim_fs_trace(||"op=errno-control".to_owned());
    assert_eq!(unsafe{*libc::__error()},libc::EINTR,"diagnostics must preserve host errno");
    unsafe{std::env::set_var("MACLAUNCHER_AIM_FS_TRACE",if trace{"0"}else{"1"});}
    assert_eq!(crate::sys::fsops::aim_fs_trace_enabled(),trace,"flag is read once");
    let mut formatted=0;
    for _ in 0..100{crate::sys::fsops::aim_fs_trace(||{formatted+=1;format!("op=bounded-control {}","x".repeat(4096))});}
    assert_eq!(formatted==0,!trace,"disabled trace must not evaluate formatting");
}
