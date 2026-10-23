//! Explicit clipboard transfer through the launcher's gesture broker.
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

const LIMIT: u64 = 1024 * 1024;

fn request(operation: &str, text: Option<&str>) -> Option<serde_json::Value> {
    let socket = std::env::var_os("MACLAUNCHER_CLIPBOARD_SOCKET")?;
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut message = serde_json::json!({"operation": operation});
    if let Some(text) = text { message["text"] = serde_json::Value::String(text.into()); }
    let mut bytes = serde_json::to_vec(&message).ok()?;
    if bytes.len() as u64 >= LIMIT { return None; }
    bytes.push(b'\n');
    stream.write_all(&bytes).ok()?;
    let mut reply = Vec::new();
    BufReader::new(stream.take(LIMIT + 1)).read_until(b'\n', &mut reply).ok()?;
    if reply.len() as u64 > LIMIT || reply.last() != Some(&b'\n') { return None; }
    let value: serde_json::Value = serde_json::from_slice(&reply).ok()?;
    (value.get("allowed")?.as_bool()? == true).then_some(value)
}

pub fn paste() -> Option<String> {
    request("paste", None)?.get("text")?.as_str().map(String::from)
}

pub fn copy(text: &str) {
    let _ = request("copy", Some(text));
}
