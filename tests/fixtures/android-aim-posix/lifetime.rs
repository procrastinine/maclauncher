use std::{fs,io::{BufRead,BufReader,Write},os::{fd::AsFd,unix::process::CommandExt},path::{Path,PathBuf},process::{Child,Command,Stdio},sync::atomic::{AtomicBool,Ordering},thread,time::{Duration,Instant}};
use aim_storage::{inode_lease::Identity,posix_broker::{Config,Controller},posix_control::{Client,Frame,Operation,Owner,Range},process_namespace::ProcessIdentity};
static STOP:AtomicBool=AtomicBool::new(false);
extern "C" fn on_term(_:i32){STOP.store(true,Ordering::Release);}
fn wait_for(mut condition:impl FnMut()->bool){let deadline=Instant::now()+Duration::from_secs(5);while !condition(){assert!(Instant::now()<deadline,"bounded observation expired");thread::sleep(Duration::from_millis(5));}}
fn emit(text:&str){println!("{text}");std::io::stdout().flush().unwrap();}
fn controller(case:&str,root:&Path){
 unsafe{libc::signal(libc::SIGTERM,on_term as *const () as usize);}
 let process=ProcessIdentity::running(std::process::id()as i32).unwrap();
 let endpoint=format!("com.aim.posix-lifetime.{}.{}",process.host_pid,process.start_microseconds);
 let controller=Controller::start(Config {endpoint:endpoint.clone(),holder:PathBuf::from(std::env::var_os("AIM_PROBE_HELPER").unwrap()),startup_timeout:Duration::from_secs(3)}).unwrap();
 let holder=controller.register_guest(Owner {process,guest_pid:1}).unwrap();
 let file=fs::OpenOptions::new().read(true).write(true).create_new(true).open(root.join("locked-file")).unwrap();
 file.set_len(16).unwrap();
 let client=Client::lookup(&endpoint).unwrap();let mut register=Frame::new(Operation::Register,1);register.key=Identity::from_fd(file.as_fd()).unwrap().to_bytes();register.access=libc::O_RDWR;
 let registered=client.call(register,Some(file.as_fd())).unwrap();assert_eq!(registered.errno,0);
 let mut lock=Frame::new(Operation::Set,2);lock.ticket=registered.ticket;lock.range=Range {kind:1,start:0,len:8};assert_eq!(client.call(lock,None).unwrap().errno,0);
 emit(&format!("READY {} {} {} {} {} {}",process.host_pid,holder.host_pid,holder.start_seconds,holder.start_microseconds,unsafe{libc::getpgrp()},unsafe{libc::getpgid(holder.host_pid)}));
 if case=="same"||case=="isolated"{wait_for(||STOP.load(Ordering::Acquire));if case=="same"{wait_for(||!holder.is_live());}emit(&format!("AFTER_TERM holder_live={}",holder.is_live()));}
 wait_for(||root.join("finish").exists());
 let result=controller.shutdown();emit(&format!("SHUTDOWN errno={:?}",result.as_ref().err().and_then(|e|e.raw_os_error())));
 if case=="isolated"{assert!(result.is_ok(),"isolated holder must close normally: {result:?}");}else{assert_eq!(result.unwrap_err().raw_os_error(),Some(libc::ECHILD),"genuine nonzero holder remains an error");}
}
struct OwnerGuard {child:Child,holder:Option<ProcessIdentity>}
impl Drop for OwnerGuard{fn drop(&mut self){if self.child.try_wait().ok().flatten().is_none(){let _=self.child.kill();let _=self.child.wait();}if let Some(holder)=self.holder{let deadline=Instant::now()+Duration::from_secs(2);while holder.is_live()&&Instant::now()<deadline{thread::sleep(Duration::from_millis(5));}if holder.is_live(){unsafe{libc::kill(holder.host_pid,libc::SIGKILL);}}}}}
fn lock_owner(path:&Path)->Option<i32>{use std::os::fd::AsRawFd;let file=fs::OpenOptions::new().read(true).write(true).open(path).unwrap();let mut record:libc::flock=unsafe{std::mem::zeroed()};record.l_type=libc::F_WRLCK;record.l_whence=libc::SEEK_SET as i16;record.l_len=8;assert_eq!(unsafe{libc::fcntl(file.as_raw_fd(),libc::F_GETLK,&mut record)},0);(record.l_type!=libc::F_UNLCK).then_some(record.l_pid)}
fn run_case(case:&str,root:&Path,helper:&Path){
 fs::create_dir(root).unwrap();let mut command=Command::new(std::env::current_exe().unwrap());command.args(["controller",case,root.to_str().unwrap()]).env("AIM_PROBE_HELPER",helper).process_group(0).stdout(Stdio::piped());
 let mut owner=OwnerGuard {child:command.spawn().unwrap(),holder:None};let mut output=BufReader::new(owner.child.stdout.take().unwrap());let mut line=String::new();output.read_line(&mut line).unwrap();let fields:Vec<_>=line.split_whitespace().collect();assert_eq!(fields.first(),Some(&"READY"),"{line}");
 let controller_pid:i32=fields[1].parse().unwrap();assert_eq!(controller_pid,owner.child.id()as i32);let holder=ProcessIdentity {host_pid:fields[2].parse().unwrap(),start_seconds:fields[3].parse().unwrap(),start_microseconds:fields[4].parse().unwrap()};owner.holder=Some(holder);fs::write(root.join("owned"),format!("{} {} {} {} {} {}\n",controller_pid,ProcessIdentity::running(controller_pid).unwrap().start_seconds,ProcessIdentity::running(controller_pid).unwrap().start_microseconds,holder.host_pid,holder.start_seconds,holder.start_microseconds)).unwrap();let controller_group:i32=fields[5].parse().unwrap();let holder_group:i32=fields[6].parse().unwrap();assert_eq!(controller_group,controller_pid);assert_eq!(lock_owner(&root.join("locked-file")),Some(holder.host_pid));
 assert_eq!(controller_group==holder_group,case=="same");
 match case {
  "same"|"isolated"=>{assert_eq!(unsafe{libc::kill(-controller_pid,libc::SIGTERM)},0);line.clear();output.read_line(&mut line).unwrap();assert_eq!(line.trim(),format!("AFTER_TERM holder_live={}",case=="isolated"));if case=="isolated"{assert_eq!(lock_owner(&root.join("locked-file")),Some(holder.host_pid));}fs::write(root.join("finish"),b"1").unwrap();},
  "death"=>{let started=Instant::now();owner.child.kill().unwrap();owner.child.wait().unwrap();wait_for(||!holder.is_live());wait_for(||lock_owner(&root.join("locked-file")).is_none());println!("controller-death: controller={controller_pid} orphan_holder={} retired+real lock released in {}ms",holder.host_pid,started.elapsed().as_millis());return;},
  "bad"=>{assert_eq!(unsafe{libc::kill(holder.host_pid,libc::SIGKILL)},0);wait_for(||!holder.is_live());fs::write(root.join("finish"),b"1").unwrap();},_=>unreachable!()
 }
 line.clear();output.read_line(&mut line).unwrap();let status=owner.child.wait().unwrap();assert!(status.success(),"{case}: {status}");wait_for(||!holder.is_live());assert_eq!(lock_owner(&root.join("locked-file")),None);println!("{case}: {} controller={controller_pid} holder={} groups={controller_group}/{holder_group}; real lock released",line.trim(),holder.host_pid);
}
fn cleanup(root:&Path){
 for entry in fs::read_dir(root).unwrap(){let entry=entry.unwrap();if !entry.file_type().unwrap().is_dir(){continue;}let file=entry.path().join("owned");if !file.is_file(){continue;}let text=fs::read_to_string(file).unwrap();let n:Vec<u64>=text.split_whitespace().map(|v|v.parse().unwrap()).collect();assert_eq!(n.len(),6);
  for i in [0,3]{let identity=ProcessIdentity{host_pid:n[i]as i32,start_seconds:n[i+1],start_microseconds:n[i+2]};if identity.is_live(){unsafe{libc::kill(identity.host_pid,libc::SIGKILL);}}}
 }
}
fn main(){let args:Vec<_>=std::env::args().skip(1).collect();if args.first().map(String::as_str)==Some("cleanup"){cleanup(Path::new(&args[1]));return;}if args.first().map(String::as_str)==Some("controller"){controller(&args[1],Path::new(&args[2]));return;}let root=PathBuf::from(&args[0]);let helper=PathBuf::from(&args[1]);let cases: &[&str]=if args[2]=="original"{&["same"]}else{&["isolated","death","bad"]};for case in cases{run_case(case,&root.join(case),&helper);}println!("actual original controller+holder: group TERM conflict, graceful Exit, controller death, real lock release, nonzero failure controls passed");}
