//! Native SuperSound string ABI using the pinned CoreAudio/udon output and
//! lewton Vorbis decoder. No Windows code is loaded or silently substituted.
use super::dll;
use std::{collections::BTreeMap, io::Cursor, sync::{Arc, Mutex, mpsc}, time::Duration};
use udon::{source::{Source, ChannelCount, SampleRate, Sample}, wav::WavPlayer, session::{Api, Session}};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PCM_SAMPLES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_SAMPLES: usize = 64 * 1024 * 1024;
const MAX_HANDLES: usize = 1024;

#[derive(Clone, Copy)]
pub enum Function { Init, Unload, Load, Free, Play, Loop, Stop, Pause, Resume, Playing, Paused, Looping,
    SetFrequency, Frequency, SetPan, Pan, SetVolume, Volume, SetPosition, Position, Length, BytesPerSecond }
impl Function {
    pub fn from_symbol(symbol: &str) -> Option<(Self, usize)> {
        Self::functions().into_iter().find(|(name, _, _)|*name == symbol).map(|(_, function, arguments)|(function, arguments))
    }
    pub fn functions() -> Vec<(&'static str, Self, usize)> {
        vec![
            ("SS_Init",Self::Init,0),("SS_Unload",Self::Unload,0),("SS_LoadSound",Self::Load,2),
            ("SS_FreeSound",Self::Free,1),("SS_PlaySound",Self::Play,1),("SS_LoopSound",Self::Loop,1),
            ("SS_StopSound",Self::Stop,1),("SS_PauseSound",Self::Pause,1),("SS_ResumeSound",Self::Resume,1),
            ("SS_IsSoundPlaying",Self::Playing,1),("SS_IsSoundPaused",Self::Paused,1),("SS_IsSoundLooping",Self::Looping,1),
            ("SS_SetSoundFreq",Self::SetFrequency,2),("SS_GetSoundFreq",Self::Frequency,1),
            ("SS_SetSoundPan",Self::SetPan,2),("SS_GetSoundPan",Self::Pan,1),
            ("SS_SetSoundVol",Self::SetVolume,2),("SS_GetSoundVol",Self::Volume,1),
            ("SS_SetSoundPosition",Self::SetPosition,2),("SS_GetSoundPosition",Self::Position,1),
            ("SS_GetSoundLength",Self::Length,1),("SS_GetSoundBytesPerSecond",Self::BytesPerSecond,1),
        ]
    }

}

struct Sound {
    pcm: Vec<f32>, channels: usize, sample_rate: u32, bytes_per_frame: usize,
    position: f64, frequency: u32, volume: i32, pan: i32, playing: bool, paused: bool, looping: bool,
}
impl Sound {
    fn frames(&self) -> usize { self.pcm.len() / self.channels }
    fn length(&self) -> usize { self.frames() * self.bytes_per_frame }
}
#[derive(Default)]
struct State { sounds: BTreeMap<u64, Sound>, next_id: u64, shutdown: bool }
struct Mixer { state: Arc<Mutex<State>>, channels: ChannelCount, rate: SampleRate,
    ready: Option<mpsc::SyncSender<Result<(), String>>> }
impl Source for Mixer {
    fn channel_count(&self) -> ChannelCount { self.channels }
    fn sample_rate(&self) -> SampleRate { self.rate }
    fn reset(&mut self) {}
    fn write_samples(&mut self, output: &mut [Sample]) -> usize {
        if let Some(sender) = self.ready.take() { let _ = sender.try_send(Ok(())); }
        output.fill(0.0);
        let Ok(mut state) = self.state.lock() else { return 0 };
        if state.shutdown { return 0 }
        let output_channels = self.channels.get() as usize;
        for sound in state.sounds.values_mut() {
            if !sound.playing || sound.paused || sound.frames() == 0 { continue }
            let gain = if sound.volume <= -10000 { 0.0 } else { 10.0f32.powf(sound.volume as f32 / 2000.0) };
            let left_gain = gain * if sound.pan > 0 { 10.0f32.powf(-(sound.pan as f32) / 2000.0) } else { 1.0 };
            let right_gain = gain * if sound.pan < 0 { 10.0f32.powf(sound.pan as f32 / 2000.0) } else { 1.0 };
            for frame in output.chunks_exact_mut(output_channels) {
                if sound.position >= sound.frames() as f64 {
                    if sound.looping { sound.position %= sound.frames() as f64; }
                    else { sound.playing = false; break }
                }
                let index = sound.position.floor() as usize;
                let next = if index + 1 < sound.frames() { index + 1 } else if sound.looping { 0 } else { index };
                let fraction = sound.position.fract() as f32;
                let sample = |channel: usize| {
                    let channel = channel.min(sound.channels - 1);
                    let first = sound.pcm[index * sound.channels + channel];
                    first + (sound.pcm[next * sound.channels + channel] - first) * fraction
                };
                let left = sample(0) * left_gain;
                let right = sample(1) * right_gain;
                if output_channels == 1 { frame[0] += (left + right) * 0.5; }
                else { frame[0] += left; frame[1] += right; }
                sound.position += sound.frequency as f64 / self.rate.get() as f64;
                if sound.position >= sound.frames() as f64 {
                    if sound.looping { sound.position %= sound.frames() as f64; }
                    else { sound.position = sound.frames() as f64; sound.playing = false; }
                }
            }
        }
        for sample in output.iter_mut() { *sample = sample.clamp(-1.0, 1.0); }
        output.len()
    }
}

