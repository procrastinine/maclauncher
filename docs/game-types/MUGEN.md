# MUGEN / Ikemen GO

MUGEN is a fighting game engine whose games are built from character, stage and screenpack (motif) definition files. [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO) is an engine that is compatible with MUGEN content, and MacLauncher plays both MUGEN and Ikemen GO games with Ikemen GO's upstream macOS releases. This playback does not load Electron, run Windows programs or use Wine.

| Runtime | Description |
| --- | --- |
| Ikemen GO (default) | Upstream Ikemen GO macOS release for the selected architecture |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

Import accepts a complete MUGEN or Ikemen GO distribution, that is, one that contains its character, stage and configuration files. A shipped `.app` can also be imported, provided that the complete game data is next to it.

## Detection and versions

To find the game's motif, detection uses the one declared in `data/mugen.cfg`, then the one in `data/system.def`, and then a single unambiguous `data/<screenpack>/system.def`. The inspector shows the source format, the motif, the content requirement the game declares and where the version information came from, along with the revision and build details of the game's original runner. This inspection can also be run on demand with **Inspect game version**, in the inspector's **Advanced** group, which needs a complete screenpack, characters and stages.

## Preparation and storage

How Play prepares a game depends on where its runtime comes from. An imported complete Ikemen distribution can include its own engine, and when that engine is the selected runtime, Play starts the original executable in the original game directory. Game resources, configuration and the default `save/` folder then stay where they are, and no private view of the game is created. An explicit save-folder override is the exception: with one, Play uses the per-game folder described below.

A separate runtime, on the other hand, needs a per-game folder that combines the engine's default files with the game's assets. Play builds this folder and then starts the engine with `-r <motif>`.

- Asset files, including static resources such as large 3D GLB and GLTF files, are linked for reading, so edits to a linked file show up immediately.
- Configuration and other files are private copies, which engine scripts may update. When an original changes, its copy is replaced at the next launch. When an original is removed, its copy is removed too, unless the game has written to that copy.
- On each launch, new files are added and deleted ones removed, while unchanged files are not read again.
- The selected engine supplies its own Lua support scripts, and Lua scripts from the imported game are not injected silently.
- The complete runtime app is kept unchanged beside the per-game assets, because the Mac runner resets its working folder to the app's parent folder.
- Symbolic links to folders in the source game are skipped.
- When the runtime changes, the app and the engine's files in the folder are replaced and the saves are kept.

Automatic preparation also repairs two kinds of content problems inside that folder:

- When a DEF file refers to a missing resource and exactly one file in the game has that name, preparation adds an alias for it. Ambiguous references and references that leave the game folder stay unresolved, and neither the existing resources nor the source DEF files are rewritten.
- For Ikemen GO 1.0.0 (commit `81c6da71`), preparation converts legacy numeric `MugenVersion < 1.0` and `MugenVersion >= 1.0` script expressions to the equivalent `MugenVersion(major)` comparisons, following the [current trigger definition](https://github.com/ikemen-engine/Ikemen-GO/wiki/Triggers-(new)#mugenversion). Only the affected scripts are copied privately, and the rest of their bytes, including encoding, comments and quoted text, stay intact. A comparison whose meaning is unknown is not guessed.

## Saves

Configuration, statistics, replays, logs and game-defined saves share one save folder, which also depends on the runtime. A complete distribution that runs with its own engine uses its original `save/` folder. With a separate runtime, these files go to the game's save folder in launcher data instead, through the `save` link in the per-game folder. In that case, the author's initial configuration is copied there only when no player configuration exists yet.

## Settings

| Setting | Description |
| --- | --- |
| Game arguments | Extra command-line arguments, one per line. |

## Sprite export

A game's sprites are stored in SFF sprite archives, and MacLauncher can export them as images. **Export sprites**, in the inspector's **Sprites** group, reads the SFF v1 and v2 archives in the imported game with [SFF Tools](https://github.com/openkakutou/sff), which is listed under **Runtimes → Ikemen GO → SFF Tools**. Its upstream WebAssembly module and Go runtime run in a private Node worker, so no Go installation, compiler or Wine is needed, and game scripts are not run.

The export writes PNG images to the game's launcher data, together with JSON metadata: group and image identifiers, dimensions, axis points and palette references.

- Errors for individual files or sprites are listed in `sprites-export.json` beside the usable output.
- This decoder does not support linked or shared v2 pixel data, although the metadata of such sprites can still be inspected.
- Empty sprites have metadata but no image.
- SND audio is not exported.

An export is limited to 1,024 SFF files, 128 MiB per file, 512 MiB of input in total, 20,000 sprites, 4,096 pixels per axis, 64 MiB per decode batch and 512 MiB of requested pixel data. When an export is cancelled or decodes no sprites, the previous successful export is kept.

SFF Tools is downloaded from the [publisher's releases](https://github.com/openkakutou/sff/releases). Each installation records the release's source commit and checks the WebAssembly module and its Go loader against the SHA-256 digests that GitHub publishes, as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity). These two files are found even when a release renames them. The installed tool keeps the MIT and BSD license notices.

## Runtimes

### Ikemen GO

Ikemen GO is the default runtime. It interprets the selected character, stage, motif and Lua definitions with its original engine, and **Runtimes → Ikemen GO** lists its upstream releases. The upstream 1.x macOS archives contain an ARM64 executable that requires Apple Silicon and macOS 14, whereas version 0.99 is an Intel build, which runs through [Rosetta](../runtimes/ROSETTA.md) on Apple Silicon. An archive named for one processor is listed for that processor only. During installation, MacLauncher reads these requirements from the downloaded executable and finds the executable or app bundle wherever the archive places it. Launch then runs it directly instead of through the upstream shell wrappers.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected engine and its inspector tools stay available with either runtime.

## Versions and installation

Ikemen GO versions follow the [shared selection rules](../runtimes/README.md#versions). Refresh loads the official release list, up to a fixed limit, and new releases are installed under `userData/runtimes/ikemen/<architecture>/<version>/`. Compatible installations from the earlier layout, which had no architecture folder, remain usable.

## Source and licenses

- [Ikemen GO 1.0.0](https://github.com/ikemen-engine/Ikemen-GO/releases/tag/v1.0.0)
- [Command-line and configuration implementation](https://github.com/ikemen-engine/Ikemen-GO/blob/81c6da71d689625e20db79586815b695da00dd6d/src/main.go)
- [Licensing](https://github.com/ikemen-engine/Ikemen-GO/blob/81c6da71d689625e20db79586815b695da00dd6d/LICENCE.txt)

The engine code is MIT licensed, while the bundled screenpack assets carry Creative Commons licenses and the bundled FFmpeg carries LGPL-2.1 terms. The distribution's license files stay in the installed runtime folder.
