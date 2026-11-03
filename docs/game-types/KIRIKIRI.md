# KiriKiri

KiriKiri is a Windows visual novel engine. Its games are written in TJS scripts with the KAG scenario framework and ship as loose project folders or XP3 archives. MacLauncher plays readable KAG3/TJS2 games natively with KiriKiri SDL2, a macOS build of [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2). Original Windows releases are prepared automatically: Play extracts their scripts into private launcher data and reads every other asset from the original archives.

| Runtime | Description |
| --- | --- |
| KiriKiri SDL2 (default) | Native interpreter for KAG3/TJS2 games |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

KiriKiri accepts these inputs:

- A source project folder with a root `startup.tjs`.
- An `.xp3` archive, or a folder with XP3 archives beside a Windows launcher. The archive must contain valid XP3 metadata with a root `startup.tjs` entry. An archive that holds only assets is not a game import.
- A Windows executable with XP3 data embedded in it.
- A macOS app. Its project data is read from `Contents/Resources/game`, `Contents/Resources/data` or `Contents/Resources`.

Import refuses encrypted content and known TJS1/KAG2 projects before any runtime is installed. Protected XP3 scripts are accepted only when they pass the verified-plain check described under [Protected scripts](#protected-scripts).

## Detection and versions

The inspector shows the game's detected engine or script version separately from the version of the selected runtime, together with the evidence and a confidence level. An unknown game version stays unknown; it is never filled in from the runtime selection.

In a source project, detection reads the loose `system/Initialize.tjs`, `Initialize.tjs` and `startup.tjs` files, including UTF-16LE scripts, and looks for explicit `kagVersion` or `tjsVersion` constants without running any script. A declaration such as KAG `3.32 stable rev. 2` identifies that KAG script version; it says nothing about the KiriKiri 2 or KiriKiri Z revision of the original Windows host. A project without explicit constants has no engine generation value. KiriKiri SDL2 accepts games by their KAG3/TJS2 source declarations.

For XP3 archives, detection reads raw and zlib-compressed indexes, chained indexes and XP3 data embedded in fused Windows executables, all within fixed size limits, and rejects malformed indexes and chains. Import reads at most three initialization or startup script entries, each up to 512 KB, to report explicit KAG and TJS constants, and nothing is extracted or executed. These constants identify the script framework, so the generation of the native Windows host can remain unknown.

Detection also records which native KiriKiri APIs the game's scripts call. Play uses that list to choose a runtime version, as described under [KiriKiri SDL2](#kirikiri-sdl2).

## Preparing original releases

Play finds runnable XP3 data embedded in the original executable or stored beside it, and applies sibling XP3 patch archives in order. An executable that contains only an asset or identifier archive does not hide a runnable `data.xp3` beside it. Explicitly selected XP3 inputs that are malformed or contain only assets are still rejected.

Preparation uses the `kag3-sdl2-v1` adapter, the code that converts an original release for KiriKiri SDL2. It extracts only the TJS and KS scripts, within size limits, decodes them from UTF-8, UTF-16 or Shift-JIS, and writes them as UTF-8 files with a byte-order mark into the game's launcher data. Images, music, movies and other assets are not copied: the prepared scripts refer to them inside the original archives through storage paths.

Each preparation records the archive hashes, the hashes of the extracted output, the adapter code hash, the exact source commit of the polyfill, the version evidence and every change applied. A prepared script that has changed therefore cannot pass as a cached preparation. On later launches, Play verifies the archive and output fingerprints and reuses the prepared scripts without decompressing or decoding them again. The prepared files are internal launcher data; the library entry always points at the original Windows input.

### Protected scripts

The XP3 protection flag alone does not mean a script is encrypted. A protected script is accepted, and marked `verified-plain-v1`, only when its Adler checksum matches the decompressed bytes with no filter applied. Every extracted protected script is checked on its own. Handling these asset formats does not change Steam authentication and does not run Windows DLLs.

### Languages

When a game declares language archives in its source, preparation uses the publisher's default language or the one chosen with an explicit `-language=` option, and records the available and selected languages. Translated scripts that exclude each other are never merged. Basename aliases resolve to the private adapted scripts.

### Script adaptations

The adapter makes a small number of changes to the private script copies. Source comments, strings and quoted KAG expressions are left as they are.

- A startup host shim exposes the original asset root through `System.exePath`. When publisher code sets the data path, the shim keeps the private data path and passes other arguments to the native setter.
- Some games load an optional Windows plugin inside a `try` block that contains only that load. For these literal calls, the script reports that the plugin is unavailable, and the publisher's own `catch` block and fallback run unchanged. No replacement service object is simulated.
- The stock `MessageLayer.tjs` declares a font variable named `face`. In this TJS host the variable shadows the inherited native drawing property, so the layer's clear operation can paint an opaque black canvas over the game. The adapter rewrites only explicit, unqualified `face=df*` drawing assignments in that stock class to `super.face=df*`. Font names, child layers and other scripts are not touched.
- One audio profile, a set of audio changes for a single game, is tied to that game's executable and patch fingerprint. For that game, preparation selects Wave buffers, keeps playable sound effects, and removes MIDI and CDDA declarations together with their completion waits. The inspector records which audio profile was used. Other readable KAG3 archives receive only the shared text, polyfill and save preparation.

### KAG3 polyfill and fonts

KiriKiri SDL2 needs the SDL version of the KAG3 scripts, taken from [krkrsdl2/kag3](https://github.com/krkrsdl2/kag3/tree/fe6d40e9a1667293ebb053af7f06374b7dac9292) at `fe6d40e9a1667293ebb053af7f06374b7dac9292`, together with its font. Resources already present in a sealed installed krkrsdl2 package are reused. Preparation verifies the package and resource manifests, records the selected resource revision and manifest hash, and refers to those files from each prepared game. The Ume Gothic O5 font carries its embedded license notice.

If the selected engine version lacks these resources, preparation uses a compatible installed package or the bundled KAG3 scripts. The script-only route downloads the pinned Ume Gothic O5 font on first Play after consent, checks its size and SHA-256, and prepares the shared resource folder in permanent Application Support. The original resource manifest and file hashes remain unchanged. Existing verified resource folders remain usable offline. The engine selection and defaults stay unchanged.

## Saves

KAG chooses save locations from its game configuration and the native runtime data path. `dataName` supplies the prefix for system and configuration save files; `saveDataID` validates save contents but does not choose a separate directory. Without a save-folder override, Play leaves these locations as KAG chooses them.

Import compares the game's known save location and file-name prefix with those of the other games in the library. When they collide, import can select a separate folder through the native `-datapath` option and records it as a visible per-game save-folder setting. Otherwise the game's own locations, distinct prefixes and explicit native arguments stay in use, and dynamic TJS configurations stay unchanged.

The selected folder is passed with `-datapath`, ending the path with a slash because KAG appends file names directly to `System.dataPath`. For archived KAG3 games, only the adapted configuration uses `System.dataPath`; the original archives stay unchanged. The adapted scripts preserve the original game's executable-relative asset paths.

Some older KAG configurations ignore that path. If a loose project's `saveDataLocation` resolves relative to `System.exePath`, the game would write inside the runtime bundle, so launch is refused before that can happen. Loose native projects are never rewritten.

Save folders from earlier MacLauncher versions are recovered once when the native destination can be used safely. Unique files and conflicting versions are preserved at that destination. A forced save folder from MacLauncher 0.5.1 retained after unsuccessful recovery remains selected through the visible save-folder override. Explicit folders and `-datapath` options keep their settings. KAG3 compatibility profiles and shared runtime resources remain in use.

## Settings

| Setting | Description |
| --- | --- |
| Version | **Default** or a specific installed version for this game. |
| Extra runtime options | One option per line, for example `-drawthread=4`. Save-folder overrides set `-datapath`. |

## Script export

**Export scripts**, in the inspector's **Script tools** group, writes readable TJS and KAG scripts as UTF-8 into a private export folder. **Reveal scripts** opens the result in Finder. The export uses the included XP3 reader, verifies archive checksums, applies patch archives in their precedence order and follows the publisher's default language or the language selected through runtime options.

Plain scripts are exported directly. SimpleCrypt scripts are decoded with [msg-tool](https://github.com/lifegpc/msg-tool), a native tool listed under **Runtimes → Tools → msg-tool**. Compiled TJS2 scripts stay as bytecode, with their constant pool exported separately as JSON for inspection.

## Runtimes

### KiriKiri SDL2

KiriKiri SDL2, the default runtime, is built from [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2) and runs readable KAG3/TJS2 scripts with native presentation, font loading and monitor handling.

Its packages are published by MacLauncher Builds and listed in **Runtimes → KiriKiri**, and its runtime options are in Settings.

Each package declares the native APIs it provides, and these APIs are backed by the real filesystem, FreeType and SDL. `Storages.dirlist` lists actual local and XP3 directories, `System.addFont` loads real FreeType faces for the process, and dialog rectangles are positioned against the real SDL monitor work areas. When neither the game nor the global settings name a version and the automatic choice lacks an API that the game's scripts call, Play recommends the first listed package that provides every required API. If an explicitly selected version lacks one, Play reports a capability error that names a compatible listed version when there is one.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected version and the script tools stay available with either runtime.

## Local registration

The `registerRuntime` backend action registers a local KiriKiri SDL2 executable as an exact version, including versions absent from the download catalog. The registration is stored in `userData/runtimes/krkrsdl2/<architecture>/<version>/runtime.json` with the version, upstream revision, executable path, SHA-256 and registration date. An unknown upstream revision is recorded as `local`; source information remains unverified, with `provenanceVerified: false`. The executable stays where it is, and runtime status and launch verify its checksum. Replacing it means removing the registration, which deletes only the launcher record, and registering again. Existing local registrations remain available to explicit version selections.

Registration checks that the path is absolute and executable and that it is a thin or universal 64-bit Mach-O executable whose slices are within size limits and supported by this Mac. An x86_64-only build runs under Rosetta on Apple Silicon. Shell scripts, ELF and PE files, and Mach-O libraries are rejected. Arguments go directly to the process without a shell. A registered executable still needs all of its native libraries and resources; registration does not package them.

## Implementation and licenses

The `kirikiri` module handles detection, runtime registration, launch arguments and save folders in the shared Node backend; Electron supplies only optional file-picker dialogs.

Each package records its upstream source revision, and its MacLauncher Builds release commit contains the complete source, its nested dependencies and MacLauncher's Mac changes. Before signing a downloaded upstream executable in its installation folder, MacLauncher checks that it is a complete Mach-O executable and reads its CPU slices. An installation also keeps its complete file manifest, dependency list and build record, and MacLauncher checks them again.

The KiriKiri core is MIT licensed; bundled components carry their own licenses.
