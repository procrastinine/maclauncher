# MUGEN / Ikemen GO

MUGEN is a fighting game engine whose games are built from character, stage and screenpack (motif) definition files. [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO) is an engine compatible with MUGEN content, and MacLauncher plays MUGEN and Ikemen GO games with its upstream macOS releases. Playback does not load Electron, run Windows programs or use Wine.

| Runtime | Description |
| --- | --- |
| Ikemen GO (default) | Upstream Ikemen GO macOS release for the selected architecture |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

Import accepts a complete MUGEN or Ikemen GO distribution containing its character, stage and configuration files. A shipped `.app` can be imported when the complete game data is next to it.

## Detection and versions

Detection chooses the motif declared in `data/mugen.cfg`, then `data/system.def`, and then a single unambiguous `data/<screenpack>/system.def`. The inspector shows the source format, the motif, the content requirement the game declares and where the version information came from, along with the revision and build details of the game's original runner. **Inspect game version**, in the inspector's **Advanced** group, runs this inspection on demand; it needs a complete screenpack, characters and stages.

## Preparation and storage

Play builds a per-game folder that combines the engine's default files with the game's assets, then starts the engine with `-r <motif>`.

- Asset files are linked for reading, including static resources such as large 3D GLB and GLTF files. Edits to an existing linked file show up immediately; adding or removing files requires the folder to be rebuilt.
- The selected engine supplies its own Lua support scripts. Lua scripts from the imported game are not injected silently.
- The complete runtime app is kept unchanged beside the per-game assets, because the Mac runner resets its working folder to the app's parent folder.
- Symbolic links to folders in the source game are skipped.
- Changing the runtime rebuilds the folder and keeps the saves.

Automatic preparation also repairs two kinds of content problems inside that folder:

- When a DEF file refers to a missing resource and exactly one file in the game has that name, preparation adds an alias for it. Ambiguous references and references that leave the game folder stay unresolved. Existing resources and the source DEF files are not rewritten.
- With Ikemen GO 1.0.0 (commit `81c6da71`), preparation converts legacy numeric `MugenVersion < 1.0` and `MugenVersion >= 1.0` script expressions to the equivalent `MugenVersion(major)` comparisons, following the [current trigger definition](https://github.com/ikemen-engine/Ikemen-GO/wiki/Triggers-(new)#mugenversion). Only the affected scripts are copied privately, and their other bytes, including encoding, comments and quoted text, stay intact. Comparisons with unknown meaning are not guessed.

## Saves

Configuration, statistics, replays, logs and game-defined saves are written to the game's save folder in launcher data, through the `save` link in the per-game folder. The author's initial configuration is copied there only when no player configuration exists yet.

## Settings

| Setting | Description |
| --- | --- |
| Game arguments | Extra command-line arguments, one per line. |

## Sprite export

**Export sprites**, in the inspector's **Sprites** group, reads the SFF v1 and v2 sprite archives in the imported game with [SFF Tools](https://github.com/openkakutou/sff), listed under **Runtimes → Ikemen GO → SFF Tools**. The upstream WebAssembly module and its Go runtime run in a private Node worker, so no Go installation, compiler or Wine is needed, and game scripts are not run.

The export writes PNG images and JSON metadata to the game's launcher data: group and image identifiers, dimensions, axis points and palette references.

- Errors for individual files or sprites are listed in `sprites-export.json` beside the usable output.
- This decoder does not support linked or shared v2 pixel data; the metadata of such sprites can still be inspected.
- Empty sprites have metadata but no image.
- SND audio is not exported.

Limits are 1,024 SFF files, 128 MiB per file, 512 MiB of input in total, 20,000 sprites, 4,096 pixels per axis, 64 MiB per decode batch and 512 MiB of requested pixel data. Cancelling, or an export that decodes no sprites, keeps the previous successful export.

SFF Tools downloads come from the [publisher's releases](https://github.com/openkakutou/sff/releases). Each installation records the release's source commit and checks the WebAssembly module and its Go loader against the SHA-256 digests GitHub publishes, as described in [Runtime release catalogs](../runtimes/RUNTIME_CATALOGS.md#integrity). A renamed module or loader file is still found. The installed tool keeps the MIT and BSD license notices.

## Runtimes

### Ikemen GO

Ikemen GO is the default runtime, and **Runtimes → Ikemen GO** lists the upstream releases. The upstream 1.x macOS archives contain an ARM64 executable that requires Apple Silicon and macOS 14. Installation reads that requirement from the downloaded executable and finds the executable or app bundle wherever the archive places it, and launch runs it directly instead of the upstream shell wrappers. An archive named for one processor is listed for that processor only. Version 0.99 is an Intel build, which runs through [Rosetta](../runtimes/ROSETTA.md) on Apple Silicon. Ikemen GO interprets the selected character, stage, motif and Lua definitions with its original engine.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected engine and its inspector tools stay available with either runtime.

## Versions and installation

Ikemen GO versions follow the [shared selection rules](../runtimes/README.md#versions). Refresh loads the official release list, up to a fixed limit, and new releases install under `userData/runtimes/ikemen/<architecture>/<version>/`. Compatible installations from the earlier layout without an architecture folder remain usable.

## Source and licenses

- [Ikemen GO 1.0.0](https://github.com/ikemen-engine/Ikemen-GO/releases/tag/v1.0.0)
- [Command-line and configuration implementation](https://github.com/ikemen-engine/Ikemen-GO/blob/81c6da71d689625e20db79586815b695da00dd6d/src/main.go)
- [Licensing](https://github.com/ikemen-engine/Ikemen-GO/blob/81c6da71d689625e20db79586815b695da00dd6d/LICENCE.txt)

The engine code is MIT licensed. The bundled screenpack assets carry Creative Commons licenses, and the bundled FFmpeg carries LGPL-2.1 terms. The distribution's license files stay in the installed runtime folder.
