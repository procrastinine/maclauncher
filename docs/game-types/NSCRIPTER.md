# NScripter

NScripter is a Windows visual-novel engine. MacLauncher runs the original NScripter scripts and assets directly with ONScripter interpreters, either as native Mac players or in a browser window, and can export the game's script.

## Detection

Import accepts the original Windows executable or the game folder. Known loose script and archive markers are checked before the contents of an executable are inspected. Plaintext and classic XOR-encoded scripts must have a valid NScripter header: a `*define` or `*start` label plus a recognized command within the first 64 KB, which is read once and cached. Text files that only have a matching name, and empty scripts, are not classified as NScripter. Scripts encrypted with a key from the executable, and NT formats, are recognized from their reserved format markers, without decrypting the executable during detection.

The game's original root folder is used for launch, and game assets are not copied. A packaged executable is extracted automatically when its assets cannot be read in place, with the included [evbunpack](../runtimes/README.md#included-internal-tools) as a fallback for packed executables.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| ONScripter-Yuri (default) | Native Mac package from MacLauncher Builds |
| ONScripter-EN | Native Mac package from MacLauncher Builds |
| ONScripter-Yuri Web | Upstream web package, run in an NW.js host |
| External runtime | An interpreter app or executable whose path is set in the NScripter settings |
| CrossOver, Sikarugir (Wine) | Windows runtimes for the original executable |

**Runtime Settings** selects the interpreter for a game, and each interpreter keeps its own runtime settings and per-game version choice.

### Versions and downloads

**Runtimes → NScripter** has sections for native ONScripter-Yuri, ONScripter-Yuri Web and ONScripter-EN, with separate controls for MacLauncher Builds packages and upstream downloads. The native players are MacLauncher Builds packages that include their native dependencies. Upstream native downloads are the publisher's Mac executables, published as plain files or archives. The processor named in a file name decides which Mac it serves, and installation finds the executable wherever an archive places it. Each download is checked against the size and digest GitHub publishes, as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity).

Native Yuri uses the selected Mac architecture, and Yuri Web has its own version and default.

### ONScripter-Yuri

Native ONScripter-Yuri packages from MacLauncher Builds are built from [ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri) with its complete SDL2, font, image, audio and Lua dependencies. The player supports title menus, dialogue advancement and the game's own save and load screens. Resetting an empty text page keeps selection cursors and save checkpoints. Installed Builds packages and upstream versions share one native Yuri version selector.

The Mac packages use SDL's automatic renderer selection and Lua, with PNG, JPEG, WebP, WAV, AIFF, FLAC, Vorbis, Opus and MP3 enabled and MIDI played through macOS AudioToolbox. MacLauncher Builds leaves out the optional GLES renderer with a CMake file of its own, without editing the upstream source. Each package's MacLauncher Builds release commit contains the exact dependency versions, original notices and build script.

**Script encoding** selects Shift-JIS (the default, used by original Japanese scripts), GBK for Chinese releases, UTF-8 for converted scripts, or the runtime default. A `.utf` script alias always uses UTF-8.

### ONScripter-EN

