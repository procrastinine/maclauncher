const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REVISION = "79b00990324404bfbd496e7fa76c690cf040f744";
const VERSION = "0.1.0-79b0099-macos-v2";
const PROFILE = "paz-pe-keytables-native-macos-v2";
const ORIGINALS = Object.freeze({
  "crates/engine/src/video.rs": "8b1c2bdc1dc93a5d7eed5536434a4fbf2610ebe97c70ce37f79112a92b803d4e",
  "crates/game/src/platform_dispatcher.rs": "026026f12f4c7a6ad71013e11f2aa24c659a36dddfa466c0a6755996cf399d6e",
  "crates/game/src/input_adapter.rs": "14b256d85ab37015aa373ba092144c5883ce9a594674a70f280b8ca3eaf73a20",
  "crates/formats/src/paz.rs": "69ba981dc76005030a37b34d02ec32cd025f9ce75435d0415f18e90730ae07ef",
  "crates/formats/src/resource.rs": "35765620a5a1bb9734654d4a0964d6086ddd335a86db02813108e2ab7583f729",
  "crates/engine/src/font.rs": "284bc0a969c38ba14db2caf8848beb2d18b64d2306b72e358ff940b50d4de2f4",
  "crates/engine/src/engine.rs": "da35d60e5d77f9f14a9bdc0f31835eba52afbe2c5717621480dadea6de6481e3",
  "crates/engine/src/vfs.rs": "f16f563d360057d5a1fc1dd2cea45301079325e9f227ff576360d7d02085e7d7",
  "crates/game/src/main.rs": "b4321039a43819abe77093696d949e51b129f25e964e1c669dc9cfaf13c05341"
});
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function replace(text, before, after, file) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Pinned Minori source differs in ${file}.`);
  return text.replace(before, () => after);
}
function adaptSource(root) {
  if (!path.isAbsolute(root || "") || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() ||
      fs.realpathSync(root).split(path.sep).includes("external") || fs.existsSync(path.join(root, ".git"))) throw new Error("Minori overlays require a separate owned source export.");
  const outputs = ["crates/engine/src/maclauncher-font.rs", "crates/engine/src/maclauncher-video.rs",
    "crates/game/src/maclauncher-dispatcher.rs", "maclauncher-platform.m", "crates/formats/src/maclauncher-archive-path.rs", "crates/formats/src/maclauncher-pe-profile.rs", "crates/formats/src/bin/maclauncher-minori-probe.rs"];
  for (const file of [...Object.keys(ORIGINALS), ...outputs]) {
    const target = path.join(root, file);
    let current = path.dirname(target);
    while (current !== root) {
      if (fs.existsSync(current) && (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink())) throw new Error("Minori source export contains a linked directory.");
      current = path.dirname(current);
    }
    if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error("Minori source export contains a linked file.");
  }
  const changes = new Map();
  const update = (file, transform) => {
    const target = path.join(root, file), bytes = fs.readFileSync(target);
    if (ORIGINALS[file] && hash(bytes) !== ORIGINALS[file]) throw new Error(`Pinned Minori source hash differs in ${file}.`);
    changes.set(file, transform(bytes.toString("utf8"), file));
  };
  update("crates/engine/src/font.rs", (source, file) => {
    let text = replace(source, "use fontdue::Font;", 'use fontdue::Font;\n#[cfg(target_os = "macos")]\n#[path = "maclauncher-font.rs"]\nmod macos;', file);
    text = replace(text, "        #[cfg(not(windows))]\n        let _ = preferred;", '        #[cfg(target_os = "macos")]\n        {\n            let (font, faces, face) = macos::default_font(preferred)?;\n            return Ok(Self::new(font, faces, face));\n        }\n        #[cfg(all(not(windows), not(target_os = "macos")))]\n        let _ = preferred;', file);
    text = replace(text, "        #[cfg(not(windows))]\n        let faces = Vec::new();", '        #[cfg(target_os = "macos")]\n        let faces = macos::names();\n        #[cfg(all(not(windows), not(target_os = "macos")))]\n        let faces = Vec::new();', file);
    text = replace(text, '        #[cfg(not(windows))]\n        anyhow::bail!("运行平台不支持系统字体切换: {face}");\n        #[cfg(windows)]', '        #[cfg(target_os = "macos")]\n        let font = macos::load(face)?;\n        #[cfg(all(not(windows), not(target_os = "macos")))]\n        anyhow::bail!("运行平台不支持系统字体切换: {face}");\n        #[cfg(any(windows, target_os = "macos"))]', file);
    return text;
  });
  update("crates/engine/src/engine.rs", (text, file) => replace(text, "fn resolve_save_dir() -> PathBuf {", 'fn resolve_save_dir() -> PathBuf {\n    if let Some(value) = std::env::var_os("MACLAUNCHER_MINORI_SAVE_DIR") {\n        let dir = PathBuf::from(value);\n        assert!(dir.is_absolute(), "Minori save directory must be absolute");\n        std::fs::create_dir_all(&dir).expect("Cannot create Minori save directory");\n        assert!(probe_writable(&dir), "Minori save directory is not writable");\n        return dir;\n    }', file));
  update("crates/engine/src/vfs.rs", (source, file) => {
    let text = replace(source, 'let cache_root = dirs::cache_dir()\n                    .unwrap_or_else(std::env::temp_dir)\n                    .join("eden")\n                    .join("movies");', 'let cache_root = std::env::var_os("MACLAUNCHER_MINORI_CACHE_DIR")\n                    .map(PathBuf::from)\n                    .unwrap_or_else(|| dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("reminori"))\n                    .join("movies");\n                if !cache_root.is_absolute() { return Err("Minori movie cache must be absolute".into()); }', file);
    text = replace(text, "            xor_key: 0xAA,", '            xor_key: std::env::var("MACLAUNCHER_MINORI_PAZ_XOR")\n                .ok().and_then(|value| u8::from_str_radix(value.trim_start_matches("0x"), 16).ok()).unwrap_or(0xAA),', file);
    text = replace(text, 'let path = self.root.join(format!("{group}.paz"));', 'let path = eden_formats::paz::archive_path(&self.root, group).ok()?;', file);
    text = replace(text, '        if let Some(kind) = ResourceKind::from_name(&entry_name) {', '        if let Some(kind) = ResourceKind::from_name(&entry_name).filter(|_| entry.method == 0 || eden_formats::paz::profile::id() == "paz-bf-slot0-rc4-v1") {', file);
    return replace(text, 'archive: self.root.join("mov.paz"),', 'archive: eden_formats::paz::archive_path(&self.root, "mov").unwrap_or_else(|_| self.root.join("mov.paz")),', file);
  });
  update("crates/game/src/main.rs", (source, file) => {
    let text = replace(source, '.with_title("eden")', '.with_title(std::env::var("MACLAUNCHER_MINORI_TITLE").unwrap_or_else(|_| "Minori".into()))', file);
    text = replace(text, 'fn main() -> anyhow::Result<()> {\n    init_logging();', 'fn main() -> anyhow::Result<()> {\n    init_logging();\n    eden_formats::paz::profile::initialize()?;', file);
    return replace(text, 'if !game_root.join("scr.paz").is_file()', 'if eden_formats::paz::archive_path(&game_root, "scr").is_err()', file);
  });
  update("crates/engine/src/video.rs", (text, file) => replace(text, '#[cfg(not(windows))]\nmod platform {', '#[cfg(target_os = "macos")]\n#[path = "maclauncher-video.rs"]\nmod platform;\n#[cfg(all(not(windows), not(target_os = "macos")))]\nmod platform {', file));
  update("crates/game/src/platform_dispatcher.rs", (source, file) => {
    let text = replace(source, 'use winit::window::{Fullscreen, Window};', 'use winit::window::{Fullscreen, Window};\n#[cfg(target_os = "macos")]\n#[path = "maclauncher-dispatcher.rs"]\npub(crate) mod macos;', file);
    text = replace(text, '            #[cfg(not(windows))]\n            PlatformRequest::ShowContextMenu', '            #[cfg(target_os = "macos")]\n            PlatformRequest::SetPointerCapture { enabled } => {\n                use winit::window::CursorGrabMode;\n                let _ = window.set_cursor_grab(if enabled { CursorGrabMode::Locked } else { CursorGrabMode::None });\n            }\n            #[cfg(target_os = "macos")]\n            PlatformRequest::ShowContextMenu { request_id, state } => {\n                engine.platform_response(PlatformResponse::ContextMenuClosed { request_id, command: macos::context_menu(state) });\n            }\n            #[cfg(target_os = "macos")]\n            PlatformRequest::EditSaveComment { request_id, initial, max_chars } => {\n                engine.platform_response(PlatformResponse::SaveCommentClosed { request_id, comment: macos::comment(&initial, max_chars) });\n            }\n            #[cfg(target_os = "macos")]\n            PlatformRequest::OpenHelp => { log::info!("Game controls: click/Space to advance, right-click for the game menu, Escape to go back."); }\n            #[cfg(target_os = "macos")]\n            PlatformRequest::OpenUrl { url } => macos::open_url(&url),\n            #[cfg(all(not(windows), not(target_os = "macos")))]\n            PlatformRequest::ShowContextMenu', file);
    text = replace(text, '            #[cfg(not(windows))]\n            PlatformRequest::EditSaveComment', '            #[cfg(all(not(windows), not(target_os = "macos")))]\n            PlatformRequest::EditSaveComment', file);
    return replace(text, '            #[cfg(not(windows))]\n            _ => {}', '            #[cfg(all(not(windows), not(target_os = "macos")))]\n            _ => {}', file);
  });
  update("crates/game/src/input_adapter.rs", (text, file) => replace(text, '#[cfg(not(windows))]\nfn double_click_limits()', '#[cfg(target_os = "macos")]\nfn double_click_limits() -> (Duration, f32, f32) {\n    (crate::platform_dispatcher::macos::double_click_interval(), 4.0, 4.0)\n}\n#[cfg(all(not(windows), not(target_os = "macos")))]\nfn double_click_limits()', file));
  update("crates/formats/src/paz.rs", (source, file) => {
    let text = replace(source, 'use crate::paz_keys::{key_index, ARCHIVE_ORDER, DATA_KEYS_SLOT0, INDEX_KEYS_SLOT0};', 'use crate::paz_keys::ARCHIVE_ORDER;', file);
    text = replace(text, 'pub const PAZ_HEADER_LEN: usize = 36;', '#[path = "maclauncher-archive-path.rs"]\nmod maclauncher_paths;\npub use maclauncher_paths::archive_path;\n#[path = "maclauncher-pe-profile.rs"]\npub mod profile;\npub const PAZ_HEADER_LEN: usize = 36;', file);
    text = replace(text, '&negate_key(&INDEX_KEYS_SLOT0[key_index(slot)])', '&negate_key(&profile::index_key(slot))', file);
    text = replace(text, '&negate_key(&DATA_KEYS_SLOT0[key_index(slot)])', '&negate_key(&profile::data_key(slot))', file);
    text = replace(text, '"{} {:08X} Uyiu4Ruy", entry.name.to_ascii_lowercase(), entry.size', '"{} {:08X} {}", entry.name.to_ascii_lowercase(), entry.size, profile::movie_password()', file);
    text = replace(text, 'let raw_index = source\n            .read_range(PAZ_HEADER_LEN as u64, header.index_size as usize)?;', 'if header.index_size > 4 * 1024 * 1024 { return Err(PazError::BadIndex); }\n        let raw_index = source\n            .read_range(PAZ_HEADER_LEN as u64, header.index_size as usize)?;', file);
    text = replace(text, 'ZlibDecoder::new(compressed)\n                .read_to_end(&mut decoded)', 'ZlibDecoder::new(compressed)\n                .take(u64::from(entry.size) + 1)\n                .read_to_end(&mut decoded)', file);
    return replace(text, '            take_logical_size(entry, &decoded)', '            if decoded.len() > entry.size as usize {\n                return Err(PazError::InvalidEntry { name: entry.name.clone(), reason: "zlib output exceeds its declared size".into() });\n            }\n            take_logical_size(entry, &decoded)', file);
  });
  update("crates/formats/src/resource.rs", (text, file) => replace(text,
    '        match self {\n            ResourceKind::Script => "N426Fd94",\n            ResourceKind::Image => "p37j344s",\n            ResourceKind::Audio => "ol0lOrAf",\n        }',
    '        crate::paz::profile::password(self)', file));
  for (const [file, text] of changes) fs.writeFileSync(path.join(root, file), text);
  fs.copyFileSync(path.join(__dirname, "native/macos-font.rs"), path.join(root, "crates/engine/src/maclauncher-font.rs"));
  fs.copyFileSync(path.join(__dirname, "native/macos-video.rs"), path.join(root, "crates/engine/src/maclauncher-video.rs"));
  fs.copyFileSync(path.join(__dirname, "native/macos-dispatcher.rs"), path.join(root, "crates/game/src/maclauncher-dispatcher.rs"));
  fs.copyFileSync(path.join(__dirname, "native/macos-platform.m"), path.join(root, "maclauncher-platform.m"));
  fs.copyFileSync(path.join(__dirname, "native/archive-path.rs"), path.join(root, "crates/formats/src/maclauncher-archive-path.rs"));
  fs.copyFileSync(path.join(__dirname, "native/pe-profile.rs"), path.join(root, "crates/formats/src/maclauncher-pe-profile.rs"));
  fs.mkdirSync(path.join(root, "crates/formats/src/bin"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "native/probe.rs"), path.join(root, "crates/formats/src/bin/maclauncher-minori-probe.rs"));
  return { version: VERSION, upstreamRevision: REVISION, profile: PROFILE,
    files: Object.fromEntries([...changes.keys(), ...outputs].sort().map(file => [file, hash(fs.readFileSync(path.join(root, file)))])) };
}
module.exports = { REVISION, VERSION, PROFILE, ORIGINALS, adaptSource };
