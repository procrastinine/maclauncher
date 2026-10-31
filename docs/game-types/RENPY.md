# Ren'Py

[Ren'Py](https://www.renpy.org/) is a visual-novel engine whose games are written in Ren'Py script and Python. MacLauncher runs Ren'Py games with an official Ren'Py SDK, by patching the macOS runtime files into the game, or with a Mac app supplied with the game. The inspector adds save inspection, Live2D setup, extraction and decompilation, an in-game console and cheat add-ons.

## Detection and versions

Import accepts a game folder, its `.sh` or `.py` launcher, its Windows executable, a Mac app, or a folder that contains only the `game` directory. Releases for several platforms can place a Mac app beside the Windows and Linux launchers without a copy of the game inside it; selecting that app imports the release folder around it, the same game as importing the folder. Ren'Py script and archive files (`.rpy`, `.rpyc`, `.rpa`, `.rpyb`) also identify a game. A recognized Ren'Py layout takes priority over the generic macOS handling of `.sh` and `.py` launchers.

The detected engine version records its source and confidence:

| Evidence | Confidence |
| --- | --- |
| A literal version in `renpy/vc_version.py`, or the selected tuple in `renpy/__init__.py` | exact |
| A complete standalone value in `script_version.txt` | reported |
| A major version only | inferred |

A version tuple that depends on the Python generation (7 or 8) stays unknown when the game has no identifiable runtime Python libraries, instead of taking the first branch. Ren'Py 7 and earlier use Python 2; Ren'Py 8 uses Python 3.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Ren'Py SDK (default) | Official SDK from **Runtimes → Ren'Py** |
| Ren'Py Patch | macOS runtime files from the matching SDK, copied into the game |
| Game's macOS app | A Mac build supplied with the game |
| CrossOver, Sikarugir (Wine) | Windows runtimes for the game's Windows executable |

### Ren'Py SDK

**Runtimes → Ren'Py** has two sections: Ren'Py (Python 2) for Ren'Py 7 and earlier, and Ren'Py 8, which also lists every later major version. The game's detected major version selects the section; a game whose major version is unknown needs a manual choice.

Play uses the SDK version chosen for the game (`runtimeData.sdk.version`), then the SDK that rebuilt the game or its detected Ren'Py version, then the default of the matching section. A packaged project keeps its SDK version, and automatic selection never saves a per-game version. Installing an SDK from **Runtimes** that is newer than its section's default makes it that section's default.

SDK versions are listed from [renpy.org/dl](https://www.renpy.org/dl/), with latest-stable hints from [latest.html](https://renpy.org/latest.html) and [latest-7.html](https://renpy.org/latest-7.html). Installation downloads an SDK archive and copies it with `ditto` to `userData/runtimes/sdk/<major>/<version>/`. Disk images use `diskutil image` with an `hdiutil` fallback. When the version folder has a `checksums.txt`, the download must match the SHA-256 it lists. Installation restores the Mac executables from packed `.macho` files before checking readiness, so `renpy.sh` can run without first opening the SDK launcher.

Runtime discovery tries known Mac library folders in version order, including older `darwin-x86_64` layouts. If those names are absent, a bounded search under `lib/` finds the Mac Python and Ren'Py executables by their contents. SDK installations record the selected folder for later launches.

Each SDK version runs the game from its own private project. The project has real directories with private scripts, Python files, compiled bytecode, configuration, caches, logs and local saves, while archives, images, music and other immutable assets are linked to the original game. Each SDK version keeps separate compiled scripts and caches, and the original game receives no compilation, cache or save writes. Existing local saves are copied into the private save folder once.

Synchronizing the project with the game compares source file metadata and reuses private files whose sources have not changed. The original timestamps of source and compiled scripts are kept, and generated caches persist between launches. A project made by an earlier launcher version that linked the whole `game/` folder is replaced automatically. If an asset cannot be linked, preparation fails instead of quietly copying the entire game.

### Ren'Py Patch

Ren'Py Patch runs the game with macOS runtime files copied into it, and if the game is not patched yet, Play asks to patch it first. The **Patch** action downloads the matching SDK ZIP (`renpy-<version>-sdk.zip`) as a temporary download, separate from the installed SDKs in `userData/runtimes/sdk/`, and copies the macOS runtime files from it into the game. The inspector's **Ren'Py patch** group shows the patch status and removes the patch.

### App bundles

The inspector's **Builds** group builds a Mac app bundle from the game with the selected SDK, and can reveal or remove it. The game's own Mac app runs as **Game's macOS app**.

### Python and Rosetta

SDK launches, patched launches and app builds check the selected native Python executable before running `renpy.sh`. The `mac-universal` folder of an older SDK can contain only Intel code, and on Apple silicon such an SDK needs [Rosetta](../runtimes/ROSETTA.md); MacLauncher asks to install it when it is missing, and declining cancels before the game starts. Native arm64 Python needs no Rosetta. These checks run in the backend, without Electron.

Shared graphics uses the architecture of the selected SDK's or patched runtime's native executable. An Intel platform selection stays Intel; a folder named universal does not by itself mean Apple silicon support.

### Steam integration

SDK and patched launches look for Steam API calls and explicit `achievement.register(..., steam=...)` registrations in the game's Python code, including Python 2 and 3 AST source kept inside compiled scripts and RPA archives. Comments, dialogue, translations and Ren'Py's bundled `00steam.rpy` provider do not count as a Steam dependency, and ordinary achievement registration stays a generic engine feature. Steam integration that the game disables stays disabled.

The application ID must come from literal game configuration or from Steam metadata inside the game; it is never guessed. Optional Steam achievements keep the engine's normal fallback when the ID or a compatible helper is unavailable. Games that call the Steam API directly report a missing or conflicting ID.

For a game that uses Steam, MacLauncher runs the selected runtime's own `steamapi` module against stub function objects to list every native symbol it requires. The shared Steam API support checks the game process's architecture and these exact exports, then uses a compatible library from the game or the included helper. Requirements are cached by the contents of the `steamapi` module, and each Python generation and SDK release is inspected separately.

An init script in the per-game project redirects only the runtime's exact `libsteam_api.dylib` and `steam_appid.txt` paths. The SDK's Steam provider initializes normally, while development writes and deletions of the app ID stay in per-game state. Ordinary path joins, existence checks and ctypes loading behave as before. Assets stay linked to the original game, and the SDK and its global libraries are unchanged. Patched launches use this private project only for a game that uses Steam. [Steam support](../runtimes/STEAM_API.md) describes the helper versions.

## Saves

### Save locations

When a library entry's details are refreshed, MacLauncher reads the game's save configuration from its code: loose `.rpy` source, the selected `.rpy` members of RPA 2, 3 and 3.2 archives, and configuration expressions kept in standard Python 2 and 3 `.rpyc` files. Nothing is extracted or launched. Translations are excluded, loose files override archived ones, and an existing extracted source folder takes precedence. Results are cached by source fingerprint and refreshed when the sources, archives or folders change.

A literal `config.save_directory` selects its exact save path, even before the folder exists. Safe nested names and Python raw and unicode string literals are accepted. The path then follows the runtime:

1. `RENPY_PATH_TO_SAVES`, when set.
2. A `Ren'Py Data` folder found above the selected SDK or native runtime.
3. `~/Library/RenPy/<name>`.

For example, `config.save_directory = "MyGame-1234"` resolves to `~/Library/RenPy/MyGame-1234` when no environment variable or portable folder overrides it. A `None` or empty name uses the running project's `game/saves`. A safe absolute literal `config.savedir` overrides this calculation, and literal absolute lists or tuples in `config.extra_savedirs` add further save locations.

For SDK launches, the local `game/saves` mirror is `userData/games/<gameId>/modules/renpy/projects/<sdkVersion>/game/saves`. The original game's `game/saves` stays discoverable for earlier saves. Native Mac bundles have no engine mirror. **Save tools** can choose between the detected folders without moving or rewriting saves.

Some configurations cannot be resolved: dynamic expressions, conditional or deferred assignments, conflicting settings, paths that leave the game and malformed literals. These stay unresolved with a warning. An existing `game/saves` mirror can still be offered as an inferred location, but an unknown configured location is not replaced with a guess from the title. Without any setting, `game/saves` is the inferred location. A custom configuration outside the inspected scope may need an explicit save-folder override. Options read from extracted sources follow the same rules. The same refresh repairs stale blank or title-based paths in existing library entries and keeps explicit overrides.

The configuration reader runs RPYC data through a size-limited Node pickle stack machine whose globals, constructors, reducers and object state are inert records. It imports no Python classes, calls no reducer, and never unpickles or runs third-party code. It accepts only known configuration-bearing AST classes and literal expressions, and does not decompile or evaluate arbitrary code. RPA indexes may contain only primitive values; object, reducer and global opcodes are rejected. Additional save folders must be a single literal source line or a compiled literal expression.

Inspection limits:

- 16 MiB of decompressed archive index
- 8 MiB per script and 24 MiB of source in total
- 256 scripts, 32 archives, 64 folders and a folder depth of 3
- caps on pickle operations, collections, stack and memo size
- a traversal budget for compiled configuration, and caps on extracted assignments and expressions (shared conditional AST nodes stay unresolved)

### Save metadata

**Inspect save metadata** lists the `.save` files directly inside the configured save location and the game's local `game/saves` folder, and writes a report that **Reveal metadata report** opens. A broken slot gets its own error while the other slots are still inspected. Symlinked files and `persistent` are skipped.

The report includes each slot's readable JSON metadata and extra information, the Ren'Py version it reports, the inferred Python generation, the ZIP member names and sizes, and whether a screenshot and signature are present. It also records the detected game version and any SDK version configured for the game, and warns when either differs from the version in the save. Loading saves and checking signatures is left to the selected Ren'Py runtime. The report is stored at `userData/games/<gameId>/modules/renpy/save-metadata.json`.

Save metadata is treated as untrusted. The reader checks ZIP bounds, duplicate names, compression limits, the metadata CRC-32, UTF-8 and JSON structure. It does not read or decompress the `log` member, decode screenshots, verify signatures or load Python objects. The limits are 512 MiB per slot, 128 ZIP members, 256 KiB of JSON, 32 KiB of extra information and 4 KiB of version text. Ordinary single-volume, unencrypted ZIP slots are accepted, and old standard ZIP slots without JSON can still be inspected.

Save editing is not available (`saveEditing` is `false`): game stores, rollback state, references and custom classes cannot be rebuilt safely from the metadata. Ren'Py's [save implementation](https://github.com/renpy/renpy/blob/master/renpy/loadsave.py) writes the metadata and the pickled state into separate members, and its [signature checks](https://github.com/renpy/renpy/blob/master/renpy/savetoken.py) are part of the runtime's trust model, which MacLauncher does not bypass. The [Ren'Py console](#renpy-console) can change live state instead.

The Ren'Py module treats `.save` slots and `persistent` as save files, so shared import, export and snapshots copy them byte for byte without decoding either format.

## Live2D

Ren'Py games with Live2D models need the Live2D Cubism Core library in the SDK. Each installed SDK version in **Runtimes** has **Install Live2D**, **Import Live2D ZIP** and **Remove Live2D**.

- **Install Live2D** reads the official Native SDK download catalog, downloads a compatible archive, extracts only the macOS Core dylib and its license, and installs it next to that SDK's macOS `renpy` executable. Each SDK has its own copy.
- **Import Live2D ZIP** installs from an archive that is already on disk.
- During Play, MacLauncher can install a missing SDK together with its matching Live2D library when the game's loose files or RPA index contain `.moc3` or `.model3.json` assets. This check reads indexes only; it does not evaluate scripts or deserialize Python objects.

Play reserves the selected SDK version and Python generation before preparation. A Live2D download waits until no other change to that SDK is in progress and then checks the library again, and a game that is using the SDK prevents changes. Other SDK versions stay independent, and the SDK stays in use until the game exits.

| Ren'Py runtime | Required ordering export |
| --- | --- |
| SDK 7 and SDK 8 through 8.5.2 | `csmGetDrawableRenderOrders` |
| SDK 8.5.3 and later | `csmGetRenderOrders` |

The [Ren'Py 8.5.3 changelog](https://www.renpy.org/doc/html/changelog.html#id10) and its [native loader](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy/gl2/live2dcsm.pxi) document the change; the SDK 7.8.7 and 8.5.2 loaders use the older export. Live2D's [5.3 compatibility guidance](https://docs.live2d.com/en/cubism-sdk-manual/compatibility-with-cubism-5-3/) distinguishes Native SDK R5 from R4 and earlier. Automatic installation uses the Native SDK version recommended for the Ren'Py version, reusing its archive when one is already downloaded. When Live2D no longer publishes that version, the newest published version on the same side of the R5 change is used, and its library must still provide the required exports. An explicitly requested archive version stays exact and reports an incompatibility instead of being replaced.

Live2D installation reads the dylib's Mach-O headers and symbol tables for every runtime CPU architecture and checks all required Cython exports, within fixed size limits. It never runs an imported library to inspect it. Before installation it checks the ZIP's directory paths, symlinks, encryption, duplicate members, sizes, deflate expansion and CRCs. An existing library is backed up with its checksum and mode. Removal restores that original only when the installed library and the backup still match their recorded checksums; otherwise the files are kept and an error is reported. Install records keep the supplier URL, the archive and library hashes, and whether a publisher digest was supplied and verified. A manual import is recorded as such.

Downloads use the shared progress and cancellation manager, validated official HTTPS URLs and limited archive sizes. Published digests are checked when supplied, and each downloaded ZIP gets a recorded SHA-256 checksum that it must match before reuse. Downloaded ZIPs stay in `userData/runtimes/live2d/<version>` for installation into another compatible SDK. The versioned download URLs come from the [download page and license terms](https://www.live2d.com/en/sdk/download/native/): its direct links and the download scripts it loads from live2d.com, such as the [Native SDK download script](https://cubism.live2d.com/sdk-native/js/download.js). Any live2d.com link to a `CubismSdkForNative-<version>.zip` archive is accepted, whatever its path. MacLauncher parses the published metadata without running the scripts. One confirmation covers both looking up and downloading the archive. Live2D binaries and archives are not bundled with MacLauncher.

The game inspector's **Libraries** group installs Live2D into the game's own macOS runtime instead. It changes only that runtime's existing library folder and keeps the record needed to undo it in the launcher's game data. A runtime copied by **Patch** uses the recorded SDK version, and a macOS runtime that was already in the game uses its detected version. Unknown versions and signed app bundles are refused. Installing Live2D never rewrites a model, script, archive or runtime executable.

## Tools

### Extraction and decompilation

**Extract** recovers the game's scripts with [rpatool](https://codeberg.org/shiz/rpatool), [unrpyc](https://github.com/CensoredUsername/unrpyc) and the module's UnRen compatibility routes. It unpacks RPA 2, 3 and 3.2 and RPI 1 archives, decompiles archived and loose `.rpyc` and `.rpymc` scripts to `.rpy`, and copies loose `.rpy`, `.rpym` and `.py` sources, which take precedence over archived versions. Saves and caches are not copied, and game scripts are never run.

Each extraction builds a new staging folder and replaces the previous output only after every required step succeeds, so a failed archive or script keeps the earlier extraction. Errors from individual files are collected across archive extraction and the decompilation of archived and loose scripts. Decompiler compatibility follows the script and Python generation, and unsupported or malformed scripts can fail an extraction. Only one extraction per game can run at a time.

The extraction options are `mode`, which is `auto` (default), `current` or `legacy`, and `tryHarder`, a boolean that defaults to false. Runtime fallback stays off. The decompiler mode does not change the game's runtime: the runtime manager still selects Ren'Py 7 with Python 2 or Ren'Py 8 with Python 3.

A successful extraction writes its report to `extracted/.maclauncher-renpy-tools-report.json`, and the last failure is recorded beside `extracted` in `extraction-last-failure.json`. Reports include the detected Ren'Py version, the options, the Python version used by the tools, the decompiler source versions, per-file results and logs, and limited process diagnostics. Paths under the temporary staging folder describe the attempted work, and `outputRoot` names the final destination. An extraction folder without a report is not treated as ready.

The included rpatool runs from its own extensionless executable at a fixed version; a globally installed rpatool Python package is not used. MacLauncher's code around rpatool validates RPA 2, 3 and 3.2 and RPI 1 index dictionaries, rejects object construction and reducer or global pickle opcodes, limits index and output sizes, and rejects destinations that leave the output folder or are symlinks. Index values are read as inert primitive records. Multi-part members and prefixes follow [Ren'Py's archive loader](https://github.com/renpy/renpy/blob/master/renpy/loader.py). RPI 1 needs its companion `.rpa` data file. Decompilation uses unrpyc's existing compatibility code.

### Ren'Py console

The cheats panel offers **Ren'Py console (Shift+O)**. It adds an `zz_maclauncher_console.rpy` file to the game and leaves the existing scripts untouched; the game must be restarted after the console is installed or removed. By default only `config.console` is enabled, and developer reload and fast skipping are optional.

In the game, Shift+O opens Ren'Py's [console](https://www.renpy.org/doc/html/developer_tools.html). The console can inspect and change live variables and ask Ren'Py to save a new slot through its normal serializer, which keeps runtime objects, rollback and the engine's signature handling intact. For a game with a `money` variable, for example, `money` shows its value, `money = 100` changes it and `save 99-1` writes a separate slot. The available variables and useful values depend on the game.

The console runs Python inside the running game, which the user has chosen to trust; it is separate from the read-only save inspection. A game can override console settings or key bindings. Removing the console deletes MacLauncher's source and compiled files. Conflicting third-party files and compiled-only files that cannot be verified are kept, with an error.

### Cheat add-ons

The cheats panel can also install two community add-ons: the Universal Ren'Py Walkthrough System and 0x52's Universal Ren'Py Mod (URM). [Cheats](../tools/CHEATS.md#renpy-cheat-add-ons) describes what each one installs.

## Backend API

The Ren'Py tools live in `src/modules/renpy/`. The backend helpers run in Node without Electron, and module actions expose them to the CLI and the launcher UI. The included copies of upstream tools are not edited; compatibility and archive checks live in the module's own code.

```sh
pnpm launch --game /Games/MyRenpyGame --action inspectSaveMetadata
pnpm launch --game /Games/MyRenpyGame --action inspectSaveMetadata \
  --payload '{"filePath":"/path/to/1-1-LT1.save"}'
pnpm launch --game /Games/MyRenpyGame --action extractGame \
  --payload '{"mode":"auto","tryHarder":false}'
pnpm launch --game /Games/MyRenpyGame --action installRenpyConsole
pnpm launch --game /Games/MyRenpyGame --action installRenpyConsole \
  --payload '{"developer":true,"fastSkip":true}'
pnpm launch --game /Games/MyRenpyGame --action removeRenpyConsole
```

- `inspectRenpySave(filePath)` and `listRenpySaves(directories)` in `save-inspect.js` inspect save metadata.
- `resolveSaveLocations(entry, context)` refreshes save locations from the game's code.
- `steam-consumer.js` and the shared `prepareSteamApi` callback prepare Steam integration without Electron.
- `live2d.js` exports lower-level target, status, import, download and removal functions. Module actions are `live2DStatus`, `patchLive2D` and `removeLive2D`. Import can also take `archivePath` or `filePaths` without the UI.
- `sdk-runtime-manager.performInstalledAction({installedActionId, sectionId, version, userDataDir, archivePath?, downloads?, signal?})` accepts `installLive2D`, `importLive2D` or `removeLive2D` for the `v7` and `v8` sections. `getState()` returns each row's `libraries.live2d` status and `actions` descriptors. The import action declares `inputKind: 'file'` and `extensions: ['zip']` for the launcher's file picker.

The Live2D functions are pure Node functions: loading the module or reading SDK status imports no Electron, runs no game and makes no network request.
