# Minori

Minori games are Windows visual novels that store their data in PAZ archives. MacLauncher plays them natively with [ReMinori](https://github.com/luoyily/ReMinori), an interpreter for the Minori PAZ formats.

| Runtime | Description |
| --- | --- |
| ReMinori (default) | Native interpreter for the supported PAZ profiles |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

Import accepts a complete Windows game folder, its executable or the matching offline installer.

## Data formats

ReMinori supports two PAZ profiles, which differ in where the archive keys come from, and the set of PAZ archives is validated before launch. Where a profile uses key tables from the executable, the original Windows executable is also read, but only as data, and it is never run. Its file version is shown separately from the archive format and the runtime version.

| Profile | Key source |
| --- | --- |
| `paz-bf-slot0-rc4-v1` | Supported PAZ header and archive-key layout |
| `paz-pe-keytables-rc4-v1` | Supported key tables in the original Windows PE |

Each profile also selects its own archive and VM implementation.

## Saves

ReMinori saves to `userdata/` in the original game directory when that directory is writable, and otherwise falls back to its own `~/Documents/eden/userdata/` location. For the installed ReMinori interpreter to use the original executable's directory rather than its runtime installation directory, import records the supported save-folder setting. If another game in the library already uses the same save location, import gives a game without an explicit save-folder setting its own `~/Documents/eden/games/<gameId>/userdata/` override. Explicit save-folder settings stay unchanged. Save editing and cheats are not available.

The game reads its original PAZ archives directly and uses the original game directory as its working directory. Interpreter caches, verification records and native logs, on the other hand, remain in launcher data.

## Script tools

Scripts are handled by **Extract scripts**, **Reveal scripts** and **Remove scripts** in the inspector's **Scripts** group, while **Verify archives** is in its **Advanced** group. Extracted scripts are stored as UTF-8 files in the game's launcher data.

## Runtimes

### ReMinori

As the default runtime, ReMinori supports title and menu interaction, story text and artwork, keyboard input, AppKit game controls, save comments and thumbnails, and saving and loading. Movies and audio are played through a local [FFmpeg](https://ffmpeg.org/) bridge, which uses the codecs and containers enabled in the selected runtime package and makes no network requests.

MacLauncher Builds publishes the native ReMinori packages, and they are listed in **Runtimes → Minori**. Each package records its source revision, dependencies, build options and CPU architectures, and Runtimes lists its architectures and minimum macOS version.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected version and the inspector tools stay available with either runtime.

## Source and licenses

In MacLauncher Builds, ReMinori's [source changes](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/overlay.js), [native builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/build.js) and [movie builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/movie-build.js) record the exact source commits, dependencies, build options and CPU architectures.

ReMinori keeps its AGPL-3.0 license, the FFmpeg libraries configured for LGPL keep LGPL-2.1-or-later, and Rust components keep their own notices, as listed in [attributions](../ATTRIBUTIONS.md). [Runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md) describes how the packages are delivered.
