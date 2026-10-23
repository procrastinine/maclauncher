// The test inserts the unmodified original/adapted startup block. AppKit and
// Metal are replaced only at the render boundary; the listener is a real socket.
#![allow(dead_code)]
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone)] struct Target;
impl Target {fn new(_:usize,_:Option<()>)->Self {Self}}
#[derive(Default)] struct Connect {display:u32,width:u32,height:u32,dpi_x_milli:u32,dpi_y_milli:u32,mode:u32,vsync_period_ns:u64}
struct Window {layer:Option<usize>,number:Option<u32>,width:u32,height:u32,dpi_x:f64,dpi_y:f64}
struct State {started:AtomicBool,released:Mutex<bool>,wake:Condvar,blank:AtomicUsize,frames:AtomicUsize,early:bool}
struct Renderer(Arc<State>);
impl Renderer {
    fn present(&self,_:Option<()>,_:&[Target],_:Option<()>) {
        self.0.started.store(true,Ordering::Release);
        let mut released=self.0.released.lock().unwrap();
        while !*released {released=self.0.wake.wait(released).unwrap();}
        self.0.blank.fetch_add(1,Ordering::SeqCst);
    }
}
struct Display {renderer:Renderer,last:Mutex<Option<()>>,targets:Mutex<Vec<Target>>}
static DISPLAY:OnceLock<Display>=OnceLock::new();
impl Display {
    fn new(renderer:Renderer,_:Connect,_:u32,_:Option<PathBuf>)->Self {
        let early=renderer.0.early;
        if early {renderer.0.frames.fetch_add(1,Ordering::SeqCst);}
        Self {renderer,last:Mutex::new(early.then_some(())),targets:Mutex::new(Vec::new())}
    }
    fn set_targets(&self,targets:Vec<Target>){*self.targets.lock().unwrap()=targets;}
    fn on_vsync(&self,_:()){}
    fn serve(&self,mut socket:UnixStream) {
        let mut command=[0];socket.read_exact(&mut command).unwrap();
        if command[0]==b'F' {
            let mut last=self.last.lock().unwrap();
            *last=Some(());self.renderer.0.frames.fetch_add(1,Ordering::SeqCst);
        }
        socket.write_all(b"ready").unwrap();
    }
}
mod vsync {pub fn create(_:Box<dyn Fn(())+Send>)->Result<u64,String>{Ok(16_666_667)}}
mod input {
    pub fn start(_: &std::path::Path,_:&super::Window)->Result<(),String>{Ok(())}
    pub fn quit_on_signals(){}
}
mod metal {pub fn watch_screen(){}}
mod aim_host_display {
    pub mod input {pub fn device_dir(p:&std::path::Path)->std::path::PathBuf{p.into()}}
    pub mod unixsock {
        pub fn listen(p:&std::path::Path,_:i32)->std::io::Result<std::os::unix::net::UnixListener>{
            std::os::unix::net::UnixListener::bind(p)
        }
    }
}

fn start(socket:PathBuf,state:Arc<State>) {
    let renderer=Renderer(state);
    let win=Window {layer:Some(1),number:Some(1),width:1280,height:800,dpi_x:320.0,dpi_y:320.0};
    let display_mode=0;
    let capture=None;
/* ORIGINAL_STARTUP */
}

fn exchange(path:&PathBuf,command:u8)->bool {
    let Ok(mut socket)=UnixStream::connect(path)else{return false};
    socket.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
    socket.write_all(&[command]).unwrap();
    let mut answer=[0;5];socket.read_exact(&mut answer).is_ok()&&answer==*b"ready"
}

fn main() {
    let args:Vec<_>=std::env::args().collect();let mode=&args[1];let socket=PathBuf::from(&args[2]);
    let state=Arc::new(State {started:AtomicBool::new(false),released:Mutex::new(false),wake:Condvar::new(),blank:AtomicUsize::new(0),frames:AtomicUsize::new(0),early:mode=="early"});
    let worker={let socket=socket.clone();let state=state.clone();std::thread::spawn(move||start(socket,state))};
    let deadline=Instant::now()+Duration::from_secs(3);
    if mode=="early" {
        worker.join().unwrap();assert!(exchange(&socket,b'C'));
        assert_eq!(state.blank.load(Ordering::SeqCst),0,"Blank must not overwrite an already-presented real frame");
        assert_eq!(state.frames.load(Ordering::SeqCst),1);
        println!("early real-frame control: retained, no blank render");return;
    }
    while !state.started.load(Ordering::Acquire) {assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(1));}
    let ready=exchange(&socket,b'C');
    assert_eq!(ready,mode=="fixed","Readiness must be served while the render boundary is blocked");
    *state.released.lock().unwrap()=true;state.wake.notify_all();worker.join().unwrap();
    assert!(exchange(&socket,b'F'));assert_eq!(state.blank.load(Ordering::SeqCst),1);assert_eq!(state.frames.load(Ordering::SeqCst),1);
    println!("{mode}: blocked-render handshake={ready}; blank then real frame preserved");
}
