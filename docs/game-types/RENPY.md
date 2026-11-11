# Ren'Py

[Ren'Py](https://www.renpy.org/) is a visual-novel engine whose games are written in Ren'Py script and Python. MacLauncher runs a Ren'Py game with an official Ren'Py SDK, by patching the macOS runtime files into the game, or with a Mac app supplied with the game. The inspector also offers save inspection, Live2D setup, extraction and decompilation, an in-game console and cheat add-ons.

## Detection and versions

Import accepts a game folder, its `.sh` or `.py` launcher, its Windows executable, a Mac app, or a folder that contains only the `game` directory. In a release for several platforms, the Mac app can sit beside the Windows and Linux launchers without a copy of the game inside it. Selecting such an app imports the release folder around it, so the result is the same game as importing the folder. Ren'Py script and archive files (`.rpy`, `.rpyc`, `.rpa`, `.rpyb`) also identify a game, and a recognized Ren'Py layout takes priority over the generic macOS handling of `.sh` and `.py` launchers.

Each detected engine version is recorded with its source and a confidence level:

| Evidence | Confidence |
| --- | --- |
| A literal version in `renpy/vc_version.py`, or the selected tuple in `renpy/__init__.py` | exact |
| A complete standalone value in `script_version.txt` | reported |
| A major version only | inferred |

Ren'Py 7 and earlier use Python 2, and Ren'Py 8 uses Python 3. When a version tuple depends on this Python generation (7 or 8) and the game has no identifiable runtime Python libraries, the version stays unknown instead of taking the first branch.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Ren'Py SDK (default) | Official SDK from **Runtimes → Ren'Py** |
| Ren'Py Patch | macOS runtime files from the matching SDK, copied into the game |
| Game's macOS app | A Mac build supplied with the game |
| CrossOver, Sikarugir | Windows runtimes for the game's Windows executable |

### Ren'Py SDK

SDKs are installed from **Runtimes → Ren'Py**, which has two sections: Ren'Py (Python 2) for Ren'Py 7 and earlier, and Ren'Py 8, which also lists every later major version. The game's detected major version selects the section, so a game whose major version is unknown needs a manual choice.

To pick an SDK, Play uses the version chosen for the game (`runtimeData.sdk.version`) first, then the SDK that rebuilt the game or its detected Ren'Py version, and then the default of the matching section. For a recommendation or section default, Play uses an exact installed SDK first, otherwise the newest ready installed SDK of the same major. A Ren'Py 8.3.4 game can therefore use an installed 8.2.x SDK without download consent. Manual per-game SDK versions stay exact. Automatic selection never saves a per-game version. When an SDK installed from **Runtimes** is newer than its section's default, it becomes that section's default.

The available SDK versions are listed from [renpy.org/dl](https://www.renpy.org/dl/), with latest-stable hints from [latest.html](https://renpy.org/latest.html) and [latest-7.html](https://renpy.org/latest-7.html). Installation downloads an SDK archive and copies it with `ditto` to `userData/runtimes/sdk/<major>/<version>/`; disk images are handled with `diskutil image`, with an `hdiutil` fallback. When the version folder has a `checksums.txt`, the download must match the SHA-256 it lists. Before it checks readiness, installation also restores the Mac executables from packed `.macho` files, so `renpy.sh` can run without first opening the SDK launcher.

To find the runtime inside an SDK, discovery tries known Mac library folders in version order, including older `darwin-x86_64` layouts. If those names are absent, a bounded search under `lib/` finds the Mac Python and Ren'Py executables by their contents instead. The SDK installation then records the selected folder for later launches.

With the SDK, Play passes the selected original project directly to `renpy.sh` and uses that project as the working directory; for a game-only import, the selected game directory is used in the same way. Scripts, assets, compiled files, caches, logs and saves therefore follow Ren'Py's original project paths and configuration. Ordinary Play creates no private copy of the game and no links to its assets.

Earlier MacLauncher versions kept a private project for SDK launches. Play never reads or updates such a project, but files found only in it are recovered once to their original paths, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes: a file that differs from the original is kept beside it as a conflict copy, and an unsafe layout stays unchanged with its reason recorded. Package builds also use a separate build workspace of their own, so they do not change how Play runs the game.

### Ren'Py Patch

Ren'Py Patch runs the game with macOS runtime files copied into it. If the game is not patched yet, Play asks to patch it first. To do so, the **Patch** action downloads the matching SDK ZIP (`renpy-<version>-sdk.zip`) as a temporary download, separate from the installed SDKs in `userData/runtimes/sdk/`, and copies the macOS runtime files from it into the game. The inspector's **Ren'Py patch** group shows the patch status and can remove the patch.

### App bundles

With the selected SDK, the inspector's **Builds** group can also build a Mac app bundle from the game, and it can reveal or remove that bundle. A Mac app that comes with the game, on the other hand, runs as **Game's macOS app**.

### Python and Rosetta

Before running `renpy.sh`, SDK launches, patched launches and app builds check the selected native Python executable. The `mac-universal` folder of an older SDK can contain only Intel code, and on Apple silicon such an SDK needs [Rosetta](../runtimes/ROSETTA.md). MacLauncher asks to install Rosetta when it is missing, and declining cancels before the game starts. Native arm64 Python needs no Rosetta. These checks run in the backend, without Electron.

Shared graphics follow the architecture of the native executable in the selected SDK or patched runtime. An Intel platform selection stays Intel, and a folder named universal does not by itself mean Apple silicon support.

### Steam integration

To find out whether a game uses Steam, SDK and patched launches look for Steam API calls and explicit `achievement.register(..., steam=...)` registrations in the game's Python code, including Python 2 and 3 AST source kept inside compiled scripts and RPA archives. Comments, dialogue, translations and Ren'Py's bundled `00steam.rpy` provider do not count as a Steam dependency, and ordinary achievement registration remains a generic engine feature. Steam integration that the game disables stays disabled.

Steam integration also needs the game's application ID, which must come from literal game configuration or from Steam metadata inside the game and is never guessed. When the ID or a compatible helper is unavailable, optional Steam achievements keep the engine's normal fallback, whereas games that call the Steam API directly report a missing or conflicting ID.

For a game that uses Steam, MacLauncher first lists every native symbol that the selected runtime's own `steamapi` module requires, by running that module against stub function objects. The shared Steam API support then checks the game process's architecture and these exact exports, and it uses a compatible library from the game or the included helper. These requirements are cached by the contents of the `steamapi` module, and each Python generation and SDK release is inspected separately.

MacLauncher connects the game to that library with an init script, which redirects only the runtime's exact `libsteam_api.dylib` and `steam_appid.txt` paths. Ren'Py loads the script from an extra `RENPY_SEARCHPATH` directory that holds only the helper script and its state, with no game copies or links, while the original project remains the base, game and working directory. The SDK's Steam provider initializes normally, and development writes and deletions of the app ID stay in the helper's state. Other path joins, existence checks and ctypes loading behave as before, and the SDK and its global libraries are unchanged. [Steam support](../runtimes/STEAM_API.md) describes the helper versions.

## Saves

### Save locations

A Ren'Py game sets its save location in its own code, so MacLauncher reads the game's save configuration from that code whenever a library entry's details are refreshed. It reads loose `.rpy` source, the selected `.rpy` members of RPA 2, 3 and 3.2 archives, and configuration expressions kept in standard Python 2 and 3 `.rpyc` files, without extracting or launching anything. Translations are excluded, loose files override archived ones, and an existing extracted source folder takes precedence. The results are cached by source fingerprint and refreshed when the sources, archives or folders change.

A literal `config.save_directory` selects its exact save path, even before the folder exists. Safe nested names and Python raw and unicode string literals are accepted. The path then follows the runtime:

1. `RENPY_PATH_TO_SAVES`, when set.
2. A `Ren'Py Data` folder found above the selected SDK or native runtime.
3. `~/Library/RenPy/<name>`.

For example, `config.save_directory = "MyGame-1234"` resolves to `~/Library/RenPy/MyGame-1234` when no environment variable or portable folder overrides it. A `None` or empty name uses the running project's `game/saves`. Two other settings are also read: a safe absolute literal `config.savedir` overrides this calculation, and literal absolute lists or tuples in `config.extra_savedirs` add further save locations.

For SDK and patched launches, saves go to the original game's `game/saves` when no save-directory name is configured, and to Ren'Py's configured location otherwise. Native Mac bundles, by contrast, keep their own save locations. To find these folders, save discovery reads the original game's configuration and does not probe the private projects of earlier MacLauncher versions. **Save tools** can then choose between the detected folders without moving or rewriting saves.

Some configurations cannot be resolved: dynamic expressions, conditional or deferred assignments, conflicting settings, paths that leave the game and malformed literals. These stay unresolved, with a warning. An existing `game/saves` mirror can still be offered as an inferred location, but an unknown configured location is not replaced with a guess from the title. Without any setting, `game/saves` is the inferred location. A custom configuration outside the inspected scope may therefore need an explicit save-folder override. Options read from extracted sources follow the same rules. The same refresh also repairs stale blank or title-based paths in existing library entries, while explicit overrides are kept.

To read RPYC data without running it, the configuration reader passes it through a size-limited Node pickle stack machine whose globals, constructors, reducers and object state are inert records. The reader imports no Python classes, calls no reducer, and never unpickles or runs third-party code. It accepts only known configuration-bearing AST classes and literal expressions, and it does not decompile or evaluate arbitrary code. RPA indexes may contain only primitive values, so object, reducer and global opcodes are rejected. Additional save folders must be a single literal source line or a compiled literal expression.

The inspection has these limits:

- 16 MiB of decompressed archive index
- 8 MiB per script and 24 MiB of source in total
- 256 scripts, 32 archives, 64 folders and a folder depth of 3
- caps on pickle operations, collections, stack and memo size
- a traversal budget for compiled configuration, and caps on extracted assignments and expressions (shared conditional AST nodes stay unresolved)

### Save metadata

**Inspect save metadata** lists the `.save` files directly inside the configured save location and the game's local `game/saves` folder, then writes a report, which **Reveal metadata report** opens. A broken slot gets its own error, and the other slots are still inspected. Symlinked files and `persistent` are skipped.

For each slot, the report includes the readable JSON metadata and extra information, the Ren'Py version that the slot reports, the inferred Python generation, the ZIP member names and sizes, and whether a screenshot and signature are present. The report also records the detected game version and any SDK version configured for the game, and it warns when either differs from the version in the save. It is stored at `userData/games/<gameId>/modules/renpy/save-metadata.json`. Loading saves and checking signatures, however, is left to the selected Ren'Py runtime.

Because save metadata is treated as untrusted, the reader checks ZIP bounds, duplicate names, compression limits, the metadata CRC-32, UTF-8 and JSON structure. It does not read or decompress the `log` member, decode screenshots, verify signatures or load Python objects. Its limits are 512 MiB per slot, 128 ZIP members, 256 KiB of JSON, 32 KiB of extra information and 4 KiB of version text. Ordinary single-volume, unencrypted ZIP slots are accepted, and old standard ZIP slots without JSON can still be inspected.

Save editing is not available (`saveEditing` is `false`), because game stores, rollback state, references and custom classes cannot be rebuilt safely from the metadata. Ren'Py's [save implementation](https://github.com/renpy/renpy/blob/master/renpy/loadsave.py) writes the metadata and the pickled state into separate members, and its [signature checks](https://github.com/renpy/renpy/blob/master/renpy/savetoken.py) are part of the runtime's trust model, which MacLauncher does not bypass. Live state can be changed with the [Ren'Py console](#renpy-console) instead.

The Ren'Py module treats `.save` slots and `persistent` as save files, so shared import, export and snapshots copy them byte for byte without decoding either format.

## Live2D

Ren'Py games with Live2D models need the Live2D Cubism Core library in the SDK. For this, each installed SDK version in **Runtimes** has **Install Live2D**, **Import Live2D ZIP** and **Remove Live2D**.

- **Install Live2D** reads the official Native SDK download catalog, downloads a compatible archive, extracts only the macOS Core dylib and its license, and installs it next to that SDK's macOS `renpy` executable. Each SDK has its own copy.
- **Import Live2D ZIP** installs from an archive that is already on disk.
- During Play, MacLauncher can install a missing SDK together with its matching Live2D library when the game's loose files or RPA index contain `.moc3` or `.model3.json` assets. This check reads indexes only; it does not evaluate scripts or deserialize Python objects.

Before preparation, Play reserves the selected SDK version and Python generation, and a game that is using the SDK prevents changes to it. The SDK stays in use until the game exits, while other SDK versions stay independent. A Live2D download waits until no other change to that SDK is in progress and then checks the library again.

The Core library must provide the ordering export that the Ren'Py runtime requires:

| Ren'Py runtime | Required ordering export |
| --- | --- |
| SDK 7 and SDK 8 through 8.5.2 | `csmGetDrawableRenderOrders` |
| SDK 8.5.3 and later | `csmGetRenderOrders` |

The [Ren'Py 8.5.3 changelog](https://www.renpy.org/doc/html/changelog.html#id10) and its [native loader](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy/gl2/live2dcsm.pxi) document this change, and the SDK 7.8.7 and 8.5.2 loaders use the older export. On the Live2D side, the [5.3 compatibility guidance](https://docs.live2d.com/en/cubism-sdk-manual/compatibility-with-cubism-5-3/) distinguishes Native SDK R5 from R4 and earlier. Automatic installation uses the Native SDK version recommended for the Ren'Py version, and it reuses that version's archive when one is already downloaded. When Live2D no longer publishes that version, the newest published version on the same side of the R5 change is used instead, and its library must still provide the required exports. An explicitly requested archive version, by contrast, stays exact and reports an incompatibility instead of being replaced.

Live2D installation reads the dylib's Mach-O headers and symbol tables for every runtime CPU architecture and checks all required Cython exports, within fixed size limits, and it never runs an imported library to inspect it. Before installation, it also checks the ZIP's directory paths, symlinks, encryption, duplicate members, sizes, deflate expansion and CRCs. An existing library is backed up with its checksum and mode, and removal restores that original only when the installed library and the backup still match their recorded checksums. Otherwise, the files are kept and an error is reported. Install records keep the supplier URL, the archive and library hashes, and whether a publisher digest was supplied and verified, and a manual import is recorded as such.

Live2D binaries and archives are not bundled with MacLauncher. Instead, the versioned download URLs come from the [download page and license terms](https://www.live2d.com/en/sdk/download/native/): its direct links and the download scripts it loads from live2d.com, such as the [Native SDK download script](https://cubism.live2d.com/sdk-native/js/download.js). MacLauncher parses the published metadata without running these scripts, and it accepts any live2d.com link to a `CubismSdkForNative-<version>.zip` archive, whatever its path. One confirmation covers both looking up and downloading the archive. Downloads use the shared progress and cancellation manager, validated official HTTPS URLs and limited archive sizes. Published digests are checked when supplied, and each downloaded ZIP gets a recorded SHA-256 checksum that it must match before reuse. Downloaded ZIPs also stay in `userData/runtimes/live2d/<version>`, so they can be installed into another compatible SDK.

Live2D can also be installed for a single game without changing an SDK. The game inspector's **Libraries** group installs it in the game's launcher data, at `userData/games/<gameId>/modules/renpy/libraries/live2d/`, and an init script loaded through `RENPY_SEARCHPATH` redirects only the native Core loader to that verified absolute library path. Core is then loaded when the game first requests it, and the original project's files, working directory, interpreter and native libraries stay unchanged. To match the library to the game's runtime, a runtime copied by **Patch** uses the recorded SDK version, and a macOS runtime that was already in the game uses its detected version. Unknown versions and signed app bundles are refused.

## Tools

### Extraction and decompilation

**Extract** recovers the game's scripts with [rpatool](https://codeberg.org/shiz/rpatool), [unrpyc](https://github.com/CensoredUsername/unrpyc) and the module's UnRen compatibility routes. It unpacks RPA 2, 3 and 3.2 and RPI 1 archives and decompiles archived and loose `.rpyc` and `.rpymc` scripts to `.rpy`. Loose `.rpy`, `.rpym` and `.py` sources are copied as they are and take precedence over archived versions. Saves and caches are not copied, and game scripts are never run.

Each extraction builds a new staging folder, and the previous output is replaced only after every required step succeeds, so a failed archive or script keeps the earlier extraction. Errors from individual files are collected across archive extraction and the decompilation of archived and loose scripts. Which scripts the decompiler can handle depends on the script and Python generation, and unsupported or malformed scripts can fail an extraction. Only one extraction per game can run at a time.

Extraction takes two options: `mode`, which is `auto` (default), `current` or `legacy`, and `tryHarder`, a boolean that defaults to false. Runtime fallback stays off. The decompiler mode does not change the game's runtime, so the runtime manager still selects Ren'Py 7 with Python 2 or Ren'Py 8 with Python 3.

A successful extraction writes its report to `extracted/.maclauncher-renpy-tools-report.json`, and the last failure is recorded beside `extracted` in `extraction-last-failure.json`. Reports include the detected Ren'Py version, the options, the Python version used by the tools, the decompiler source versions, per-file results and logs, and limited process diagnostics. In them, paths under the temporary staging folder describe the attempted work, and `outputRoot` names the final destination. An extraction folder without a report is not treated as ready.

The included rpatool runs from its own extensionless executable at a fixed version, and a globally installed rpatool Python package is not used. Around it, MacLauncher's own code validates RPA 2, 3 and 3.2 and RPI 1 index dictionaries, rejects object construction and reducer or global pickle opcodes, limits index and output sizes, and rejects destinations that leave the output folder or are symlinks. Index values are read as inert primitive records, and multi-part members and prefixes follow [Ren'Py's archive loader](https://github.com/renpy/renpy/blob/master/renpy/loader.py). An RPI 1 archive needs its companion `.rpa` data file. For decompilation, unrpyc's existing compatibility code is used.

### Ren'Py console

Ren'Py has a developer console, which the cheats panel can enable with **Ren'Py console (Shift+O)**. This option adds a `zz_maclauncher_console.rpy` file to the game and leaves the existing scripts untouched, and the game must be restarted after the console is installed or removed. By default, only `config.console` is enabled, while developer reload and fast skipping are optional.

In the game, Shift+O opens Ren'Py's [console](https://www.renpy.org/doc/html/developer_tools.html). The console can inspect and change live variables and ask Ren'Py to save a new slot through its normal serializer, which keeps runtime objects, rollback and the engine's signature handling intact. For a game with a `money` variable, for example, `money` shows its value, `money = 100` changes it and `save 99-1` writes a separate slot. The available variables and useful values depend on the game.

The console runs Python inside the running game, which the user has chosen to trust, and it is separate from the read-only save inspection. A game can override console settings or key bindings. Removing the console deletes MacLauncher's source and compiled files, but conflicting third-party files and compiled-only files that cannot be verified are kept, with an error.

### Cheat add-ons

The cheats panel can also install two community add-ons: the Universal Ren'Py Walkthrough System and 0x52's Universal Ren'Py Mod (URM). URM is installed from a `0x52_URM.rpa` file that is chosen in a file dialog. MacLauncher checks the file's RPA header and keeps a private copy, so later installations need neither a new selection nor a download. To use a different file, **Choose another Universal Ren'Py Mod file…** replaces that copy with the newly chosen file and installs it into the selected game; canceling, or choosing an invalid file, keeps the previous copy. [Cheats](../tools/CHEATS.md#renpy-cheat-add-ons) describes what each add-on installs.

## Backend API

The Ren'Py tools are in `src/modules/renpy/`. Their backend helpers run in Node without Electron, and module actions expose them to the CLI and the launcher UI. The included copies of upstream tools are not edited; instead, compatibility and archive checks live in the module's own code.

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
