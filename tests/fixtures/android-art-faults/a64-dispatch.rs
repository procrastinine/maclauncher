use std::ffi::c_void;
use aim_linux_abi::{context,sys};
#[repr(C)]struct State{x:[u64;31],sp:u64,pc:u64,v:[[u64;2];32],tls:u64,tls_ro:u64,pstate:u32,fpcr:u32,fpsr:u32}
#[repr(C)]#[derive(Clone,Copy)]struct Memory{owner:*mut c_void,read:unsafe extern "C" fn(*mut c_void,u64,*mut c_void,usize,i32)->i32,write:unsafe extern "C" fn(*mut c_void,u64,*const c_void,usize)->i32,exclusive:*const c_void,counter:*const c_void}
#[repr(C)]struct Config{memory:Memory,ctr:u32,frequency:u32,dczid:u32,direct:i32}
#[repr(C)]#[derive(Debug)]struct Exit{kind:u32,detail:u32,address:u64,error:i32}
unsafe extern "C"{fn kl_a64_create(config:Config)->*mut c_void;fn kl_a64_destroy(cpu:*mut c_void);fn kl_a64_run(cpu:*mut c_void,state:*mut State,budget:u64)->Exit;}
unsafe extern "C" fn read(_: *mut c_void,address:u64,out:*mut c_void,len:usize,_:i32)->i32{unsafe{std::ptr::copy_nonoverlapping(address as*const u8,out.cast(),len);}0}
unsafe extern "C" fn write(_: *mut c_void,address:u64,input:*const c_void,len:usize)->i32{unsafe{std::ptr::copy_nonoverlapping(input.cast::<u8>(),address as*mut u8,len);}0}
fn main(){unsafe{
 let source:[u32;7]=[0xd2801588,0xd4000001,0xd2801528,0xd4000001,0xd28030e8,0xd4000001,0x14000000]; // getpid172, gettimeofday169, unknown391
 let original=source.to_vec();let page=original.as_ptr();
 let config=Config{memory:Memory{owner:std::ptr::null_mut(),read,write,exclusive:std::ptr::null(),counter:std::ptr::null()},ctr:0x8444c004,frequency:1_000_000_000,dczid:4,direct:1};let cpu=kl_a64_create(config);assert!(!cpu.is_null());
 let mut state:State=std::mem::zeroed();state.pc=page as u64;state.tls=0x11223344;
 let ctx=&mut *context::init_thread();let mut tv=[0i64;2];
 for turn in 0..3{
  if turn==1{state.x[0]=tv.as_mut_ptr()as u64;state.x[1]=0;}
  let result=kl_a64_run(cpu,&mut state,1000);assert_eq!(result.kind,1,"{result:?}");assert_eq!(result.detail,0);
  ctx.x=state.x;ctx.sp=state.sp;ctx.pc=state.pc;ctx.stub_ret=0;ctx.nzcv=state.pstate as u64;ctx.fpcr=state.fpcr as u64;ctx.fpsr=state.fpsr as u64;
  for i in 0..32{ctx.v[i]=(state.v[i][0]as u128)|((state.v[i][1]as u128)<<64);}
  let nr=ctx.x[8];sys::dispatch(ctx);state.x=ctx.x;
  println!("original AIM syscall={nr} result={} next_pc={:#x}",state.x[0]as i64,state.pc);
  match turn{0=>assert!(state.x[0]as i64>0),1=>assert_eq!(state.x[0],0),_=>assert_eq!(state.x[0]as i64,-38)}
 }
 assert!(tv[0]>0);assert_eq!(std::slice::from_raw_parts(page,source.len()),source);kl_a64_destroy(cpu);println!("PASS original A64 SVC state invokes original AIM Linux dispatcher, preserves errno and continuation without source rewriting");
}}
