use super::*;

struct Child(i32);
impl Drop for Child {
    fn drop(&mut self) {
        let mut status = 0;
        if unsafe { libc::waitpid(self.0, &mut status, libc::WNOHANG) } == 0 {
            unsafe { libc::kill(self.0, libc::SIGKILL); libc::waitpid(self.0, &mut status, 0); }
        }
    }
}

#[test]
fn unreaped_zombie_is_ended_while_live_and_stale_births_remain_distinct() {
    let mut pipe = [-1; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        unsafe {
            libc::close(pipe[1]);
            let mut byte = 0u8;
            libc::read(pipe[0], (&mut byte as *mut u8).cast(), 1);
            libc::_exit(0);
        }
    }
    let _child = Child(pid);
    unsafe { libc::close(pipe[0]); }
    let birth = ProcessIdentity::running_strict(pid).unwrap();
    assert_eq!(same_birth(birth), Ok(true));
    assert!(!all_ended(&[birth]).unwrap());
    let mut stale = birth;
    stale.start_microseconds += 1;
    assert_eq!(same_birth(stale), Ok(false));
    assert_eq!(signal_owned(stale, libc::SIGKILL), Ok(()));
    assert_eq!(same_birth(birth), Ok(true), "a stale birth cannot signal the live child");

    let directory = std::env::temp_dir().join(format!("aim-resident-liveness-{}", std::process::id()));
    let files = Files::of(&directory.join("data")).unwrap();
    fs::create_dir_all(files.by_pid()).unwrap();
    let record = files.by_pid().join(format!("{pid}.mount-namespace"));
    let binding = |identity: ProcessIdentity| format!("AIMPROCNS1\t{}\t{}\t{}\tfixture\n",
        identity.host_pid, identity.start_seconds, identity.start_microseconds);
    fs::write(&record, binding(birth)).unwrap();
    assert!(verify_registered_workers_ended(&files).unwrap_err().starts_with("registered worker still live:"));
    fs::write(&record, binding(stale)).unwrap();
    assert_eq!(verify_registered_workers_ended(&files), Ok(()));
    assert_eq!(same_birth(birth), Ok(true));
    fs::write(&record, binding(birth)).unwrap();

    assert_eq!(unsafe { libc::write(pipe[1], b"x".as_ptr().cast(), 1) }, 1);
    unsafe { libc::close(pipe[1]); }
    let mut ended: libc::siginfo_t = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::waitid(libc::P_PID, pid as _, &mut ended, libc::WEXITED | libc::WNOWAIT) }, 0);
    let info = process_info(pid).unwrap().expect("the unreaped child retains kernel metadata");
    assert_eq!(info.pbi_status, libc::SZOMB);
    assert_eq!(info_identity(&info), birth, "a zombie retains the same exact kernel birth");
    assert!(!birth.is_live(), "the original shared process identity already treats zombies as ended");
    assert_eq!(same_birth(birth), Ok(false), "an exited zombie cannot keep a resident run live");
    assert!(all_ended(&[birth]).unwrap());
    assert_eq!(verify_registered_workers_ended(&files), Ok(()));
    fs::write(&record, "invalid registry binding\n").unwrap();
    assert_eq!(verify_registered_workers_ended(&files), Err("invalid worker registry binding".into()));
    fs::remove_dir_all(directory).unwrap();
    println!("actual resident: live birth retained, stale birth cannot signal, unreaped SZOMB ended, registry errors retained");
}

fn registry_binding(identity: ProcessIdentity) -> String {
    format!("AIMPROCNS1\t{}\t{}\t{}\tfixture\n",identity.host_pid,identity.start_seconds,identity.start_microseconds)
}

