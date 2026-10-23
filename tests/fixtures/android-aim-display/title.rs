// The fixture inserts AIM's complete argument parser. Only the bundle lookup
// is supplied here; no AppKit application or display is created.
#![allow(unused_variables,unused_assignments,dead_code)]
use std::path::PathBuf;
const USAGE:&str="display argument fixture";
mod mode {pub const DEVICE:u32=0;pub const WINDOWS:u32=1;}
mod apps {pub fn set_dir(_: &std::path::Path){}}
mod shim {pub fn info(key:&str)->Option<String>{assert_eq!(key,"CFBundleDisplayName");std::env::var("AIM_TEST_BUNDLE_TITLE").ok()}}
fn parse_size(s:&str)->Option<(u32,u32)>{let(a,b)=s.split_once('x')?;Some((a.parse().ok()?,b.parse().ok()?))}
fn main(){
/* ORIGINAL_ARGUMENT_PARSER */
    println!("{title}");
}
