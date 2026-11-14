# Nitroplus

Nitroplus games are Windows visual novels whose scripts are NSS source files packed in NPA archives. When a game uses unencrypted NPA v1 archives and NSS source, MacLauncher plays it natively with the Nitroplus runtime, a player built from [libnpengine](https://github.com/FGRE/libnpengine) and [libnpa](https://github.com/FGRE/libnpa).

| Runtime | Description |
| --- | --- |
| Nitroplus (default) | Native NPA/NSS player |
| CrossOver, Sikarugir, WineCX | Run the original Windows executable |

## Importing games

MacLauncher's `nitroplus` module recognizes original Nitroplus game folders and Windows executables by reading the complete NPA v1 script index, within size limits, together with the NSS boot script that the index declares. Compressed script and image members can be read. Archives with compressed audio or movies are not supported, however, because the player streams those directly from byte ranges in the archive.

## Detection and versions

A Nitroplus game can carry several version numbers, and the inspector records each of them separately:

- the NPA archive format version and its compression and encryption flags;
- the `#SCRIPT_VERSION` written in the NSS source, with the archive, member and assignment it came from;
- the product version written in `system.ini`, with its source;
- the file and product values of the original executable's `RT_VERSION` resource, read within a size limit.

The product and script versions are never reported as the version of the original proprietary engine, and an engine version that is unknown stays unknown.

## Game data and saves

A normal launch extracts nothing: the player reads the original archives directly and uses the original game directory as its working directory. Its runner requires an explicit save directory, so MacLauncher always passes one, either `userData/games/<gameId>/modules/nitroplus/saves/` by default or the location chosen in a per-game save-folder override. When the player writes or deletes a file, it rejects paths outside that save folder and does not follow symbolic links. GStreamer registries, font caches, preparation metadata and native logs stay in launcher data instead, and preparation metadata is reused for as long as it is unchanged. Save editing and cheats are not available.

## Inspector tools

The inspector's **Archives and scripts** group contains:

- **Inspect archives**, which reads the archive indexes and version metadata.
- **Extract scripts**, which extracts the NSS source as UTF-8 into the game's private data. Extraction limits the size of each script and of the total output.
- **Check script compiler**, which runs the game's scripts through the actual native NSS compiler without opening a window.
- **Log**, which shows the native output of the last launch, up to a size limit, with the actual error details. Logs stay in the game's private data. Quitting normally or using Stop in the inspector is not treated as a runtime error, whereas an unexpected native exit produces the launcher's usual failure notification.

Two backend actions are also available: `runtimeStatus` checks the selected runtime, and `registerRuntime` registers a complete local native distribution.

## Runtimes

### Nitroplus

Nitroplus, the default runtime, is a native player made of an arm64 Mach-O host and a dynamically linked libnpengine library. It draws with SDL2 and OpenGL, sets text with Pango and decodes audio and movies with GStreamer. Menus, preference choices, story text and input are handled by the player, and Cmd-Q closes the game window. Text follows the upstream top-left layout rather than the box coordinates written in the scripts.

Game data comes from the module's own archive reader, which takes NPA directories and the requested byte ranges straight from the original archives. Unlike upstream, this reader does not read the whole archive header, and it uses GStreamer's allocator when streaming audio. Window metrics, initial channel volumes and font settings are taken from the original `system.ini`. The fonts themselves are found by a font configuration from the module, which looks up macOS system fonts and keeps its cache in the game's private data, so no Windows fonts need to be installed.

#### Installation and versions

The runtime packages are published by MacLauncher Builds and listed in **Runtimes → Nitroplus**.

- They are installed by the `npengine` runtime manager. For each package, Runtimes shows the architectures and the minimum macOS version, and it lists the upstream source history separately.
- Each package contains the native libraries, GStreamer plugins, a runtime profile, font configuration and license notices. It declares one minimum macOS version that covers all of its dependencies.
- Installed runtimes and their plugins are kept in `userData/runtimes/npengine/<architecture>/<version>/`, where the package architecture is `arm64`, `x64` or `universal`. Compatible installations in the older shared `<version>/` directory remain usable.
- At launch, MacLauncher reads the installed runtime's profile. This file in the package lists the engine and libnpa revisions (which the runner also carries), the GStreamer plugins and the font configuration. Any installed version can launch as long as its profile and runner support MacLauncher's save-folder and script-check interface.

#### Script and input support

MacLauncher changes the NSS source compiler so that it also accepts these older NSS forms:

- older comparison and logical operator precedence, grouped expressions, variable division, hexadecimal integers and colors, bare namespaces and compound scalar assignments;
- legacy terminators, separate text blocks, case labels with a literal `@` or without a colon, and expression array indices;
- the older `else[ ... }` spelling, accepted only in an `else` clause. It compiles to the same bytecode as an ordinary brace-delimited `else` block, and array brackets keep their expression meaning.

Japanese choice handles are converted to CP932 once, so that a `case` names the same object as `CreateChoice`, while the original NSS bytes are kept. Unknown tokens and unterminated text blocks make compilation fail, so a partly read source never appears to compile. Scripts with `cut` or `call_cut` subroutines, stray delimiters, nested legacy text syntax, or sound-effect or marker controls are still rejected.

The player also handles these rendering and input details:

- JPEG images are decoded as opaque RGBA before decompression starts, and Cairo text uses the correct color, alpha and pixel channels.
- The NSS `PRE` parser, which has fixed size limits, keeps words, punctuation escapes and literal ampersands. It recognizes empty initialization markers, click boundaries and named voice fields, and it keeps font and ruby metadata. Control names and markup are validated against its grammar.
- The `PRE` box handle is published as `$SYSTEM_present_preprocess` before the script's text helpers select their `LoadText` branch.
- Native choice objects include the `MouseLeave` namespace that menu callbacks in the scripts use. Reading a missing object returns no object, an invalid write fails with its namespace, and cyclic aliases fail within a fixed limit.
- Drawable children are found anywhere in the `MouseUsual`, `MouseOver` and `MouseClick` state groups, including children with arbitrary names and nested groups, and hit testing, state visibility and keyboard focus use their actual bounds. `SetNextFocus` also accepts a child-texture handle and resolves the choice that contains it. Existing `img` children remain supported. The search covers up to 32 nested groups and 4096 objects.

### CrossOver, Sikarugir and WineCX

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application, [Sikarugir](../runtimes/SIKARUGIR.md) or [WineCX](../runtimes/WINECX.md). The detected version and the inspector tools stay available with each of these runtimes.

## Source and builds

Packages are built from exact revisions of [libnpengine](https://github.com/FGRE/libnpengine) (LGPL-3.0-or-later) and [libnpa](https://github.com/FGRE/libnpa) (MIT). Each package's MacLauncher Builds release commit contains the exact commits of both, MacLauncher's changes, the dependency definitions, notices and the build script. MacLauncher's CMake, Clang, macOS, compiler and filesystem changes are applied to copies of the upstream files in separate build folders, and the runtime installation records the hashes of the source and of those changes together with the configure options.

The engine, the wrapper and the dependencies that the module builds itself are all compiled against one fixed version of the official GStreamer development SDK. Although the wrapper build does not rebuild the SDK, the SDK's corresponding sources, Cerbero recipes, configuration and patches are included.

Each package's profile records the profile identifier and the digests of the source tree and of MacLauncher's changes, while the archive and the package's native manifest record the source and binary hashes. Compiler file, debug and macro paths use neutral source and build folder names, so the published build information contains no build-machine paths. [Runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md) describes how runtimes are delivered.
