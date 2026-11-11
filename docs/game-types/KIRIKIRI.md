# KiriKiri

KiriKiri is a Windows visual novel engine. Its games are written in TJS scripts with the KAG scenario framework and ship as loose project folders or XP3 archives. MacLauncher plays readable KAG3/TJS2 games natively with KiriKiri SDL2, a macOS build of [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2). Original Windows releases are prepared automatically: Play extracts their scripts into private launcher data and reads every other asset from the original archives.

| Runtime | Description |
| --- | --- |
| KiriKiri SDL2 (default) | Native interpreter for KAG3/TJS2 games |
| CrossOver, Sikarugir, WineCX | Run the original Windows executable |

## Importing games

The KiriKiri game type accepts these inputs:

- A source project folder with a root `startup.tjs`.
- An `.xp3` archive, or a folder with XP3 archives beside a Windows launcher. The archive must contain valid XP3 metadata with a root `startup.tjs` entry. An archive that holds only assets is not a game import.
- A Windows executable with XP3 data embedded in it.
- A macOS app. Its project data is read from `Contents/Resources/game`, `Contents/Resources/data` or `Contents/Resources`.

Encrypted content and known TJS1/KAG2 projects are refused at import, before any runtime is installed. Protected XP3 scripts are accepted, but only when they pass the verified-plain check described under [Protected scripts](#protected-scripts).

## Detection and versions

The inspector shows the game's detected engine or script version separately from the version of the selected runtime, together with the evidence and a confidence level. An unknown game version stays unknown and is never filled in from the runtime selection.

In a source project, detection reads the loose `system/Initialize.tjs`, `Initialize.tjs` and `startup.tjs` files, including UTF-16LE scripts, and looks for explicit `kagVersion` or `tjsVersion` constants without running any script. Such a constant describes the scripts: a declaration such as KAG `3.32 stable rev. 2` identifies that KAG script version but says nothing about the KiriKiri 2 or KiriKiri Z revision of the original Windows host. A project without explicit constants has no engine generation value. KiriKiri SDL2, for its part, accepts games by their KAG3/TJS2 source declarations.

For XP3 archives, detection reads raw and zlib-compressed indexes, chained indexes and XP3 data embedded in fused Windows executables, all within fixed size limits, and it rejects malformed indexes and chains. To report explicit KAG and TJS constants, import then reads at most three initialization or startup script entries, each up to 512 KB, without extracting or executing anything. Because these constants identify the script framework, the generation of the native Windows host can remain unknown here as well.

Detection also records which native KiriKiri APIs the game's scripts call. Play uses that list to choose a runtime version, as described under [KiriKiri SDL2](#kirikiri-sdl2).

## Preparing original releases

Original Windows releases need preparation before KiriKiri SDL2 can run them. Play first finds the runnable XP3 data, which can be embedded in the original executable or stored beside it, and applies sibling XP3 patch archives in order. An executable that contains only an asset or identifier archive does not hide a runnable `data.xp3` beside it. Explicitly selected XP3 inputs that are malformed or contain only assets, however, are still rejected.

For the conversion, preparation uses the `kag3-sdl2-v1` adapter, the code that converts an original release for KiriKiri SDL2. The adapter extracts only the TJS and KS scripts, within size limits, decodes them from UTF-8, UTF-16 or Shift-JIS and writes them as UTF-8 files with a byte-order mark into the game's launcher data. Images, music, movies and other assets are not copied; instead, the prepared scripts refer to them inside the original archives through storage paths.

Each preparation keeps a record of the archive hashes, the hashes of the extracted output, the adapter code hash, the exact source commit of the KAG3 polyfill described below, the version evidence and every change applied. Because of this record, a prepared script that has changed cannot pass as a cached preparation. On later launches, Play verifies the archive and output fingerprints and reuses the prepared scripts without decompressing or decoding them again. The prepared files are internal launcher data, and the library entry always points at the original Windows input.

### Protected scripts

XP3 archives can flag a script as protected, but the flag alone does not mean that the script is encrypted. A protected script is therefore accepted, and marked `verified-plain-v1`, only when its Adler checksum matches the decompressed bytes with no filter applied. Every extracted protected script is checked on its own. Handling these asset formats does not change Steam authentication and does not run Windows DLLs.

### Languages

Some games declare language archives in their source. For these games, preparation uses the publisher's default language or the one chosen with an explicit `-language=` option, and it records both the available and the selected languages. Translated scripts that exclude each other are never merged, and basename aliases resolve to the private adapted scripts.

### Script adaptations

The adapter also makes a small number of changes to the private script copies. Source comments, strings and quoted KAG expressions are left as they are.

- A startup shim for the host exposes the original asset root through `System.exePath`. When publisher code sets the data path, the shim keeps the private data path and passes other arguments to the native setter.
- Some games load an optional Windows plugin inside a `try` block that contains only that load. For these literal calls, the script reports that the plugin is unavailable, and the publisher's own `catch` block and fallback run unchanged. No replacement service object is simulated.
- The stock `MessageLayer.tjs` declares a font variable named `face`. In this TJS host the variable shadows the inherited native drawing property, so the layer's clear operation can paint an opaque black canvas over the game. The adapter rewrites only explicit, unqualified `face=df*` drawing assignments in that stock class to `super.face=df*`. Font names, child layers and other scripts are not touched.
- One audio profile is included: a set of audio changes for a single game, tied to that game's executable and patch fingerprint. For that game, preparation selects Wave buffers, keeps playable sound effects, and removes MIDI and CDDA declarations together with their completion waits. The inspector records which audio profile was used. Other readable KAG3 archives receive only the shared text, polyfill and save preparation.

### KAG3 polyfill and fonts

KiriKiri SDL2 needs an SDL version of the KAG3 scripts, the KAG3 polyfill, together with its font. These come from [krkrsdl2/kag3](https://github.com/krkrsdl2/kag3/tree/fe6d40e9a1667293ebb053af7f06374b7dac9292) at `fe6d40e9a1667293ebb053af7f06374b7dac9292`. When an installed krkrsdl2 package already contains these resources, they are reused from it. Preparation verifies the package and resource manifests and records the selected resource revision and manifest hash, and each prepared game then refers to those files. The Ume Gothic O5 font carries its embedded license notice.

If the selected engine version lacks these resources, preparation takes them from a compatible installed package, and Play installs one that carries them after consent. Resource folders that earlier MacLauncher versions verified in permanent Application Support remain usable offline, and the engine selection and defaults stay unchanged.

## Saves

KAG chooses save locations itself, from the game configuration and the native runtime data path. In the configuration, `dataName` supplies the prefix for system and configuration save files, while `saveDataID` validates save contents but does not choose a separate directory. Without a save-folder override, Play leaves these locations as KAG chooses them.

Import compares the game's known save location and file-name prefix with those of the other games in the library. If they collide, import can select a separate folder through the native `-datapath` option, and it records that folder as a visible per-game save-folder setting. Otherwise, the game's own locations, distinct prefixes and explicit native arguments stay in use, and dynamic TJS configurations stay unchanged.

A selected folder is passed with `-datapath`, and its path ends with a slash because KAG appends file names directly to `System.dataPath`. For archived KAG3 games, only the adapted configuration uses `System.dataPath`, and the original archives stay unchanged. The adapted scripts also preserve the original game's executable-relative asset paths.

Some older KAG configurations ignore that path, however. If a loose project's `saveDataLocation` resolves relative to `System.exePath`, the game would write inside the runtime bundle, so launch is refused before that can happen. Loose native projects are never rewritten.

Save folders from earlier MacLauncher versions are recovered once, provided the native destination can be used safely, and both unique files and conflicting versions are preserved at that destination. MacLauncher 0.5.1 could also force a save folder; if such a folder was retained because recovery did not succeed, it remains selected through the visible save-folder override. Explicit folders and `-datapath` options keep their settings, and KAG3 compatibility profiles and shared runtime resources remain in use.

## Settings

| Setting | Description |
| --- | --- |
| Version | **Default** or a specific installed version for this game. |
| Extra runtime options | One option per line, for example `-drawthread=4`. Save-folder overrides set `-datapath`. |

## Script export

**Export scripts**, in the inspector's **Script tools** group, writes readable TJS and KAG scripts as UTF-8 into a private export folder, and **Reveal scripts** opens the result in Finder. The export reads the archives with the included XP3 reader, verifies their checksums, applies patch archives in their precedence order and follows the publisher's default language or the language selected through runtime options.

How a script is exported depends on its form. Plain scripts are exported directly, while SimpleCrypt scripts are first decoded with [msg-tool](https://github.com/lifegpc/msg-tool), a native tool listed under **Runtimes → Tools → msg-tool**. Compiled TJS2 scripts stay as bytecode, and their constant pool is exported separately as JSON for inspection.

## Runtimes

### KiriKiri SDL2

KiriKiri SDL2, the default runtime, is built from [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2) and runs readable KAG3/TJS2 scripts with native presentation, font loading and monitor handling.

Its packages are published by MacLauncher Builds and listed in **Runtimes → KiriKiri**, and its runtime options are in Settings.

Each package declares the native APIs it provides, and these APIs are backed by the real filesystem, FreeType and SDL. For example, `Storages.dirlist` lists actual local and XP3 directories, `System.addFont` loads real FreeType faces for the process, and dialog rectangles are positioned against the real SDL monitor work areas.

With these declarations, Play can match a package to the APIs that the game's scripts call. When neither the game nor the global settings name a version and the automatic choice lacks one of those APIs, Play recommends the first listed package that provides every required API. If an explicitly selected version lacks one, Play instead reports a capability error, which names a compatible listed version when there is one.

### CrossOver, Sikarugir and WineCX

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application, [Sikarugir](../runtimes/SIKARUGIR.md) or [WineCX](../runtimes/WINECX.md). The detected version and the script tools stay available with each of these runtimes.

## Local registration

A local KiriKiri SDL2 executable can also be used, including a version that is absent from the download catalog. The `registerRuntime` backend action registers it as an exact version, and the registration is stored in `userData/runtimes/krkrsdl2/<architecture>/<version>/runtime.json` with the version, upstream revision, executable path, SHA-256 and registration date. An unknown upstream revision is recorded as `local`, and source information remains unverified, with `provenanceVerified: false`. The executable itself stays where it is, and runtime status and launch verify its checksum. To replace it, the registration is removed, which deletes only the launcher record, and the executable is registered again. Existing local registrations remain available to explicit version selections.

Registration checks that the path is absolute and executable and that it is a thin or universal 64-bit Mach-O executable whose slices are within size limits and supported by this Mac. Shell scripts, ELF and PE files, and Mach-O libraries are rejected, while an x86_64-only build runs under Rosetta on Apple Silicon. Arguments go directly to the process, without a shell. Registration does not package anything, so a registered executable still needs all of its native libraries and resources.

## Implementation and licenses

Within MacLauncher, the `kirikiri` module handles detection, runtime registration, launch arguments and save folders in the shared Node backend. Electron is used only for optional file-picker dialogs.

Each package records its upstream source revision, and its MacLauncher Builds release commit contains the complete source, its nested dependencies and MacLauncher's Mac changes. A downloaded upstream executable is signed in its installation folder, but only after MacLauncher has checked that it is a complete Mach-O executable and has read its CPU slices. An installation also keeps its complete file manifest, dependency list and build record, which MacLauncher checks again.

The KiriKiri core is MIT licensed, and bundled components carry their own licenses.
