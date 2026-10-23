use super::*;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
fn u32_at(bytes: &[u8], offset: usize) -> u32 { u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()) }
fn u64_at(bytes: &[u8], offset: usize) -> u64 { u64::from_le_bytes(bytes[offset..offset+8].try_into().unwrap()) }
pub(super) fn decode(path: &Path, cancel: &AtomicBool, audio_stream: &MovieAudioStream,
    event_tx: &mpsc::Sender<DecoderEvent>, frame_tx: &mpsc::SyncSender<DecodedFrame>) -> Result<(), String> {
    let decoder = std::env::var_os("MACLAUNCHER_MINORI_MOVIE_DECODER").map(std::path::PathBuf::from)
        .ok_or("The selected Minori distribution has no movie decoder")?;
    if !decoder.is_absolute() { return Err("Minori movie decoder must be an absolute reviewed path".into()); }
    let mut child = Command::new(decoder).arg(path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|error| format!("Start Minori movie decoder: {error}"))?;
    let mut output = child.stdout.take().ok_or("Minori decoder has no output pipe")?;
    let child = Arc::new(Mutex::new(child));
    let child_watch = Arc::clone(&child);
    let done = AtomicBool::new(false);
    let result = thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Acquire) {
                if cancel.load(Ordering::Acquire) {
                    if let Ok(mut child) = child_watch.lock() { let _ = child.kill(); }
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        let result = (|| {
            let mut header = [0u8; 24]; output.read_exact(&mut header).map_err(|error| format!("Read movie header: {error}"))?;
            if &header[..8] != b"MLMV1\0\0\0" { return Err("Minori movie protocol differs from its profile".into()); }
            let width = u32_at(&header, 8); let height = u32_at(&header, 12); let rate = u32_at(&header, 16);
            if width == 0 || height == 0 || width > 8192 || height > 8192 || u64::from(width) * u64::from(height) * 4 > 64 * 1024 * 1024 || ![0, 48000].contains(&rate) { return Err("Minori movie header exceeds its bounds".into()); }
            if rate > 0 { audio_stream.configure(rate); }
            event_tx.send(DecoderEvent::Ready { width, height, audio: (rate > 0).then_some(AudioFormat { channels: 2, sample_rate: rate }) }).map_err(|_| "Movie host closed")?;
            loop {
                if cancel.load(Ordering::Acquire) { return Ok(()); }
                let mut header = [0u8; 32]; output.read_exact(&mut header).map_err(|error| format!("Read movie packet: {error}"))?;
                let kind = u32_at(&header, 0); let size = u32_at(&header, 4) as usize;
                let pts = Duration::from_nanos(u64_at(&header, 8)); let end_pts = Duration::from_nanos(u64_at(&header, 16));
                let width = u32_at(&header, 24); let height = u32_at(&header, 28);
                if end_pts < pts || end_pts > Duration::from_secs(24 * 60 * 60) { return Err("Movie timestamps exceed their bounds".into()); }
                match kind {
                    1 => {
                        if width == 0 || height == 0 || width > 8192 || height > 8192 || size > 64 * 1024 * 1024 || size as u64 != u64::from(width) * u64::from(height) * 4 { return Err("Invalid movie video packet".into()); }
                        let mut bytes = vec![0u8; size]; output.read_exact(&mut bytes).map_err(|error| error.to_string())?;
                        let mut frame = DecodedFrame { pts, end_pts, width, height, pixels: MoviePixels::Bgra8(Arc::new(bytes)) };
                        loop {
                            if cancel.load(Ordering::Acquire) { return Ok(()); }
                            match frame_tx.try_send(frame) {
                                Ok(()) => break,
                                Err(mpsc::TrySendError::Full(value)) => { frame = value; thread::sleep(Duration::from_millis(5)); },
                                Err(mpsc::TrySendError::Disconnected(_)) => return Ok(()),
                            }
                        }
                    },
                    2 => {
                        if rate == 0 || size == 0 || size > 256 * 1024 || size % 8 != 0 || width != 0 || height != 0 { return Err("Invalid movie audio packet".into()); }
                        let mut bytes = vec![0u8; size]; output.read_exact(&mut bytes).map_err(|error| error.to_string())?;
                        let samples: Vec<f32> = bytes.chunks_exact(4).map(|value| f32::from_le_bytes(value.try_into().unwrap())).collect();
                        if samples.iter().any(|value| !value.is_finite()) { return Err("Invalid decoded movie audio samples".into()); }
                        if !audio_stream.push_stereo(&samples, cancel) { return Ok(()); }
                    },
                    3 if size == 0 => { audio_stream.finish(); let _ = event_tx.send(DecoderEvent::Finished { end_pts }); return Ok(()); },
                    _ => return Err("Unknown Minori movie protocol packet".into()),
                }
            }
        })();
        done.store(true, Ordering::Release); result
    });
    let mut child = child.lock().map_err(|_| "Movie process lock poisoned")?;
    if result.is_err() || cancel.load(Ordering::Acquire) { let _ = child.kill(); }
    let status = child.wait().map_err(|error| error.to_string())?;
    if cancel.load(Ordering::Acquire) { return Ok(()); }
    if !status.success() { return Err(format!("Minori movie decoder exited with {status}")); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decode_real_native_movie_fixture_without_window_or_audio_device() {
        let Some(file) = std::env::var_os("MACLAUNCHER_MINORI_TEST_MOVIE") else { return; };
        let cancel = AtomicBool::new(false); let audio = MovieAudioStream::new();
        let (events, received) = mpsc::channel(); let (frames, decoded) = mpsc::sync_channel(4);
        let count = thread::scope(|scope| {
            let handle = scope.spawn(|| decode(Path::new(&file), &cancel, &audio, &events, &frames));
            let mut count = 0;
            loop {
                match decoded.recv_timeout(Duration::from_millis(20)) {
                    Ok(frame) => { assert_eq!(frame.width, 64); assert_eq!(frame.height, 48); assert!(frame.end_pts >= frame.pts); count += 1; },
                    Err(mpsc::RecvTimeoutError::Timeout) => { if handle.is_finished() { break; } },
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            handle.join().unwrap().unwrap(); count
        });
        assert_eq!(count, 10); assert!(audio.available_frames() > 40000);
        let values: Vec<_> = received.try_iter().collect();
        assert!(matches!(values.first(), Some(DecoderEvent::Ready { audio: Some(_), .. })));
        assert!(matches!(values.last(), Some(DecoderEvent::Finished { .. })));
    }
}
