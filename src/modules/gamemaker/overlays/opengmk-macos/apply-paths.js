function applyPathOverlay(inputs) {
  function replace(file, before, after) {
    if (!inputs[file]?.includes(before)) throw new Error(`Pinned OpenGMK file-path overlay context changed: ${file}`);
    inputs[file] = inputs[file].replaceAll(before, after);
  }
  const main = "gm8emulator/src/main.rs", game = "gm8emulator/src/game.rs", file = "gm8emulator/src/gml/file.rs", kernel = "gm8emulator/src/gml/kernel.rs";
  replace(main, "mod maclauncher_inspect;", "mod maclauncher_paths;\nmod maclauncher_inspect;");
  replace(main, '    opts.optflag("", "inspect-json",', '    opts.optopt("", "working-directory", "private writable directory; original assets are read in place", "DIRECTORY");\n    opts.optflag("", "inspect-json",');
  replace(main, '    let encoding = encoding_rs::SHIFT_JIS;', `    if let Some(directory) = matches.opt_str("working-directory") {
        if let Err(error) = maclauncher_paths::configure(absolute_path.parent().unwrap(), Path::new(&directory)) {
            eprintln!("Invalid private game directory: {}", error); return EXIT_FAILURE;
        }
    }
    let encoding = encoding_rs::SHIFT_JIS;`);
  replace(main, 'std::fs::remove_file(file).ok();', 'if let Ok(path) = maclauncher_paths::write_path(&file, false) { std::fs::remove_file(path).ok(); }');
  replace(game, 'std::env::set_current_dir(&file_path2)?;', 'std::env::set_current_dir(crate::maclauncher_paths::working_directory(&file_path2))?;');
  replace(file, '    pub fn open(path: &str, mode: AccessMode) -> io::Result<Self> {', `    pub fn open(path: &str, mode: AccessMode) -> io::Result<Self> {
        let resolved = match mode { AccessMode::Read => crate::maclauncher_paths::read_path(path), _ => crate::maclauncher_paths::write_path(path, matches!(mode, AccessMode::Special))? };
        let path = resolved.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Non-Unicode game path"))?;`);
  replace(file, 'Path::new(path).is_file()', 'crate::maclauncher_paths::read_path(path).is_file()');
  replace(file, 'Path::new(path).is_dir()', 'crate::maclauncher_paths::read_path(path).is_dir()');
  replace(file, '    if !Path::new(to).exists() {', '    let from = crate::maclauncher_paths::write_path(from, true)?;\n    let to = crate::maclauncher_paths::write_path(to, false)?;\n    if !to.exists() {');
  replace(file, 'std::fs::copy(from, to)?;', 'std::fs::copy(crate::maclauncher_paths::read_path(from), crate::maclauncher_paths::write_path(to, false)?)?;');
  replace(file, 'std::fs::create_dir_all(path)?;', 'std::fs::create_dir_all(crate::maclauncher_paths::write_path(path, false)?)?;');
  replace(file, '    if Path::new(path).exists() {', '    let path = crate::maclauncher_paths::write_path(path, false)?;\n    if path.exists() {');
  replace(file, 'image::open(path)?', 'image::open(crate::maclauncher_paths::read_path(path))?');
  replace(file, 'File::open(path)?', 'File::open(crate::maclauncher_paths::read_path(path))?');
  replace(file, '    // save to png if the filename is .png otherwise bmp regardless of filename', '    let path = crate::maclauncher_paths::write_path(path.as_ref(), false)?;\n    // save to png if the filename is .png otherwise bmp regardless of filename');
  replace(file, 'path.as_ref().extension()', 'path.extension()');
  replace("gm8emulator/src/game/includedfile.rs", 'std::fs::write(path, &data)?;', 'std::fs::write(crate::maclauncher_paths::write_path(path, false)?, &data)?;');
  replace(kernel, 'std::fs::File::create(', 'crate::maclauncher_paths::create_file(');
  replace(kernel, 'std::fs::File::open(', 'crate::maclauncher_paths::open_file(');
  replace(kernel, 'ini::Ini::load_from_file(name_str.as_ref())', 'ini::Ini::load_from_file(crate::maclauncher_paths::read_path(name_str.as_ref()))');
  replace(kernel, 'ini.write_to_file(self.decode_str(path.as_ref()).as_ref())', 'crate::maclauncher_paths::write_path(self.decode_str(path.as_ref()).as_ref(), false).and_then(|path| ini.write_to_file(path))');
  replace(kernel, 'std::fs::read(self.decode_str(path.as_ref()).as_ref())', 'std::fs::read(crate::maclauncher_paths::read_path(self.decode_str(path.as_ref()).as_ref()))');
  replace(kernel, 'std::path::PathBuf::from(fname.as_ref())', 'crate::maclauncher_paths::read_path(fname.as_ref())');
}
module.exports = { applyPathOverlay };
