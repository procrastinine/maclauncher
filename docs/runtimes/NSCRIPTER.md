# NScripter native runtimes and tools

The NScripter module runs original Windows script/assets directly through either Yuri or ONScripter-EN. Import accepts the original executable or game folder; Runtime Settings selects the interpreter. Native players use managed runtime packages and run offline after installation. Backend actions remain pure Node services.

The Yuri web route also requires the shared NW.js SDK host. Play prepares both
the Yuri web payload and that host, using the newest compatible installed NW.js SDK or the game's
`nwjs-patched` version selection. All required download consents precede
installation; cancelling any one cancels the launch. Complete installed hosts
are reused without a catalog refresh or download.

Yuri Web runs NScripter scripts in an NW.js window. Its saves use the browser filesystem, separately from native Yuri saves.

Yuri Web Auto uses the newest complete installed release. A per-game version override remains exact. Native Yuri Auto retains the matching Mac adaptation; installing another version does not change it.

**Runtimes → NScripter → ONScripter-Yuri Web** manages web releases. Opening the tab reads local state; Reload explicitly queries upstream and replaces the available-release list. The native **ONScripter-Yuri** and **ONScripter-EN** sections manage MacLauncher Builds packages. Play downloads a missing selected package after consent and continues automatically; installed versions work offline. Their options and exact versions remain available in Settings and the game inspector. ONScripter-EN is an alternative, while the existing Yuri default remains available. Its current native adapter profile is `2025-06-08-mac-v2`, upstream commit `0a725088e01919e0c206533c793a84f69f06b833`; the build retains upstream engine `20250608-en` and NScripter command target `2.94`. Existing explicit Mac v1 installations remain separate and selectable. Those are runtime versions, not an assertion about an original game's engine version.

## Versions and distribution

[ONScripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri) native profile `0.7.7beta-macos-v3` uses upstream `0.7.7beta`, commit `08f744b31cc1907b66a15f0402e62321a131ed81`. It targets Apple Silicon and macOS 13, with its complete SDL2, font, image, audio and Lua dependency closure. The runtime supports title menus, dialogue advancement and the game's own save/load interface. Mac v3 resets empty text pages, including selection cursors and save checkpoints. Existing Mac v2 selections, stock upstream versions and Yuri Web keep their separate identities.

The Mac profile uses SDL automatic rendering and Lua `5.4.9`. PNG, JPEG, WebP, WAV, AIFF, FLAC, Vorbis, Opus and MP3 are enabled; MIDI uses macOS AudioToolbox. The original upstream source is preserved; the owned CMake overlay excludes the optional GLES renderer. The matching MacLauncher Builds release commit contains the selected dependency pins, original notices and build recipe. The read-only Yuri submodule records six unused libretro dependency commits without fetching or compiling them for the Mac build.