fn decode(bytes: Vec<u8>) -> Result<Sound, String> {
    let (pcm, channels, sample_rate, sample_bytes) = if bytes.starts_with(b"OggS") {
        let mut stream = lewton::inside_ogg::OggStreamReader::new(Cursor::new(bytes)).map_err(|error|error.to_string())?;
        let channels = stream.ident_hdr.audio_channels as usize;
        let rate = stream.ident_hdr.audio_sample_rate;
        if channels == 0 || channels > 2 || rate == 0 { return Err("Only mono/stereo Vorbis audio is supported".into()) }
        let mut samples = Vec::new();
        while let Some(packet) = stream.read_dec_packet_itl().map_err(|error|error.to_string())? {
            if samples.len() + packet.len() > MAX_PCM_SAMPLES { return Err("Decoded Vorbis audio exceeds its memory limit".into()) }
            samples.extend(packet.into_iter().map(|sample|sample as f32 / 32768.0));
        }
        (samples, channels, rate, 2)
    } else {
        let mut sample_bytes = None;
        if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" { return Err("Expected a RIFF WAV or Ogg Vorbis file".into()) }
        let mut offset: usize = 12;
        while offset + 8 <= bytes.len() {
            let length = u32::from_le_bytes(bytes[offset+4..offset+8].try_into().unwrap()) as usize;
            if length > bytes.len() - offset - 8 { return Err("Truncated WAV chunk".into()) }
            if &bytes[offset..offset+4] == b"fmt " && length >= 16 {
                sample_bytes = Some(u16::from_le_bytes(bytes[offset+22..offset+24].try_into().unwrap()) as usize / 8);
            }
            offset = offset.checked_add(8 + length + (length & 1)).ok_or("WAV chunk overflow")?;
        }
        let mut wave = WavPlayer::new(bytes).map_err(|error|format!("WAV decoding failed: {error:?}"))?;
        let channels = wave.channel_count().get() as usize;
        let rate = wave.sample_rate().get();
        if channels == 0 || channels > 2 || wave.length() > MAX_PCM_SAMPLES { return Err("WAV channels or decoded length exceed the native audio limits".into()) }
        let mut samples = vec![0.0; wave.length()];
        if wave.write_samples(&mut samples) != samples.len() { return Err("Truncated WAV samples".into()) }
        (samples, channels, rate, sample_bytes.filter(|size|(1..=4).contains(size)).ok_or("Invalid WAV bit depth")?)
    };
    if pcm.is_empty() || pcm.len() % channels != 0 { return Err("Audio contains no complete sample frames".into()) }
    Ok(Sound { pcm, channels, sample_rate, bytes_per_frame: channels * sample_bytes, position: 0.0,
        frequency: sample_rate, volume: 0, pan: 0, playing: false, paused: false, looping: false })
}

