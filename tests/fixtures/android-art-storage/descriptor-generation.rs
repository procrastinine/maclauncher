pub(crate) fn control(root:&std::path::Path){
 use std::os::fd::AsRawFd;
 let data=root.join("data");let run=root.join("run");let guest=root.join("root");
 for directory in [&data,&run,&guest]{std::fs::create_dir_all(directory).unwrap();}
 let map=run.join("path-map");std::fs::write(&map,format!("rw\t/data\t{}\n",data.display())).unwrap();
 // No verity locator: a regular native file legitimately has no extra Kind.
 crate::vfs::init(&guest,Some(&map)).unwrap();
 let mut sockets=[-1i32;2];assert_eq!(crate::sys::net::socketpair([1,1,0,sockets.as_mut_ptr()as u64,0,0]),0);
 let old=sockets[0];fdtab::remember_virtual_path(old,"/original-socket-open".into()).unwrap();
 let retained=fdtab::pin_guest(old).unwrap();let held=retained.descriptor().as_raw_fd();
 // A physical owner closes its endpoint. Its numeric slot remains in the ABI
 // metadata until the next authoritative creator registers a new description.
 assert_eq!(unsafe{libc::close(old)},0);
 let path=std::ffi::CString::new("/data/new-file").unwrap();
 let file=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,0o100|2,0o600,0,0]);
 assert_eq!(file,old as i64,"the original open must reuse the released public slot");
 assert_eq!(super::write([file as u64,b"ok".as_ptr()as u64,2,0,0,0]),2,"fresh regular description must not inherit a retired socket Kind");
 assert!(!matches!(fdtab::get(file as i32),Some(Kind::Sock(_))));
 assert!(matches!(fdtab::get(held),Some(Kind::Sock(_))));
 assert_eq!(fdtab::virtual_path(held).as_deref(),Some("/original-socket-open"));
 let bytes=b"old";let vector=libc::iovec{iov_base:bytes.as_ptr()as*mut _,iov_len:bytes.len()};
 assert_eq!(crate::sys::net::write_pinned(&retained,&[vector]),Some(3));
 let mut answer=[0u8;3];assert_eq!(super::read([sockets[1]as u64,answer.as_mut_ptr()as u64,3,0,0,0]),3);assert_eq!(&answer,b"old");
 assert_eq!(crate::sys::net::sendto([file as u64,bytes.as_ptr()as u64,3,0,0,0]),-88,"a true socket-only operation on a file still fails");
 assert_eq!(std::fs::read(data.join("new-file")).unwrap(),b"ok");
 assert_eq!(super::close([file as u64,0,0,0,0,0]),0);drop(retained);
 assert_eq!(super::close([sockets[1]as u64,0,0,0,0,0]),0);
 let readonly=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,0,0,0,0]);assert!(readonly>=0);
 assert_eq!(super::write([readonly as u64,b"no".as_ptr()as u64,2,0,0,0]),-9);assert_eq!(super::close([readonly as u64,0,0,0,0,0]),0);

 // Fresh socket and socketpair creation must discard old file path/access facts.
 let stale=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,2,0,0,0]);assert!(stale>=0);assert_eq!(unsafe{libc::close(stale as i32)},0);
 let socket=crate::sys::net::socket([1,2,0,0,0,0]);assert_eq!(socket,stale);assert!(fdtab::opened_path(socket as i32).is_none());assert_eq!(super::close([socket as u64,0,0,0,0,0]),0);
 let a=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,2,0,0,0]);let b=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,2,0,0,0]);assert!(a>=0&&b>=0);unsafe{libc::close(a as i32);libc::close(b as i32);}
 let mut pair=[-1i32;2];assert_eq!(crate::sys::net::socketpair([1,1,0,pair.as_mut_ptr()as u64,0,0]),0);assert_eq!(pair,[a as i32,b as i32]);for fd in pair{assert!(fdtab::opened_path(fd).is_none());assert_eq!(super::close([fd as u64,0,0,0,0,0]),0);}
 // Original bind/listen/connect/accept, reusing a stale path-bearing file slot.
 let listener=crate::sys::net::socket([1,1,0,0,0,0]);let client=crate::sys::net::socket([1,1,0,0,0,0]);assert!(listener>=0&&client>=0);
 let mut address=vec![1u8,0];address.extend_from_slice(b"/data/generation.sock\0");
 assert_eq!(crate::sys::net::bind([listener as u64,address.as_ptr()as u64,address.len()as u64,0,0,0]),0);assert_eq!(crate::sys::net::listen([listener as u64,1,0,0,0,0]),0);assert_eq!(crate::sys::net::connect([client as u64,address.as_ptr()as u64,address.len()as u64,0,0,0]),0);
 let stale=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,2,0,0,0]);assert!(stale>=0);assert_eq!(unsafe{libc::close(stale as i32)},0);
 let accepted=crate::sys::net::accept4([listener as u64,0,0,0,0,0]);assert_eq!(accepted,stale);assert!(fdtab::opened_path(accepted as i32).is_none());
 assert_eq!(super::write([accepted as u64,b"a".as_ptr()as u64,1,0,0,0]),1);let mut byte=0u8;assert_eq!(super::read([client as u64,&mut byte as*mut _ as u64,1,0,0,0]),1);assert_eq!(byte,b'a');for fd in [listener,client,accepted]{assert_eq!(super::close([fd as u64,0,0,0,0,0]),0);}
 // Dup keeps the source description while retiring the target's previous Kind.
 let source=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,2,0,0,0]);let stale=crate::sys::net::socket([1,2,0,0,0,0]);assert!(source>=0&&stale>=0);assert_eq!(unsafe{libc::close(stale as i32)},0);
 let duplicate=super::dup([source as u64,0,0,0,0,0]);assert_eq!(duplicate,stale);assert!(!matches!(fdtab::get(duplicate as i32),Some(Kind::Sock(_))));assert_eq!(super::write([duplicate as u64,b"d".as_ptr()as u64,1,0,0,0]),1);for fd in [source,duplicate]{assert_eq!(super::close([fd as u64,0,0,0,0,0]),0);}
 // Original SCM_RIGHTS receive/adoption must not reuse a retired socket Kind.
 let mut pair=[-1i32;2];assert_eq!(crate::sys::net::socketpair([1,2,0,pair.as_mut_ptr()as u64,0,0]),0);
 let source=super::openat([crate::vfs::LINUX_AT_FDCWD as u64,path.as_ptr()as u64,2,0,0,0]);assert!(source>=0);
 #[repr(C)]struct Message{name:u64,namelen:u32,pad:u32,iov:u64,iovlen:u64,control:u64,controllen:u64,flags:i32,pad2:u32}
 let mut byte=[7u8];let iov=libc::iovec{iov_base:byte.as_mut_ptr().cast(),iov_len:1};let mut rights=[0u8;24];rights[..8].copy_from_slice(&20u64.to_ne_bytes());rights[8..12].copy_from_slice(&1u32.to_ne_bytes());rights[12..16].copy_from_slice(&1u32.to_ne_bytes());rights[16..20].copy_from_slice(&(source as i32).to_ne_bytes());
 let send=Message{name:0,namelen:0,pad:0,iov:&iov as*const _ as u64,iovlen:1,control:rights.as_ptr()as u64,controllen:24,flags:0,pad2:0};assert_eq!(crate::sys::net::sendmsg([pair[0]as u64,&send as*const _ as u64,0,0,0,0]),1);
 let stale=crate::sys::net::socket([1,2,0,0,0,0]);assert!(stale>=0);assert_eq!(unsafe{libc::close(stale as i32)},0);
 let mut control=[0u8;128];let mut received=Message{name:0,namelen:0,pad:0,iov:&iov as*const _ as u64,iovlen:1,control:control.as_mut_ptr()as u64,controllen:128,flags:0,pad2:0};assert_eq!(crate::sys::net::recvmsg([pair[1]as u64,&mut received as*mut _ as u64,0,0,0,0]),1);
 let fd=i32::from_ne_bytes(control[16..20].try_into().unwrap());assert_eq!(fd,stale as i32);assert!(!matches!(fdtab::get(fd),Some(Kind::Sock(_))));assert_eq!(super::write([fd as u64,b"r".as_ptr()as u64,1,0,0,0]),1);for fd in [pair[0],pair[1],source as i32,fd]{assert_eq!(super::close([fd as u64,0,0,0,0,0]),0);}
 eprintln!("PASS fresh descriptor generation preserves regular bytes, old socket pin, socket guard and access modes");
}
