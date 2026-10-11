// SPDX-License-Identifier: AGPL-3.0-or-later
// Read edition keys from original PE data. No executable code is run and no
// title, executable name, address, or game-specific key is embedded here.
use crate::paz_keys::{key_index, ARCHIVE_ORDER, DATA_KEYS_SLOT0, INDEX_KEYS_SLOT0};
use crate::resource::ResourceKind;
use std::path::Path;
use std::sync::OnceLock;
const MAX_PE: usize = 32 * 1024 * 1024;
const KEY_TABLE_BYTES: usize = 2 * 10 * 32;
struct Profile { index: [[u8; 32]; 10], data: [[u8; 32]; 10], passwords: [String; 4] }
impl Profile {
    fn resource_password(&self, kind: ResourceKind) -> &str {
        &self.passwords[match kind { ResourceKind::Script => 0, ResourceKind::Audio => 1, ResourceKind::Image => 2 }]
    }
}
struct Section { rva: u32, virtual_bytes: u32, offset: usize, bytes: usize, flags: u32 }
static PROFILE: OnceLock<Option<Profile>> = OnceLock::new();
fn word(bytes: &[u8], offset: usize) -> Option<u16> { Some(u16::from_le_bytes(bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?)) }
fn dword(bytes: &[u8], offset: usize) -> Option<u32> { Some(u32::from_le_bytes(bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?)) }
fn raw_address(sections: &[Section], base: u32, address: u32, length: usize) -> Option<usize> {
    let rva = address.checked_sub(base)?;
    sections.iter().filter(|section| section.flags & 0x4000_0000 != 0).find_map(|section| {
        let within = rva.checked_sub(section.rva)? as usize;
        (within.checked_add(length)? <= section.bytes).then(|| section.offset + within)
    })
}
fn writable_address(sections: &[Section], base: u32, address: u32, length: u32) -> bool {
    let Some(rva) = address.checked_sub(base) else { return false; };
    sections.iter().any(|section| section.flags & 0x8000_0000 != 0 && rva.checked_sub(section.rva)
        .and_then(|within| within.checked_add(length)).is_some_and(|end| end <= section.virtual_bytes.max(section.bytes as u32)))
}
fn parse(bytes: &[u8]) -> anyhow::Result<Option<Profile>> {
    anyhow::ensure!(bytes.len() <= MAX_PE && bytes.starts_with(b"MZ"), "Original Minori runner is not a bounded PE file");
    let pe = dword(bytes, 0x3c).ok_or_else(|| anyhow::anyhow!("Truncated PE header"))? as usize;
    anyhow::ensure!(bytes.get(pe..pe.saturating_add(4)) == Some(b"PE\0\0") && word(bytes, pe + 4) == Some(0x14c), "Minori edition extraction requires a PE32 x86 runner");
    let count = word(bytes, pe + 6).unwrap_or(0) as usize;
    let optional = word(bytes, pe + 20).unwrap_or(0) as usize;
    anyhow::ensure!((1..=96).contains(&count) && optional >= 96 && word(bytes, pe + 24) == Some(0x10b), "Unsupported PE layout");
    let base = dword(bytes, pe + 52).ok_or_else(|| anyhow::anyhow!("Truncated PE image base"))?;
    let start = pe.checked_add(24 + optional).ok_or_else(|| anyhow::anyhow!("PE section overflow"))?;
    let mut sections = Vec::new();
    for index in 0..count {
        let offset = start + index * 40;
        anyhow::ensure!(bytes.get(offset..offset + 40).is_some(), "Truncated PE section");
        let virtual_bytes = dword(bytes, offset + 8).ok_or_else(|| anyhow::anyhow!("Truncated PE section"))?;
        let rva = dword(bytes, offset + 12).unwrap(); let length = dword(bytes, offset + 16).unwrap() as usize;
        let raw = dword(bytes, offset + 20).unwrap() as usize; let flags = dword(bytes, offset + 36).ok_or_else(|| anyhow::anyhow!("Truncated PE section"))?;
        anyhow::ensure!(raw.checked_add(length).is_some_and(|end| end <= bytes.len()), "PE section exceeds its file");
        sections.push(Section { rva, virtual_bytes, offset: raw, bytes: length, flags });
    }
    let mut tables = Vec::new();
    for section in sections.iter().filter(|section| section.flags & 0x8000_0000 != 0 && section.flags & 0x2000_0000 == 0) {
        for within in (KEY_TABLE_BYTES..section.bytes.saturating_sub(39)).step_by(4) {
            let table = section.offset + within;
            let agrees = ARCHIVE_ORDER.iter().enumerate().all(|(index, name)| {
                let Some(address) = dword(bytes, table + index * 4) else { return false; };
                let Some(offset) = raw_address(&sections, base, address, name.len() + 1) else { return false; };
                bytes.get(offset..offset + name.len()) == Some(name.as_bytes()) && bytes[offset + name.len()] == 0
            });
            if agrees { tables.push(table - KEY_TABLE_BYTES); }
        }
    }
    if tables.is_empty() { return Ok(None); }
    anyhow::ensure!(tables.len() == 1, "Original Minori archive key tables are ambiguous");
    // This versioned compiler layout initializes script/audio/image/movie RC4
    // passwords with four contiguous stores. Other layouts remain unsupported.
    let mut passwords = Vec::new();
    for section in sections.iter().filter(|section| section.flags & 0x2000_0000 != 0) {
        for offset in section.offset..section.offset + section.bytes.saturating_sub(39) {
            if bytes.get(offset..offset + 2) != Some(&[0xc7, 0x05]) { continue; }
            let Some(destination) = dword(bytes, offset + 2) else { continue; };
            if destination % 4 != 0 || !writable_address(&sections, base, destination, 16) { continue; }
            let values: Option<Vec<String>> = (0..4).map(|index| {
                let instruction = offset + index * 10;
                if bytes.get(instruction..instruction + 2) != Some(&[0xc7, 0x05]) ||
                    dword(bytes, instruction + 2) != destination.checked_add(index as u32 * 4) { return None; }
                let address = dword(bytes, instruction + 6)?;
                let raw = raw_address(&sections, base, address, 9)?;
                let value = bytes.get(raw..raw + 8)?;
                if bytes[raw + 8] != 0 || !value.iter().all(u8::is_ascii_alphanumeric) { return None; }
                String::from_utf8(value.to_vec()).ok()
            }).collect();
            if let Some(values) = values {
                if values.iter().enumerate().any(|(i, value)| values[..i].contains(value)) { continue; }
                if !passwords.contains(&values) { passwords.push(values); }
            }
        }
    }
    anyhow::ensure!(passwords.len() == 1, "Original Minori resource password layout is missing or ambiguous");
    let start = tables[0];
    let index = std::array::from_fn(|slot| bytes[start + slot * 32..start + (slot + 1) * 32].try_into().unwrap());
    let data = std::array::from_fn(|slot| bytes[start + 320 + slot * 32..start + 320 + (slot + 1) * 32].try_into().unwrap());
    Ok(Some(Profile { index, data, passwords: passwords.pop().unwrap().try_into().unwrap() }))
}
pub fn initialize() -> anyhow::Result<()> {
    if PROFILE.get().is_some() { return Ok(()); }
    let profile = if let Some(file) = std::env::var_os("MACLAUNCHER_MINORI_ORIGINAL_RUNNER") {
        let file = Path::new(&file); let metadata = std::fs::symlink_metadata(file)?;
        anyhow::ensure!(file.is_absolute() && metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= MAX_PE as u64, "Original Minori runner path is invalid");
        parse(&std::fs::read(file)?)?
    } else { None };
    PROFILE.set(profile).map_err(|_| anyhow::anyhow!("Minori profile was initialized concurrently"))
}
pub fn id() -> &'static str { if PROFILE.get().is_some_and(Option::is_some) { "paz-pe-keytables-rc4-v1" } else { "paz-bf-slot0-rc4-v1" } }
pub fn index_key(slot: usize) -> [u8; 32] {
    PROFILE.get().and_then(Option::as_ref).map(|profile| profile.index[key_index(slot)]).unwrap_or(INDEX_KEYS_SLOT0[key_index(slot)])
}
pub fn data_key(slot: usize) -> [u8; 32] {
    PROFILE.get().and_then(Option::as_ref).map(|profile| profile.data[key_index(slot)]).unwrap_or(DATA_KEYS_SLOT0[key_index(slot)])
}
pub fn password(kind: ResourceKind) -> &'static str {
    if let Some(profile) = PROFILE.get().and_then(Option::as_ref) { return profile.resource_password(kind); }
    match kind { ResourceKind::Script => "N426Fd94", ResourceKind::Image => "p37j344s", ResourceKind::Audio => "ol0lOrAf" }
}
pub fn movie_password() -> &'static str {
    PROFILE.get().and_then(Option::as_ref).map(|profile| profile.passwords[3].as_str()).unwrap_or("Uyiu4Ruy")
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Vec<u8> {
        let mut bytes = vec![0; 4096]; bytes[..2].copy_from_slice(b"MZ"); bytes[0x3c..0x40].copy_from_slice(&128u32.to_le_bytes());
        bytes[128..132].copy_from_slice(b"PE\0\0"); bytes[132..134].copy_from_slice(&0x14cu16.to_le_bytes()); bytes[134..136].copy_from_slice(&3u16.to_le_bytes());
        bytes[148..150].copy_from_slice(&96u16.to_le_bytes()); bytes[152..154].copy_from_slice(&0x10bu16.to_le_bytes()); bytes[180..184].copy_from_slice(&0x400000u32.to_le_bytes());
        for (index, (offset, rva, length, flags)) in [(512u32, 0x1000u32, 512u32, 0x60000020u32), (1024, 0x2000, 512, 0x40000040), (1536, 0x3000, 2048, 0xc0000040)].into_iter().enumerate() {
            let at = 248 + index * 40;
            for (field, value) in [(8, length), (12, rva), (16, length), (20, offset), (36, flags)] { bytes[at + field..at + field + 4].copy_from_slice(&value.to_le_bytes()); }
        }
        let table = 1536 + KEY_TABLE_BYTES; let mut text = 1024;
        for (index, name) in ARCHIVE_ORDER.iter().enumerate() {
            bytes[text..text + name.len()].copy_from_slice(name.as_bytes());
            let address = 0x402000 + (text - 1024) as u32; bytes[table + index * 4..table + index * 4 + 4].copy_from_slice(&address.to_le_bytes()); text += name.len() + 1;
        }
        for (index, name) in ["Abc12345", "Def67890", "Ghi12345", "Jkl67890"].iter().enumerate() {
            bytes[text..text + 8].copy_from_slice(name.as_bytes()); let address = 0x402000 + (text - 1024) as u32;
            let at = 512 + index * 10; bytes[at..at + 2].copy_from_slice(&[0xc7, 0x05]); bytes[at + 2..at + 6].copy_from_slice(&(0x403500 + index as u32 * 4).to_le_bytes());
            bytes[at + 6..at + 10].copy_from_slice(&address.to_le_bytes()); text += 12;
        }
        for (index, byte) in bytes[1536..table].iter_mut().enumerate() { *byte = (index % 251) as u8; }
        bytes
    }
    #[test] fn extracts_structural_pe_keys_without_game_names_or_addresses() {
        let bytes = fixture(); let profile = parse(&bytes).unwrap().unwrap(); assert_eq!(profile.resource_password(ResourceKind::Script), "Abc12345"); assert_eq!(profile.resource_password(ResourceKind::Audio), "Def67890"); assert_eq!(profile.resource_password(ResourceKind::Image), "Ghi12345"); assert_eq!(profile.index[0][1], 1); assert_eq!(profile.data[0][0], (320 % 251) as u8);
        let mut different = bytes; different[248 + 40 + 20..248 + 40 + 24].copy_from_slice(&0xfffffff0u32.to_le_bytes()); assert!(parse(&different).is_err());
    }
    #[test] fn rejects_ambiguous_tables_and_missing_resource_layouts() {
        let mut bytes = fixture(); let table = 1536 + KEY_TABLE_BYTES; bytes.copy_within(table..table + 40, table + 64); assert!(parse(&bytes).is_err());
        let mut bytes = fixture(); bytes[512] = 0; assert!(parse(&bytes).is_err()); assert!(parse(b"MZ").is_err());
    }
}