pub struct Audio { state: Arc<Mutex<State>>, initialized: bool }
impl Audio {
    pub fn new() -> Self { Self { state: Arc::new(Mutex::new(State::default())), initialized: false } }
    fn initialize(&mut self) -> bool {
        if self.initialized { return true }
        self.state = Arc::new(Mutex::new(State::default()));
        let state = self.state.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(|| {
                let session = Session::new(Api::SoundIo).map_err(|error|format!("{error:?}"))?;
                let device = session.default_output_device().map_err(|error|format!("{error:?}"))?;
                let channels = device.channel_count();
                let rate = device.sample_rate();
                let stream = session.open_output_stream(device).map_err(|error|format!("{error:?}"))?;
                let mixer = Mixer { state, channels, rate, ready: Some(sender.clone()) };
                stream.play(mixer).map_err(|error|format!("{error:?}"))
            });
            if !matches!(result, Ok(Ok(()))) { let _ = sender.try_send(Err("Native CoreAudio output failed".to_string())); }
        });
        self.initialized = matches!(receiver.recv_timeout(Duration::from_secs(5)), Ok(Ok(())));
        self.initialized
    }
    pub fn call(&mut self, function: Function, args: &[dll::Value]) -> dll::Value {
        fn text(value: Option<&dll::Value>) -> Option<String> {
            match value? { dll::Value::Str(value) => std::str::from_utf8(value.as_slice()).ok().map(str::to_owned), _ => None }
        }
        let result = match function {
            Function::Init => if self.initialize() { "Yes".into() } else { "No".into() },
            Function::Unload => { if let Ok(mut state) = self.state.lock() { state.shutdown = true; state.sounds.clear(); } self.initialized = false; "1".into() },
            Function::Load => {
                let loaded: Result<String, String> = (|| {
                    if !self.initialized { return Err("SuperSound has not been initialized".into()) }
                    let name = text(args.first()).ok_or("Audio filename must be a UTF-8 string")?;
                    let streaming = text(args.get(1)).ok_or("Invalid stream mode")?.parse::<u8>().map_err(|_|"Invalid stream mode")?;
                    if streaming > 1 { return Err("Stream mode must be 0 or 1".into()) }
                    let file = crate::maclauncher_paths::read_path(&name);
                    let metadata = std::fs::metadata(&file).map_err(|error|error.to_string())?;
                    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES { return Err("Audio input exceeds the native decoding limit".into()) }
                    let sound = decode(std::fs::read(file).map_err(|error|error.to_string())?)?;
                    let mut state = self.state.lock().map_err(|_|"Native audio state failed")?;
                    if state.sounds.len() >= MAX_HANDLES || state.sounds.values().map(|sound|sound.pcm.len()).sum::<usize>() + sound.pcm.len() > MAX_TOTAL_SAMPLES { return Err("Native audio handle or memory limit exceeded".into()) }
                    state.next_id = state.next_id.checked_add(1).ok_or("Audio handles exhausted")?;
                    let id = state.next_id; state.sounds.insert(id, sound); Ok(id.to_string())
                })();
                match loaded { Ok(id) => id, Err(error) => { eprintln!("Native SuperSound load failed: {error}"); "0".into() } }
            },
            Function::Free => {
                let id = text(args.first()).and_then(|value|value.parse::<u64>().ok());
                if id.is_some_and(|id|self.state.lock().is_ok_and(|mut state|state.sounds.remove(&id).is_some())) { "1".into() } else { "0".into() }
            },
            _ => {
                let id = text(args.first()).and_then(|value|value.parse::<u64>().ok());
                let numeric = text(args.get(1)).and_then(|value|value.parse::<f64>().ok()).filter(|value|value.is_finite());
                match self.state.lock() {
                    Ok(mut state) => match id.and_then(|id|state.sounds.get_mut(&id)) {
                        Some(sound) => match function {
                            Function::Play | Function::Loop => { sound.position = 0.0; sound.playing = true; sound.paused = false; sound.looping = matches!(function, Function::Loop); "1".into() },
                            Function::Stop => { sound.playing = false; sound.paused = false; sound.position = 0.0; "1".into() },
                            Function::Pause => { sound.paused = sound.playing; "1".into() },
                            Function::Resume => { sound.playing = true; sound.paused = false; if sound.position >= sound.frames() as f64 { sound.position = 0.0; } "1".into() },
                            Function::Playing => (sound.playing && !sound.paused).then_some("1").unwrap_or("0").into(),
                            Function::Paused => sound.paused.then_some("1").unwrap_or("0").into(),
                            Function::Looping => (sound.playing && sound.looping).then_some("1").unwrap_or("0").into(),
                            Function::SetFrequency => if let Some(value) = numeric.filter(|value|(1000.0..=100000.0).contains(value)) { sound.frequency = value as u32; "1".into() } else { "0".into() },
                            Function::Frequency => sound.frequency.to_string(),
                            Function::SetPan => if let Some(value) = numeric.filter(|value|(-10000.0..=10000.0).contains(value)) { sound.pan = value as i32; "1".into() } else { "0".into() },
                            Function::Pan => sound.pan.to_string(),
                            Function::SetVolume => if let Some(value) = numeric.filter(|value|(-10000.0..=0.0).contains(value)) { sound.volume = value as i32; "1".into() } else { "0".into() },
                            Function::Volume => sound.volume.to_string(),
                            Function::SetPosition => if let Some(value) = numeric.filter(|value|*value >= 0.0 && *value <= sound.length() as f64) { sound.position = (value as usize / sound.bytes_per_frame) as f64; "1".into() } else { "0".into() },
                            Function::Position => (sound.position.floor().min(sound.frames() as f64) as usize * sound.bytes_per_frame).to_string(),
                            Function::Length => sound.length().to_string(),
                            Function::BytesPerSecond => (sound.sample_rate as usize * sound.bytes_per_frame).to_string(),
                            _ => unreachable!(),
                        },
                        None => "-1".into(),
                    },
                    Err(_) => "-1".into(),
                }
            },
        };
        dll::Value::Str(dll::PascalString::new(result.as_bytes()))
    }
}
impl Drop for Audio { fn drop(&mut self) { if let Ok(mut state) = self.state.lock() { state.shutdown = true; state.sounds.clear(); } } }