ONScripter-EN is maintained upstream at [Galladite27/ONScripter-EN](https://github.com/Galladite27/ONScripter-EN). Its Mac packages from MacLauncher Builds use the SDL12-compat adapter and include the upstream `tablegosub` command, the delimiter overrun correction and the Japanese text constants. ONScripter-EN provides native menus, dialogue, audio, and saving and loading on Apple silicon.

Refresh loads the available Mac packages from [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/#onscripter-en). Upstream Linux and Windows executables serve as code references and are not offered as Mac downloads. Each package includes SDL12-compat, SDL2, codecs and license notices, and **Runtimes** lists its architectures and minimum macOS version. Packages install under `~/Library/Application Support/maclauncher/runtimes/onscripter-en/<profile>/`. The engine's own version and command-target identifiers are separate from the version of the Mac package.

MacLauncher Builds adds its own CMake and Cocoa files, which replace the obsolete nib and QuickTime shell, use the maintained SDL12-compat, enable generic little-endian MPEG code and adapt legacy codec declarations without editing the upstream source. Packages statically include SDL_image, SDL_mixer, SDL_ttf, FreeType, Ogg/Vorbis, PNG, JPEG, bzip2 and the SMPEG codecs. WAV, Vorbis and MP3/MPEG playback are available; legacy QuickTime and native MIDI support are not included.

ONScripter-EN also recognizes the declared UTF formats `0.utf`, `00.utf`, their `.txt` forms and `pscript.dat`. Its native launch uses the original root folder, an automatically chosen original or fallback font, and a small working folder of its own for configuration and log files. For encrypted scripts, ONScripter-EN receives the original executable through its upstream `--key-exe` option.

| Setting | Values |
| --- | --- |
| **Text mode** | Automatic (default), Japanese or English |
| **Fullscreen** | Off by default |
| **Variable editor (Z)** | Off by default; see [variable editor](#variable-editor) |

In automatic text mode, UTF scripts use English/UTF support and legacy scripts keep Japanese/Shift-JIS mode. English and backtick commands in a script still control their own text.

### ONScripter-Yuri Web

ONScripter-Yuri Web runs the game's scripts in an NW.js window, using the web releases of [`YuriSizuku/OnscripterYuri`](https://github.com/YuriSizuku/OnscripterYuri). A web release is a 7z, ZIP or compressed tar archive with `web` in its name, and its download is checked in the same way. Web packages install under `userData/runtimes/onsyuri/web/<version>/` and need `onsyuri.html` or `index.html` in the installation folder or a subfolder of it. It has the same **Script encoding** setting as native Yuri.

This runtime also needs the shared NW.js SDK host described in [web runtimes](../runtimes/WEB_RUNTIMES.md). Play prepares both the Yuri web package and the host. The host uses the game's NW.js (Patched) version, then the NW.js default. Play asks about every required download before it installs anything, and cancelling any one cancels the launch.

## Saves

Native players save to `userData/games/<id>/modules/nscripter/saves/`, or to the save-folder override. Known small Windows save files are imported once when they are missing there, without replacing saves already in that folder. ONScripter-EN receives this folder through its `--save` option and ONScripter-Yuri through `--save-dir`. A `savedir` set by the script stays relative to this folder.

ONScripter-Yuri Web saves to its browser file system, separately from native Yuri saves, and these saves are not converted to native saves. The inspector offers save locations and snapshots; there is no general save-data editor for NScripter.

## Graphics

Native graphics uses the selected interpreter's executable architecture, for downloaded runtimes and configured external apps alike, so an Intel interpreter uses Intel graphics providers. The shared [graphics controls](../graphics/README.md) apply to the running interpreter.

## Tools

### Script export

**Export script** decodes the main script without running the game or installing a command-line tool, and **Reveal source** opens the output. It reads:

- plaintext scripts
- the classic XOR encoding of `nscript.dat` and `pscript.dat`
- the published five-byte XOR format of `nscr_sec.dat`
- `nscript.___`, using the key table from the game's executable

The script is exported as UTF-8 to `userData/games/<id>/modules/nscripter/source/script/`, with its original path and hash, the encoding and the decoder version (`maclauncher-nscript-v2`). Earlier exports that were edited are kept. The export encoding is `sjis`, `utf8` or `gbk`; backend callers use, for example, `runAction(entry, "exportScript", {encoding: "sjis"})`. The NScripter backend actions are pure Node services. Script data is limited to 32 MB and key executables to 64 MB.

The key-table reader follows the upstream algorithm with a linear-time sliding window and records the executable, its hash and the key offset. It uses the executable that was dropped on the launcher, or a single original interpreter in the game folder; when the choice is ambiguous, the original `.exe` has to be the import input. Archive assets and game-specific encryption are separate from script decoding, and the export does not convert a game between ONScripter runtimes.

### Variable editor

The ONScripter-EN setting **Variable editor (Z)** enables the upstream live variable and volume editor for a native session. It changes live state through the original runtime's interface, without editing saves or providing game-specific cheats.

## Licenses

ONScripter-EN is licensed under GPL-2.0-or-later, with separate notices for its components. This software is based in part on the work of the FreeType Team; the complete FreeType license is included.
