# NScripter native runtimes and tools

The NScripter module runs original Windows script/assets directly through either Yuri or ONScripter-EN. Import accepts the original executable or game folder; Runtime Settings selects the interpreter. Native players use managed runtime packages and run offline after installation. Backend actions remain pure Node services.

The Yuri web route also requires the shared NW.js SDK host. Play prepares both
the Yuri web payload and that host. The host follows the game's `nwjs-patched` version, then the
NW.js default. Its manager default is the newest compatible stable listed SDK, or the newest ready installed SDK when none is listed. All required download consents precede
installation; cancelling any one cancels the launch. Complete installed hosts
are reused without a catalog refresh or download.

Yuri Web runs NScripter scripts in an NW.js window. Its saves use the browser filesystem, separately from native Yuri saves.

Each Yuri route uses the game's exact version override, then its runtime default. A saved default takes precedence over the manager default: the newest compatible stable listed release, or the newest ready installed release when none is listed. Native Yuri uses the selected Mac architecture; Yuri Web has an independent version and default. Clearing a saved default restores the manager default.

**Runtimes → NScripter** manages native Yuri, Yuri Web and ONScripter-EN. Download lists start empty; Refresh discovers releases and retains a local cache. Native MacLauncher Builds downloads and upstream downloads use separate controls. Play obtains consent for a missing selected package, installs it and resumes automatically. Installed versions work offline. Each interpreter retains its runtime settings and exact per-game version choices.

## Versions and distribution

Native Yuri packages from MacLauncher Builds are built from [ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri) with its complete SDL2, font, image, audio and Lua dependency closure. The runtime supports title menus, dialogue advancement and the game's own save/load interface. Its empty text-page reset preserves selection cursors and save checkpoints. Installed native Builds and upstream versions share the native Yuri version selector; Yuri Web remains a separate runtime.

The Mac packages use SDL automatic rendering and Lua. PNG, JPEG, WebP, WAV, AIFF, FLAC, Vorbis, Opus and MP3 are enabled; MIDI uses macOS AudioToolbox. The original upstream source is preserved; the owned CMake overlay excludes the optional GLES renderer. The matching MacLauncher Builds release commit contains the selected dependency pins, original notices and build recipe.

The maintained upstream is [Galladite27/ONScripter-EN](https://github.com/Galladite27/ONScripter-EN). Mac packages from MacLauncher Builds use the SDL12-compat adapter and include the upstream `tablegosub` command, delimiter overrun correction and Japanese text constants. Refresh retrieves available Mac packages from [MacLauncher Builds](https://procrastinine.github.io/maclauncher-builds/#onscripter-en); upstream Linux and Windows executables are code references rather than Mac download choices.

Each package includes SDL12-compat, SDL2, codecs and license notices; Runtimes lists its architectures and minimum macOS. Profiles install under `~/Library/Application Support/maclauncher/runtimes/onscripter-en/<profile>/`. The engine's own version and command-target identifiers are separate from the selected Mac package version.

ONScripter-EN provides native menus, dialogue, audio and save/load on Apple Silicon. Saves use the managed directory described below.

The Builds CMake/Cocoa overlay replaces the obsolete nib/QuickTime shell, uses maintained SDL12-compat, enables generic little-endian MPEG code and adapts legacy codec declarations; upstream source is never edited. Packages include static SDL_image, SDL_mixer, SDL_ttf, FreeType, Ogg/Vorbis, PNG, JPEG, bzip2 and SMPEG codecs. WAV, Vorbis and MP3/MPEG playback are available; legacy QuickTime/native MIDI support is not included.

## Original input, language and saves

Known loose script/archive markers are checked before executable container inspection. Plaintext and classic XOR formats then require a valid NScripter header: a `*define`/`*start` label plus a recognized command within a cached, bounded 64 KB prefix. Filename-only text files and empty scripts do not classify as NScripter. Executable-key/NT formats retain explicit reserved-format evidence without expensive executable decryption during detection. ONScripter-EN also recognizes declared UTF formats `0.utf`, `00.utf`, their `.txt` forms and `pscript.dat`. Its native launch uses the original root, an automatically resolved original/fallback font, and a small owned working directory for configuration/log files. Game assets are not copied. Packaged executable extraction remains automatic when assets cannot be read in place.

Automatic text mode follows the declared format: UTF scripts select English/UTF support, legacy scripts retain Japanese/Shift-JIS mode, and script-level English/backtick commands still govern their own text. English/Japanese overrides and fullscreen remain explicit options. Yuri retains its existing Shift-JIS/GBK/UTF-8 options; ONScripter-EN uses Japanese/Shift-JIS or English/UTF text.

Native saves use `userData/games/<id>/modules/nscripter/saves/` or the explicit save-folder override. Existing known small Windows save files are imported once when absent, without replacing edited managed files or modifying originals. ONScripter-EN uses its actual `--save` option; Yuri uses `--save-dir`. Script-controlled `savedir` remains relative to that managed native root. Browser Yuri saves remain in its browser filesystem; they are not converted to native saves. Save location/snapshot tools are available in the inspector; there is no generic NScripter save-data codec.

Native graphics uses the selected interpreter's executable architecture, including managed runtimes and configured external apps. An Intel interpreter uses Intel graphics providers. The shared [graphics controls](GRAPHICS.md) apply to the running interpreter.

## Script and cheat tools

The inspector's **Export script** reads plaintext, classic `nscript.dat`/`pscript.dat` XOR encoding, `nscr_sec.dat`'s published five-byte XOR format, and `nscript.___`'s executable key table without executing a game or installing a CLI. It exports the main script as UTF-8 to `userData/games/<id>/modules/nscripter/source/script/`, retaining original path/hash, encoding and decoder `maclauncher-nscript-v2` provenance. Previous edited exports are retained. Headless callers use `runAction(entry, "exportScript", {encoding: "sjis"})`; `utf8` and `gbk` are also explicit export options. Script data is bounded to 32 MB; key executables are bounded to 64 MB. The key-table reader follows the upstream algorithm with an O(n) sliding window and records the executable/hash/offset. It uses the dragged original executable or a unique original interpreter in the root; ambiguous executable choices need the original .exe as the import input. ONScripter-EN automatically receives that original executable through its upstream `--key-exe` option for encrypted native sessions.

ONScripter-EN's **Variable editor (Z)** setting enables the upstream live variable/volume editor for a native session. This changes live state through the original runtime UI; it is not a generic save editor or automatic game-specific cheat profile.

ONScripter-EN is GPL-2.0-or-later with separate component notices. This software is based in part on the work of the FreeType Team; its complete FreeType license is included.