#[cfg(test)]
mod tests {
    use super::*;
    fn string(value: &str) -> dll::Value { dll::Value::Str(dll::PascalString::new(value.as_bytes())) }
    fn result(audio: &mut Audio, function: Function, args: &[&str]) -> String {
        let value = audio.call(function, &args.iter().map(|value|string(value)).collect::<Vec<_>>());
        match value { dll::Value::Str(value) => String::from_utf8(value.as_slice().to_vec()).unwrap(), _ => panic!("SuperSound must return an owned string") }
    }
    fn wave() -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0".to_vec();
        bytes.extend_from_slice(&2000u32.to_le_bytes()); bytes.extend_from_slice(&4000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes()); bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data"); bytes.extend_from_slice(&8u32.to_le_bytes());
        for sample in [16384i16, 8192, -8192, -16384] { bytes.extend_from_slice(&sample.to_le_bytes()); }
        let length = bytes.len() as u32 - 8; bytes[4..8].copy_from_slice(&length.to_le_bytes()); bytes
    }
    fn samples(actual: &[f32], expected: &[f32]) {
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) { assert!((actual - expected).abs() < 0.0001, "Decoded PCM differs: {actual} vs {expected}"); }
    }
    #[test]
    fn decoded_pcm_moves_real_audio_and_control_queries_follow_the_stream() {
        let sound = decode(wave()).unwrap();
        assert_eq!(sound.length(), 8); assert_eq!(sound.sample_rate, 2000);
        let mut audio = Audio::new(); audio.state.lock().unwrap().sounds.insert(1, sound);
        let mut mixer = Mixer { state: audio.state.clone(), channels: ChannelCount::new(2).unwrap(), rate: SampleRate::new(2000).unwrap(), ready: None };
        assert_eq!(result(&mut audio, Function::Loop, &["1"]), "1");
        let mut output = [0.0; 4]; assert_eq!(mixer.write_samples(&mut output), 4);
        samples(&output, &[0.5, 0.5, 0.25, 0.25]);
        assert_eq!(result(&mut audio, Function::Position, &["1"]), "4");
        assert_eq!(result(&mut audio, Function::BytesPerSecond, &["1"]), "4000");
        assert_eq!(result(&mut audio, Function::Pause, &["1"]), "1"); mixer.write_samples(&mut output);
        assert_eq!(output, [0.0; 4]); assert_eq!(result(&mut audio, Function::Position, &["1"]), "4");
        assert_eq!(result(&mut audio, Function::Paused, &["1"]), "1");
        result(&mut audio, Function::Resume, &["1"]); mixer.write_samples(&mut output);
        samples(&output, &[-0.25, -0.25, -0.5, -0.5]);
        assert_eq!(result(&mut audio, Function::Position, &["1"]), "0");
        result(&mut audio, Function::SetPan, &["1", "10000"]); mixer.write_samples(&mut output);
        assert!(output[0] < 0.00001); samples(&[output[1]], &[0.5]);
        result(&mut audio, Function::SetVolume, &["1", "-6000"]);
        assert_eq!(result(&mut audio, Function::Volume, &["1"]), "-6000");
        assert_eq!(result(&mut audio, Function::SetFrequency, &["1", "200000"]), "0");
        assert_eq!(result(&mut audio, Function::Free, &["1"]), "1");
        assert_eq!(result(&mut audio, Function::Playing, &["1"]), "-1");
        mixer.write_samples(&mut output); assert_eq!(output, [0.0; 4]);
    }
    #[test]
    fn invalid_or_truncated_audio_fails_without_a_success_handle() {
        assert!(decode(Vec::new()).is_err()); assert!(decode(b"OggSbad stream".to_vec()).is_err());
        let mut broken = wave(); broken.truncate(45); assert!(decode(broken).is_err());
        let mut audio = Audio::new(); assert_eq!(result(&mut audio, Function::Load, &["absent.wav", "0"]), "0");
    }
}
