# NScripter

NScripter is a Windows visual-novel engine. MacLauncher runs the original NScripter scripts and assets directly with ONScripter interpreters, which run either as native Mac players or in a browser window. It can also export the game's script.

## Detection

Import accepts the original Windows executable or the game folder. Detection checks known loose script and archive markers first, before it inspects the contents of an executable. A plaintext or classic XOR-encoded script must have a valid NScripter header, meaning a `*define` or `*start` label plus a recognized command within the first 64 KB, which is read once and cached. Text files that only have a matching name, and empty scripts, are therefore not classified as NScripter. Scripts encrypted with a key from the executable, and NT formats, are recognized from their reserved format markers instead, without decrypting the executable during detection.

Launch uses the game's original root folder, and game assets are not copied. A packaged executable, however, is extracted automatically when its assets cannot be read in place, with the included [evbunpack](../runtimes/README.md#included-internal-tools) as a fallback for packed executables.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| ONScripter-Yuri (default) | Native Mac package from MacLauncher Builds |
| ONScripter-EN | Native Mac package from MacLauncher Builds |
| ONScripter-Yuri Web | Upstream web package, run in an NW.js host |
| External runtime | An interpreter app or executable whose path is set in the NScripter settings |
| CrossOver, Sikarugir (Wine) | Windows runtimes for the original executable |

The interpreter for a game is selected in **Runtime Settings**, and each interpreter keeps its own runtime settings and per-game version choice.

### Versions and downloads

**Runtimes → NScripter** has sections for native ONScripter-Yuri, ONScripter-Yuri Web and ONScripter-EN, with separate controls for MacLauncher Builds packages and upstream downloads. The MacLauncher Builds packages of the native players include their native dependencies. Upstream native downloads, by contrast, are the publisher's Mac executables, published as plain files or archives. The processor named in a file name decides which Mac it serves, and installation finds the executable wherever an archive places it. Each download is checked against the size and digest that GitHub publishes, as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity).

Native Yuri uses the selected Mac architecture, whereas Yuri Web has its own version and default.

### ONScripter-Yuri

ONScripter-Yuri is the default interpreter. Its native packages from MacLauncher Builds are built from [ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri) with its complete SDL2, font, image, audio and Lua dependencies. The player supports title menus, dialogue advancement and the game's own save and load screens, and resetting an empty text page keeps selection cursors and save checkpoints. Installed Builds packages and upstream versions share one native Yuri version selector.

These Mac packages use SDL's automatic renderer selection and Lua. PNG, JPEG, WebP, WAV, AIFF, FLAC, Vorbis, Opus and MP3 are enabled, and MIDI is played through macOS AudioToolbox. To leave out the optional GLES renderer, MacLauncher Builds uses a CMake file of its own and does not edit the upstream source. Each package's MacLauncher Builds release commit contains the exact dependency versions, original notices and build script.

Scripts can use different text encodings, and **Script encoding** selects one: Shift-JIS (the default, used by original Japanese scripts), GBK for Chinese releases, UTF-8 for converted scripts, or the runtime default. A `.utf` script alias, however, always uses UTF-8.

### ONScripter-EN