#[test]
fn registered_worker_can_end_after_its_real_guest_parent_was_reaped() {
    let mut gate=[-1;2];let mut identity=[-1;2];
    assert_eq!(unsafe{libc::pipe(gate.as_mut_ptr())},0);assert_eq!(unsafe{libc::pipe(identity.as_mut_ptr())},0);
    let guest=unsafe{libc::fork()};assert!(guest>=0);
    if guest==0 {unsafe{
        libc::close(identity[0]);libc::close(gate[1]);let worker=libc::fork();
        if worker<0 {libc::_exit(91);}
        if worker==0 {libc::close(identity[1]);let mut byte=0u8;libc::read(gate[0],(&mut byte as*mut u8).cast(),1);libc::_exit(0);}
        libc::close(gate[0]);libc::write(identity[1],(&worker as*const i32).cast(),std::mem::size_of::<i32>());libc::_exit(0);
    }}
    unsafe{libc::close(identity[1]);libc::close(gate[0]);}
    let mut worker=0i32;assert_eq!(unsafe{libc::read(identity[0],(&mut worker as*mut i32).cast(),std::mem::size_of::<i32>())},std::mem::size_of::<i32>()as isize);unsafe{libc::close(identity[0]);}
    let birth=ProcessIdentity::running_strict(worker).unwrap();let mut status=0;assert_eq!(unsafe{libc::waitpid(guest,&mut status,0)},guest);assert_eq!(status,0);
    let directory=std::env::temp_dir().join(format!("aim-resident-drain-{}",std::process::id()));let files=Files::of(&directory.join("data")).unwrap();fs::create_dir_all(files.by_pid()).unwrap();fs::write(files.by_pid().join(format!("{worker}.mount-namespace")),registry_binding(birth)).unwrap();
    assert!(verify_registered_workers_ended(&files).unwrap_err().starts_with("registered worker still live:"));
    let writer=std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(70));unsafe{libc::write(gate[1],b"x".as_ptr().cast(),1);libc::close(gate[1]);}});
    let started=Instant::now();assert_eq!(wait_registered_workers_ended(&files,started+Duration::from_secs(1)),Ok(()));writer.join().unwrap();assert!(started.elapsed()>=Duration::from_millis(50));assert!(!same_birth(birth).unwrap());fs::remove_dir_all(directory).unwrap();
    println!("actual resident drain: real guest reaped first; exact registered worker exits later; observed without signals");
}

#[test]
fn drain_deadline_and_registry_failures_preserve_live_and_reused_births() {
    let mut gate=[-1;2];assert_eq!(unsafe{libc::pipe(gate.as_mut_ptr())},0);let pid=unsafe{libc::fork()};assert!(pid>=0);
    if pid==0 {unsafe{libc::close(gate[1]);let mut byte=0u8;libc::read(gate[0],(&mut byte as*mut u8).cast(),1);libc::_exit(0);}}
    let _child=Child(pid);unsafe{libc::close(gate[0]);}let birth=ProcessIdentity::running_strict(pid).unwrap();
    let directory=std::env::temp_dir().join(format!("aim-resident-drain-errors-{}",std::process::id()));let files=Files::of(&directory.join("data")).unwrap();fs::create_dir_all(files.by_pid()).unwrap();let record=files.by_pid().join(format!("{pid}.mount-namespace"));fs::write(&record,registry_binding(birth)).unwrap();
    let expected=verify_registered_workers_ended(&files).unwrap_err();let started=Instant::now();assert_eq!(wait_registered_workers_ended(&files,started+Duration::from_millis(50)),Err(expected));assert!(started.elapsed()>=Duration::from_millis(40));assert!(same_birth(birth).unwrap(),"past-deadline worker remains live; registry never signals");
    fs::write(&record,"invalid registry binding\n").unwrap();let started=Instant::now();assert_eq!(wait_registered_workers_ended(&files,started+Duration::from_secs(2)),Err("invalid worker registry binding".into()));assert!(started.elapsed()<Duration::from_millis(500),"malformed metadata is not retried until the deadline");assert!(same_birth(birth).unwrap());
    let mut reused=birth;reused.start_microseconds+=1;fs::write(&record,registry_binding(reused)).unwrap();assert_eq!(wait_registered_workers_ended(&files,Instant::now()+Duration::from_secs(1)),Ok(()));assert!(same_birth(birth).unwrap(),"stale record grants no authority over the actual live incarnation");
    unsafe{libc::write(gate[1],b"x".as_ptr().cast(),1);libc::close(gate[1]);}fs::remove_dir_all(directory).unwrap();
    println!("actual resident drain: live deadline keeps error; malformed registry fails immediately; reused birth remains untouched");
}
