//! The GM8 global ten-place highscore table. Games may query/draw it themselves;
//! these operations do not substitute for the still unsupported legacy dialogs.
use serde::{Deserialize, Serialize};
use std::{fs, io, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};

#[derive(Clone, Serialize, Deserialize)]
struct Entry { name: Vec<u8>, score: f64 }
#[derive(Serialize, Deserialize)]
struct Table { entries: Vec<Entry> }
impl Default for Table {
    fn default() -> Self { Self { entries: (0..10).map(|_| Entry { name: b"<nobody>".to_vec(), score: 0.0 }).collect() } }
}
impl Table {
    fn valid(&self) -> bool {
        self.entries.len() == 10 && self.entries.iter().all(|entry| entry.name.len() <= 4096 && entry.score.is_finite() && entry.score >= 0.0)
            && self.entries.windows(2).all(|pair| pair[0].score >= pair[1].score)
    }
    fn insert(&mut self, name: &[u8], score: f64) -> io::Result<bool> {
        if !score.is_finite() || name.len() > 4096 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Highscore name or score exceeds the native table limits")) }
        let Some(position) = self.entries.iter().position(|entry| score > entry.score) else { return Ok(false) };
        self.entries.insert(position, Entry { name: name.to_vec(), score }); self.entries.truncate(10); Ok(true)
    }
    fn entry(&self, place: i32) -> Option<&Entry> { place.checked_sub(1).and_then(|index|usize::try_from(index).ok()).and_then(|index| self.entries.get(index)) }
    fn load(path: &Path) -> io::Result<Self> {
        if !path.exists() { return Ok(Self::default()) }
        if fs::metadata(path)?.len() > 128 * 1024 { return Err(io::Error::new(io::ErrorKind::InvalidData, "Native highscore table is too large")) }
        let table: Self = serde_json::from_slice(&fs::read(path)?).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if !table.valid() { return Err(io::Error::new(io::ErrorKind::InvalidData, "Native highscore table is invalid")) }
        Ok(table)
    }
    fn save(&self, path: &Path) -> io::Result<()> {
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        let bytes = serde_json::to_vec(self).map_err(io::Error::other)?;
        fs::write(&temporary, bytes)?; fs::rename(temporary, path)
    }
}
struct State { table: Table, path: PathBuf }
static STATE: OnceLock<Result<Mutex<State>, String>> = OnceLock::new();
fn state() -> Result<&'static Mutex<State>, String> {
    STATE.get_or_init(|| {
        let path = crate::maclauncher_paths::write_path(".maclauncher-highscores.json", false).map_err(|error|error.to_string())?;
        let table = Table::load(&path).map_err(|error|error.to_string())?;
        Ok(Mutex::new(State { table, path }))
    }).as_ref().map_err(Clone::clone)
}
pub fn value(place: i32) -> Result<f64, String> {
    Ok(state()?.lock().map_err(|_| "Native highscore table is unavailable")?.table.entry(place).map(|entry|entry.score).unwrap_or(0.0))
}
pub fn name(place: i32) -> Result<Vec<u8>, String> {
    Ok(state()?.lock().map_err(|_| "Native highscore table is unavailable")?.table.entry(place).map(|entry|entry.name.clone()).unwrap_or_default())
}
pub fn clear() -> Result<(), String> {
    let mut state = state()?.lock().map_err(|_| "Native highscore table is unavailable")?;
    let table = Table::default(); table.save(&state.path).map_err(|error|error.to_string())?; state.table = table; Ok(())
}
pub fn add(name: &[u8], score: f64) -> Result<(), String> {
    let mut state = state()?.lock().map_err(|_| "Native highscore table is unavailable")?;
    let mut table = Table { entries: state.table.entries.clone() };
    if table.insert(name, score).map_err(|error|error.to_string())? { table.save(&state.path).map_err(|error|error.to_string())?; state.table = table; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranking_ties_capacity_roundtrip_and_clear() {
        let mut table = Table::default(); assert_eq!(table.entry(1).unwrap().score, 0.0);
        assert!(!table.insert(b"zero", 0.0).unwrap());
        for score in 1..=12 { assert!(table.insert(format!("player{score}").as_bytes(), score as f64).unwrap()) }
        assert_eq!(table.entry(1).unwrap().name, b"player12"); assert_eq!(table.entry(10).unwrap().score, 3.0);
        assert!(table.insert(b"tie", 12.0).unwrap()); assert_eq!(table.entry(2).unwrap().name, b"tie");
        assert!(table.entry(0).is_none()); assert!(table.entry(11).is_none()); assert!(!table.insert(b"negative", -1.0).unwrap());
        assert!(table.insert(b"bad", f64::NAN).is_err()); assert!(table.insert(&vec![0;4097], 13.0).is_err());
        let path = std::env::temp_dir().join(format!("opengmk-highscores-{}.json", std::process::id()));
        table.save(&path).unwrap(); let loaded = Table::load(&path).unwrap(); assert_eq!(loaded.entry(2).unwrap().name, b"tie");
        Table::default().save(&path).unwrap(); assert_eq!(Table::load(&path).unwrap().entry(10).unwrap().score, 0.0); fs::remove_file(path).unwrap();
    }
    #[test]
    fn invalid_persisted_table_is_an_error() {
        let path = std::env::temp_dir().join(format!("opengmk-invalid-highscores-{}.json", std::process::id()));
        fs::write(&path, br#"{"entries":[]}"#).unwrap(); assert!(Table::load(&path).is_err()); fs::remove_file(path).unwrap();
    }
}