ONScripter-EN, the other native interpreter, is maintained upstream at [Galladite27/ONScripter-EN](https://github.com/Galladite27/ONScripter-EN). It provides native menus, dialogue, audio, and saving and loading on Apple silicon. Its Mac packages from MacLauncher Builds use the SDL12-compat adapter and include the upstream `tablegosub` command, the delimiter overrun correction and the Japanese text constants.

Refresh loads the available Mac packages from [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/#onscripter-en), while the upstream Linux and Windows executables serve as code references and are not offered as Mac downloads. Each package includes SDL12-compat, SDL2, codecs and license notices, and **Runtimes** lists its architectures and minimum macOS version. Packages are installed under `~/Library/Application Support/maclauncher/runtimes/onscripter-en/<profile>/`. The engine's own version and command-target identifiers are kept separate from the version of the Mac package.

To build these packages without editing the upstream source, MacLauncher Builds adds CMake and Cocoa files of its own. They replace the obsolete nib and QuickTime shell, use the maintained SDL12-compat, enable generic little-endian MPEG code and adapt legacy codec declarations. The packages statically include SDL_image, SDL_mixer, SDL_ttf, FreeType, Ogg/Vorbis, PNG, JPEG, bzip2 and the SMPEG codecs, so WAV, Vorbis and MP3/MPEG playback are available. Legacy QuickTime and native MIDI support are not included.

ONScripter-EN also recognizes the declared UTF formats `0.utf`, `00.utf`, their `.txt` forms and `pscript.dat`. A native launch uses the original root folder as the working folder, together with the original `ons.cfg` and an automatically chosen font, either the game's original or a fallback. For encrypted scripts, ONScripter-EN receives the original executable through its upstream `--key-exe` option.

The native players and Yuri Web choose their font in the same way. Each uses the configured **Default font path** or the game's own `default.ttf` first. When neither is supplied, Play downloads the UmePlus Gothic fallback font after consent and checks it against a fixed size and SHA-256 before installing it in shared permanent Application Support. Later launches reuse this font offline, and it is not copied into the game.

ONScripter-EN has these settings:

| Setting | Values |
| --- | --- |
| **Text mode** | Automatic (default), Japanese or English |
| **Fullscreen** | Off by default |
| **Variable editor (Z)** | Off by default; see [variable editor](#variable-editor) |

In automatic text mode, UTF scripts use English/UTF support, while legacy scripts keep Japanese/Shift-JIS mode. English and backtick commands in a script still control their own text.

### ONScripter-Yuri Web

ONScripter-Yuri Web runs the game's scripts in an NW.js window instead, using the web releases of [`YuriSizuku/OnscripterYuri`](https://github.com/YuriSizuku/OnscripterYuri). A web release is a 7z, ZIP or compressed tar archive with `web` in its name, and its download is checked in the same way as the native downloads. Web packages are installed under `userData/runtimes/onsyuri/web/<version>/`, and they need `onsyuri.html` or `index.html` in the installation folder or a subfolder of it. Yuri Web has the same **Script encoding** setting as native Yuri.

This runtime also needs the shared NW.js SDK host described in [web runtimes](../runtimes/WEB_RUNTIMES.md), so Play prepares both the Yuri web package and the host. For the host, the game's NW.js (Patched) version is used first, and the NW.js default otherwise. Play asks about every required download before it installs anything, and cancelling any one of them cancels the launch.

## Saves

The native players keep the save locations of their upstream versions. ONScripter-Yuri saves in the original game root unless the script chooses a save directory. ONScripter-EN, in contrast, derives a save identity from the original script and uses `~/Library/Application Support/<gameid>/` on macOS. When a save-folder override is set, it is passed explicitly, through `--save` for EN or `--save-dir` for Yuri. Launch does not scan existing saves or import them into MacLauncher data.

EN's save identity can come from an authored `game.id`, an initial `;gameid` script directive or the `--gameid` launch argument, and the normalized script length serves as the fallback identifier. Import keeps this behavior unless the game's save location collides with another game in the library. In that case, it records a distinct game identity as a `--gameid` argument in the ordinary per-game launch settings.

A game that contains only `0.utf` needs a file-name adapter for Yuri, and this adapter keeps the original game as the working folder and default save location. Yuri Web keeps its own WebAssembly file-system adapter instead and saves to its browser file system, separately from native Yuri saves; these browser saves are not converted to native saves. The inspector offers save locations and snapshots, but there is no general save-data editor for NScripter.

## Graphics

The shared [graphics controls](../graphics/README.md) apply to the running interpreter. Native graphics follow the architecture of the selected interpreter's executable, both for downloaded runtimes and for configured external apps, so an Intel interpreter uses Intel graphics providers.

## Tools

### Script export

**Export script** decodes the main script without running the game or installing a command-line tool, and **Reveal source** opens the output. The decoder reads:

- plaintext scripts
- the classic XOR encoding of `nscript.dat` and `pscript.dat`
- the published five-byte XOR format of `nscr_sec.dat`
- `nscript.___`, using the key table from the game's executable

The script is exported as UTF-8 to `userData/games/<id>/modules/nscripter/source/script/`, together with its original path and hash, the encoding and the decoder version (`maclauncher-nscript-v2`). Earlier exports that were edited are kept. The export encoding is `sjis`, `utf8` or `gbk`, and backend callers pass it as an option, for example `runAction(entry, "exportScript", {encoding: "sjis"})`. Like the other NScripter backend actions, this one is a pure Node service. Script data is limited to 32 MB and key executables to 64 MB.

The key table for `nscript.___` is read by a key-table reader that follows the upstream algorithm with a linear-time sliding window. This reader records the executable, its hash and the key offset. It uses the executable that was dropped on the launcher, or a single original interpreter in the game folder; when the choice is ambiguous, the original `.exe` has to be the import input. Archive assets and game-specific encryption are separate from script decoding, and the export does not convert a game between ONScripter runtimes.

### Variable editor

The ONScripter-EN setting **Variable editor (Z)** enables the upstream live variable and volume editor for a native session. This editor changes live state through the original runtime's interface; it does not edit saves or provide game-specific cheats.

## Licenses

ONScripter-EN is licensed under GPL-2.0-or-later, with separate notices for its components. This software is based in part on the work of the FreeType Team; the complete FreeType license is included.
