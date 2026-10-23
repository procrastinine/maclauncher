use aim_linux_abi::{context, sys, vfs};

fn call(number: u64, args: [u64; 6]) -> i64 {
    let current = context::current_ctx();
    unsafe {
        (&mut (*current).x)[..6].copy_from_slice(&args);
        (*current).x[8] = number;
        sys::dispatch(&mut *current);
        (*current).x[0] as i64
    }
}
struct Socket(i64);
impl Drop for Socket { fn drop(&mut self) { assert_eq!(call(57, [self.0 as u64,0,0,0,0,0]), 0); } }
fn socket(family: u64) -> Socket {
    let fd = call(198, [family,2,0,0,0,0]); assert!(fd >= 0); Socket(fd)
}
fn set(fd: &Socket, level: u64, option: u64, bytes: &[u8]) -> i64 {
    call(208, [fd.0 as u64,level,option,bytes.as_ptr() as u64,bytes.len() as u64,0])
}
fn get(fd: &Socket, level: u64, option: u64, capacity: u32) -> (Vec<u8>,u32) {
    let mut bytes = vec![0xcc;8]; let mut length=capacity;
    assert_eq!(call(209,[fd.0 as u64,level,option,bytes.as_mut_ptr() as u64,(&mut length as *mut u32) as u64,0]),0);
    (bytes,length)
}
fn scalar(fd: &Socket, level: u64, option: u64) -> i32 {
    let (bytes,length)=get(fd,level,option,4); assert_eq!(length,4);
    i32::from_ne_bytes(bytes[..4].try_into().unwrap())
}
fn integer(fd: &Socket, level: u64, option: u64, value: i32) -> i64 { set(fd,level,option,&value.to_ne_bytes()) }
fn ipv4_interface(group: [u8;4], address: [u8;4], index: Option<u32>) -> Vec<u8> {
    let mut bytes=[group,address].concat(); if let Some(index)=index { bytes.extend(index.to_ne_bytes()); } bytes
}
fn main() {
    let root=std::env::args().nth(1).unwrap();context::init_thread();vfs::init(std::path::Path::new(&root),None).unwrap();
    let v4=socket(2);
    // Original UDP initialization request: loopback off, TTL one.
    assert_eq!(integer(&v4,0,34,0),0);assert_eq!(integer(&v4,0,33,1),0);
    assert_eq!(scalar(&v4,0,34),0);assert_eq!(scalar(&v4,0,33),1);
    for value in [-1,2,255] { assert_eq!(integer(&v4,0,34,value),0);assert_eq!(scalar(&v4,0,34),1); }
    assert_eq!(set(&v4,0,33,&[255]),0);assert_eq!(scalar(&v4,0,33),255);
    assert_eq!(integer(&v4,0,33,-1),0);assert_eq!(scalar(&v4,0,33),1);
    for size in [1,2,3] { let(bytes,length)=get(&v4,0,33,size);assert_eq!(length,1);assert_eq!(bytes[0],1);assert!(bytes[1..].iter().all(|b|*b==0xcc)); }
    for value in [-2,256] { assert_eq!(integer(&v4,0,33,value),-22); }
    assert_eq!(set(&v4,0,33,&[]),-22);
    assert_eq!(call(208,[v4.0 as u64,0,34,0,4,0]),-14);
    assert_eq!(call(208,[v4.0 as u64,0,34,u64::MAX-31,4,0]),-14);
    let mut capacity=4u32;
    assert_eq!(call(209,[v4.0 as u64,0,33,0,(&mut capacity as *mut u32) as u64,0]),-14);
    assert_eq!(capacity,4);assert_eq!(scalar(&v4,0,33),1);
    let negative=(-1i32).to_ne_bytes();
    assert_eq!(call(209,[v4.0 as u64,0,33,0,negative.as_ptr() as u64,0]),-22);
    assert_eq!(set(&v4,0,32,&[127,0,0,1]),0);assert_eq!(&get(&v4,0,32,4).0[..4],&[127,0,0,1]);
    let explicit=ipv4_interface([0;4],[127,0,0,1],None);
    assert_eq!(set(&v4,0,32,&explicit),0);assert_eq!(&get(&v4,0,32,4).0[..4],&[127,0,0,1]);
    let indexed=ipv4_interface([0;4],[0;4],Some(1));
    assert_eq!(set(&v4,0,32,&indexed),0);assert_eq!(&get(&v4,0,32,4).0[..4],&[0;4]);
    let duplicate=call(23,[v4.0 as u64,0,0,0,0,0]);assert!(duplicate>=0);let duplicate=Socket(duplicate);
    assert_eq!(set(&duplicate,0,32,&explicit),0);assert_eq!(&get(&v4,0,32,4).0[..4],&[127,0,0,1]);drop(duplicate);
    let membership=ipv4_interface([239,255,19,19],[127,0,0,1],None);
    assert_eq!(set(&v4,0,35,&membership),0);assert_eq!(set(&v4,0,35,&membership),-98);
    assert_eq!(set(&v4,0,36,&membership),0);assert_eq!(set(&v4,0,36,&membership),-99);
    let indexed_membership=ipv4_interface([239,255,19,20],[0;4],Some(1));
    assert_eq!(set(&v4,0,35,&indexed_membership),0);assert_eq!(set(&v4,0,36,&indexed_membership),0);
    assert_eq!(set(&v4,0,32,&ipv4_interface([0;4],[0;4],Some(0x7fffffff))),-99);
    assert_eq!(set(&v4,0,35,&ipv4_interface([239,255,19,21],[0;4],Some(0x7fffffff))),-19);
    assert_eq!(set(&v4,0,35,&[0;7]),-22);assert_eq!(set(&v4,0,32,&[0;3]),-22);
    let v6=socket(10);
    for (option,value) in [(17,1),(18,7),(19,0)] { assert_eq!(integer(&v6,41,option,value),0);assert_eq!(scalar(&v6,41,option),value); }
    assert_eq!(integer(&v6,41,18,-1),0);assert_eq!(scalar(&v6,41,18),1);
    assert_eq!(integer(&v6,41,19,1),0);assert_eq!(scalar(&v6,41,19),1);
    assert_eq!(integer(&v6,41,19,2),-22);assert_eq!(integer(&v6,41,18,256),-22);
    assert_eq!(integer(&v6,41,17,0x7fffffff),-19);assert_eq!(set(&v6,41,19,&[1]),-22);
    let mut membership6=vec![0;20];membership6[0]=0xff;membership6[1]=2;membership6[15]=0x74;
    membership6[16..].copy_from_slice(&1u32.to_ne_bytes());
    let before=membership6.clone();assert_eq!(set(&v6,41,20,&membership6),0);assert_eq!(set(&v6,41,21,&membership6),0);assert_eq!(membership6,before);
    // Interface zero follows this socket's actual selected loopback route.
    membership6[16..].fill(0);assert_eq!(set(&v6,41,20,&membership6),0);assert_eq!(set(&v6,41,21,&membership6),0);
    assert_eq!(set(&v6,41,20,&[0;19]),-22);
    let duplicate6=call(23,[v6.0 as u64,0,0,0,0,0]);assert!(duplicate6>=0);let duplicate6=Socket(duplicate6);
    assert_eq!(integer(&duplicate6,41,17,0),0);assert_eq!(scalar(&v6,41,17),0);drop(duplicate6);
    let retired6=v6.0;drop(v6);let fresh6=socket(10);assert_eq!(fresh6.0,retired6);
    assert_eq!(scalar(&fresh6,41,17),0);assert_eq!(integer(&fresh6,41,17,1),0);assert_eq!(scalar(&fresh6,41,17),1);drop(fresh6);
    // A real unicast UDP exchange on loopback still uses the configured socket.
    let receiver=socket(2);let mut address=[0u8;16];address[..2].copy_from_slice(&2u16.to_ne_bytes());address[4..8].copy_from_slice(&[127,0,0,1]);
    assert_eq!(call(200,[receiver.0 as u64,address.as_ptr() as u64,16,0,0,0]),0);
    let mut length=16u32;assert_eq!(call(204,[receiver.0 as u64,address.as_mut_ptr() as u64,(&mut length as *mut u32) as u64,0,0,0]),0);
    let payload=b"loopback";assert_eq!(call(206,[v4.0 as u64,payload.as_ptr() as u64,payload.len() as u64,0,address.as_ptr() as u64,16]),payload.len() as i64);
    let mut output=[0u8;8];assert_eq!(call(207,[receiver.0 as u64,output.as_mut_ptr() as u64,8,0,0,0]),8);assert_eq!(&output,payload);
    assert_eq!(call(208,[u64::MAX,0,34,0,4,0]),-9);
    let retired=v4.0;drop(v4);let fresh=socket(2);assert_eq!(fresh.0,retired);assert_eq!(&get(&fresh,0,32,4).0[..4],&[0;4]);
    println!("PASS original Linux UDP multicast scalars, widths, interfaces, memberships, errors and real loopback delivery");
}