The canonical maintained upstream is [Galladite27/ONScripter-EN](https://github.com/Galladite27/ONScripter-EN), pinned as a read-only submodule. Explicit Reload uses the shared GitHub release/tag provider and replaces the cached catalog. All nine ordinary releases are listed in the pinned offline catalog, from `2025-06-08` through `2023-02-20`. The separate `2026-01-26-3854ae86-mac-v3` source snapshot uses commit `3854ae86c19337991722059d2bed07cbcc847f6f` and the SDL12-compat Mac adapter. It includes the upstream `tablegosub` command, delimiter overrun correction and Japanese text constants. The stable Mac v2 default and explicit earlier selections remain unchanged. Upstream Linux and Windows executables are never presented as Mac binaries.

The ARM64 package requires macOS 13 and includes SDL12-compat `1.2.76`/SDL2 `2.32.10`, codecs, source metadata and license notices. Profiles install under `~/Library/Application Support/maclauncher/runtimes/onscripter-en/<profile>/`. Mac v2 rebuilds the same pinned inputs with logical compiler paths. The engine reports `20250608-en` and command target `2.94`; existing explicit v1 selections retain their original identities.

ONScripter-EN provides native menus, dialogue, audio and save/load on Apple Silicon. Saves use the managed directory described below.

Development source installation builds the selected pinned source in a private local temporary directory, preserving the submodule unchanged. It verifies source and publisher archive hashes, records every overlay file hash, and installs its complete native closure into the managed runtime directory. Missing CMake `4.4.4`/Ninja `1.13.2` download through the shared explicit-build helper. Apple's compiler/SDK is checked before these downloads; developer fallback requires Apple Command Line Tools under `/Library/Developer/CommandLineTools` (`xcode-select --install`). Ordinary packaged installation and Play need none of those tools.

The module-owned CMake/Cocoa overlay replaces the obsolete nib/QuickTime shell, uses maintained SDL12-compat, enables generic little-endian MPEG code, adapts legacy const-qualified codec declarations, and fixes two published source compile defects in disposable inputs. External source is never edited. Included static codecs are SDL_image/SDL_mixer `1.2.12`, SDL_ttf `2.0.11`, FreeType `2.13.0`, libogg `1.3.5`, libvorbis `1.3.7`, libpng `1.6.39`, IJG JPEG `9f`, bzip2 `1.0.8` and SMPEG `0.4.5`. WAV, Vorbis and MP3/MPEG paths are built; legacy QuickTime/native MIDI support is not included.

## Original input, language and saves

Known loose script/archive markers are checked before executable container inspection. Plaintext and classic XOR formats then require a valid NScripter header: a `*define`/`*start` label plus a recognized command within a cached, bounded 64 KB prefix. Filename-only text files and empty scripts do not classify as NScripter. Executable-key/NT formats retain explicit reserved-format evidence without expensive executable decryption during detection. ONScripter-EN also recognizes declared UTF formats `0.utf`, `00.utf`, their `.txt` forms and `pscript.dat`. Its native launch uses the original root, an automatically resolved original/fallback font, and a small owned working directory for configuration/log files. Game assets are not copied. Packaged executable extraction remains automatic when assets cannot be read in place.

Automatic text mode follows the declared format: UTF scripts select English/UTF support, legacy scripts retain Japanese/Shift-JIS mode, and script-level English/backtick commands still govern their own text. English/Japanese overrides and fullscreen remain explicit options. Yuri retains its existing Shift-JIS/GBK/UTF-8 options; ONScripter-EN uses Japanese/Shift-JIS or English/UTF text.

Native saves use `userData/games/<id>/modules/nscripter/saves/` or the explicit save-folder override. Existing known small Windows save files are imported once when absent, without replacing edited managed files or modifying originals. ONScripter-EN uses its actual `--save` option; Yuri uses `--save-dir`. Script-controlled `savedir` remains relative to that managed native root. Browser Yuri saves remain in its browser filesystem; they are not converted to native saves. Save location/snapshot tools are available in the inspector; there is no generic NScripter save-data codec.

Native graphics availability follows the selected interpreter's executable architecture, including managed runtimes and configured external apps. An Intel interpreter uses the Intel graphics providers available to that process. Shell-script interpreters whose native executable cannot be identified do not declare an architecture. Renderer-specific capabilities still depend on the actual frame source.

## Script and cheat tools

The inspector's **Export script** reads plaintext, classic `nscript.dat`/`pscript.dat` XOR encoding, `nscr_sec.dat`'s published five-byte XOR format, and `nscript.___`'s executable key table without executing a game or installing a CLI. It exports the main script as UTF-8 to `userData/games/<id>/modules/nscripter/source/script/`, retaining original path/hash, encoding and decoder `maclauncher-nscript-v2` provenance. Previous edited exports are retained. Headless callers use `runAction(entry, "exportScript", {encoding: "sjis"})`; `utf8` and `gbk` are also explicit export options. Script data is bounded to 32 MB; key executables are bounded to 64 MB. The key-table reader follows the upstream algorithm with an O(n) sliding window and records the executable/hash/offset. It uses the dragged original executable or a unique original interpreter in the root; ambiguous executable choices need the original .exe as the import input. ONScripter-EN automatically receives that original executable through its upstream `--key-exe` option for encrypted native sessions.

ONScripter-EN's **Variable editor (Z)** setting enables the upstream live variable/volume editor for a native session. This changes live state through the original runtime UI; it is not a generic save editor or automatic game-specific cheat profile.

ONScripter-EN is GPL-2.0-or-later with separate component notices. This software is based in part on the work of the FreeType Team; its complete FreeType license is included.
