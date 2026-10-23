// SPDX-License-Identifier: AGPL-3.0-or-later
// Separate ReMinori companion process; never linked into the launcher.
use eden_formats::{decode, FileRangeSource, PazIndex, ResourceKind, ScriptIr, PAZ_HEADER_LEN};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
const INDEX_LIMIT: usize = 4 * 1024 * 1024;
const ENTRY_LIMIT: usize = 8 * 1024 * 1024;
fn quoted(value: &str) -> String {
    let mut result = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => result.push_str("\\\""), '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"), '\r' => result.push_str("\\r"), '\t' => result.push_str("\\t"),
            value if value < ' ' => result.push_str(&format!("\\u{:04x}", value as u32)),
            value => result.push(value),
        }
    }
    result.push('"'); result
}
fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 1024 && !name.chars().any(|value| value < ' ' || value == ':') &&
        !name.starts_with(['/', '\\']) && name.replace('\\', "/").split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}
fn open_index(path: &Path, slot: usize, key: u8) -> anyhow::Result<(FileRangeSource, PazIndex)> {
    let source = FileRangeSource::open(path)?;
    anyhow::ensure!(source.len() >= PAZ_HEADER_LEN as u64 && source.len() <= 64 * 1024 * 1024 * 1024, "PAZ size is unsupported");
    let header = PazIndex::parse_header(&source.read_range(0, PAZ_HEADER_LEN)?, key)?;
    anyhow::ensure!((4..=INDEX_LIMIT).contains(&(header.index_size as usize)), "PAZ index exceeds its limit");
    let index = PazIndex::parse_index(header.clone(), &source.read_range(PAZ_HEADER_LEN as u64, header.index_size as usize)?, slot, slot == 9)?;
    anyhow::ensure!(!index.entries.is_empty() && index.entries.len() <= 50000, "PAZ entry count exceeds its limit");
    let mut names = HashSet::new();
    for entry in &index.entries {
        anyhow::ensure!(safe_name(&entry.name) && names.insert(entry.name.to_lowercase()), "PAZ contains an unsafe or ambiguous entry");
        anyhow::ensure!(entry.offset64() >= PAZ_HEADER_LEN as u64 + header.index_size as u64, "PAZ entry overlaps its index");
        index.entry_read_len(entry, source.len())?;
    }
    Ok((source, index))
}
fn decoded(source: &FileRangeSource, index: &PazIndex, name: &str) -> anyhow::Result<Vec<u8>> {
    let entry = index.find(name).ok_or_else(|| anyhow::anyhow!("Missing PAZ resource: {name}"))?;
    let length = index.entry_read_len(entry, source.len())?;
    anyhow::ensure!(entry.size as usize <= ENTRY_LIMIT && length <= ENTRY_LIMIT, "PAZ resource exceeds its limit");
    let mut bytes = source.read_range(entry.offset64(), length)?;
    let mut bytes = index.decode_entry(entry, &mut bytes)?;
    if let Some(kind) = ResourceKind::from_name(&entry.name).filter(|_| entry.method == 0 || eden_formats::paz::profile::id() == "paz-bf-slot0-rc4-v1") { decode(&entry.name, entry.size, kind, &mut bytes); }
    anyhow::ensure!(bytes.len() == entry.size as usize, "PAZ decoded size differs from its index");
    Ok(bytes)
}
fn detect_profile(root: &Path) -> anyhow::Result<(FileRangeSource, PazIndex, u8)> {
    // Probe only supported Blowfish key material. Header gates limit the XOR
    // search to candidates with a bounded index, rather than brute-forcing data.
    let script = eden_formats::paz::archive_path(root, "scr")?;
    let source = FileRangeSource::open(&script)?; let header = source.read_range(0, PAZ_HEADER_LEN)?;
    let mut matched = None;
    for key in 0..=255u8 {
        let Ok(parsed) = PazIndex::parse_header(&header, key) else { continue; };
        if !(4..=INDEX_LIMIT).contains(&(parsed.index_size as usize)) || parsed.index_size as u64 + PAZ_HEADER_LEN as u64 > source.len() { continue; }
        let Ok((reader, index)) = open_index(&script, 0, key) else { continue; };
        let Ok(boot) = decoded(&reader, &index, "a001.sc") else { continue; };
        let text = eden_formats::encoding::cp932_to_string(&boot);
        if !text.starts_with('.') || text.contains('\u{fffd}') { continue; }
        let stats = ScriptIr::parse(&text).stats();
        if stats.command_lines == 0 || stats.structured == 0 { continue; }
        anyhow::ensure!(matched.is_none(), "PAZ crypto profile is ambiguous");
        matched = Some((reader, index, key));
    }
    matched.ok_or_else(|| anyhow::anyhow!("PAZ data does not match the supported Blowfish/RC4 script profile"))
}
fn inspect(root: &Path) -> anyhow::Result<()> {
    let (reader, scripts, key) = detect_profile(root)?;
    let boot = decoded(&reader, &scripts, "a001.sc")?;
    let stats = ScriptIr::parse(&eden_formats::encoding::cp932_to_string(&boot)).stats();
    let mut archives = Vec::new();
    for (group, slot) in [("scr", 0), ("bg", 1), ("st", 3), ("sys", 4), ("bgm", 5), ("voice", 6), ("se", 7), ("mov", 9)] {
        let path = match eden_formats::paz::archive_path(root, group) {
            Ok(path) => path,
            Err(eden_formats::PazError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let (source, index) = open_index(&path, slot, key)?;
        let sample = index.entries.iter().find(|entry| entry.size as usize <= ENTRY_LIMIT &&
            matches!(ResourceKind::from_name(&entry.name), Some(ResourceKind::Image | ResourceKind::Audio)));
        if let Some(entry) = sample {
            let bytes = decoded(&source, &index, &entry.name)?;
            anyhow::ensure!(bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"OggS"), "PAZ resource crypto profile differs for {group}");
        }
        archives.push(format!("{{\"group\":{},\"entries\":{},\"bytes\":{},\"prefix\":{},\"sampleValidated\":{}}}", quoted(group), index.entries.len(), source.len(), quoted(&index.prefix), sample.is_some()));
    }
    anyhow::ensure!(archives.iter().any(|item| item.starts_with("{\"group\":\"sys\"")), "Missing system PAZ archive");
    println!("{{\"schema\":1,\"profile\":{},\"xorKey\":{},\"bootScript\":\"a001.sc\",\"scriptCount\":{},\"bootCommands\":{},\"bootStructured\":{},\"archives\":[{}]}}",
        quoted(eden_formats::paz::profile::id()), key, scripts.entries.iter().filter(|entry| entry.name.to_lowercase().ends_with(".sc")).count(), stats.command_lines, stats.structured, archives.join(","));
    Ok(())
}
fn scripts(root: &Path, destination: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(destination.is_absolute() && !destination.exists(), "Choose a new absolute private script output directory");
    let (reader, index, _) = detect_profile(root)?;
    let entries: Vec<_> = index.entries.iter().filter(|entry| entry.name.to_lowercase().ends_with(".sc")).collect();
    let total: u64 = entries.iter().map(|entry| entry.size as u64).sum();
    anyhow::ensure!(total <= 128 * 1024 * 1024, "Script extraction exceeds its total limit");
    std::fs::create_dir(destination)?;
    for entry in &entries {
        let bytes = decoded(&reader, &index, &entry.name)?;
        let text = eden_formats::encoding::cp932_to_string(&bytes);
        let output = destination.join(entry.name.replace('\\', "/")).with_extension("txt");
        std::fs::create_dir_all(output.parent().unwrap())?;
        std::fs::write(output, text)?;
    }
    println!("{{\"schema\":1,\"count\":{},\"bytes\":{},\"encoding\":\"UTF-8\"}}", entries.len(), total); Ok(())
}
fn main() -> anyhow::Result<()> {
    eden_formats::paz::profile::initialize()?;
    let mut args = std::env::args().skip(1); let mode = args.next().unwrap_or_default();
    let root = PathBuf::from(args.next().ok_or_else(|| anyhow::anyhow!("Choose an original PAZ game directory"))?);
    match mode.as_str() {
        "inspect" if args.next().is_none() => inspect(&root),
        "scripts" => { let out = PathBuf::from(args.next().ok_or_else(|| anyhow::anyhow!("Choose a private output directory"))?); anyhow::ensure!(args.next().is_none(), "Unexpected tool arguments"); scripts(&root, &out) },
        _ => anyhow::bail!("Usage: maclauncher-minori-probe inspect ROOT | scripts ROOT NEW_OUTPUT"),
    }
}
