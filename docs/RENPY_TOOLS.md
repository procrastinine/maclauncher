# Ren'Py inspection, extraction and console tools

Ren'Py tools are implemented under `src/modules/renpy/`. The backend helpers work in Node without Electron; module actions expose them to the CLI and the declarative launcher UI. Inspection and local tool actions work offline. Missing runtime prerequisites are downloaded only through an explicit action and its confirmation callback. Vendored repositories remain read-only; compatibility and archive checks live in module-owned adapters.

## Save metadata

The game details include **Inspect save metadata** and **Reveal metadata report**. Inspection searches the configured save location and the game's local `game/saves` folder, listing direct `.save` files. A broken slot produces an individual error while other slots are inspected. Symlinked files and `persistent` are excluded.

The report contains the readable JSON metadata, extra information, reported Ren'Py version, inferred Python generation, ZIP member names/sizes, and screenshot/signature presence. It also records the detected game version and any explicitly configured SDK version. Differences between these versions and the saved version produce warnings; successful metadata inspection establishes no load compatibility.

The report is stored at `userData/games/<gameId>/modules/renpy/save-metadata.json`. Metadata is untrusted information. The inspector checks ZIP bounds, duplicate names, compression limits, metadata CRC32, UTF-8 and JSON structure. It does **not** read/decompress the `log`, decode screenshots, verify signatures, or load Python objects. Limits are 512 MiB per slot, 128 ZIP members, 256 KiB JSON, 32 KiB extra information, and 4 KiB version text. The reader accepts ordinary single-volume, unencrypted ZIP slots. Old standard ZIP slots without JSON remain inspectable.

```sh
pnpm launch --game /Games/MyRenpyGame --action inspectSaveMetadata
pnpm launch --game /Games/MyRenpyGame --action inspectSaveMetadata \
  --payload '{"filePath":"/path/to/1-1-LT1.save"}'
```

`inspectRenpySave(filePath)` and `listRenpySaves(directories)` in `save-inspect.js` are reusable backend functions. `saveEditing` remains `false`: game stores, rollback state, references and custom classes cannot be safely reconstructed from this metadata. The [upstream save implementation](https://github.com/renpy/renpy/blob/master/renpy/loadsave.py) writes metadata and the pickled state into separate members; [signature checks](https://github.com/renpy/renpy/blob/master/renpy/savetoken.py) belong to the runtime's trust model. No token/signature behavior is bypassed.

The module declares `.save` slots and `persistent` as save files for shared byte-preserving import/export and snapshots. This filter provides no codec for either format.

### Runtime prerequisites

SDK launch, patched launch and app building inspect the selected native Python executable before invoking `renpy.sh`. An older SDK's `mac-universal` folder may contain only Intel code. On Apple silicon, the shared Rosetta service reuses the installed system component or requests Apple's licensed installation through the supplied backend confirmation callback. Declining cancels before the game starts. Native arm64 Python needs no Rosetta prompt. These hooks run without Electron.

Shared graphics uses the selected SDK or patched runtime's native executable architecture. An Intel platform selection remains Intel; a universal folder name alone does not establish Apple Silicon support.

### Steam integration

SDK and patched launch detect Steam API calls and explicit `achievement.register(..., steam=...)` registrations in the game's Python bodies, including retained Python 2/3 AST source inside compiled scripts and RPA archives. Comments, dialogue, translations and Ren'Py's bundled `00steam.rpy` provider do not establish a game dependency. Ordinary achievement registration remains a generic engine feature. Explicitly disabled Steam integration remains disabled. An application ID must come from literal game configuration or scoped game-local Steam metadata; identities are never guessed. Optional Steam achievements retain the normal engine fallback when identity or a compatible helper is unavailable; direct Steam API consumers report missing/conflicting identities.

For a positive consumer, the selected runtime's trusted `steamapi` module is inspected against inert function objects to identify every native symbol it binds. The shared Steam service checks the child's architecture and these exact exports, reuses a compatible game library or selects the explicitly versioned bundled helper. Requirements are cached by the actual provider bytes; Python generation and SDK releases are inspected separately.

An owned init script in the per-game project redirects only the runtime's exact `libsteam_api.dylib` and `steam_appid.txt` paths. Its SDK provider can initialize normally, while development app-ID writes and deletes stay in per-game state. Ordinary path joins, existence checks and ctypes loading retain their behavior. Assets remain linked to the original game; the SDK, original scripts and global SDK libraries are unchanged. Patched launch uses this private project only for a detected Steam consumer. The pure Node backend helpers in `steam-consumer.js` and the shared `prepareSteamApi` callback work without Electron.

### Automatic save locations

`resolveSaveLocations(entry, context)` refreshes save locations from the game's code during backend hydration. It reads loose `.rpy` source, selected `.rpy` members inside RPA 2/3/3.2 archives, and configuration expressions retained in standard Python 2/3 `.rpyc` files. No extraction, game launch or network request is needed. Translations are excluded, loose counterparts override archived files, and an existing extracted source root takes precedence. Source fingerprints cache inspection and invalidate after source/archive or directory changes.

A literal `config.save_directory` selects its exact path, including before the directory exists. Safe nested names and Python raw/unicode quoted literals are accepted. Path selection follows the known runtime: `RENPY_PATH_TO_SAVES`, a `Ren'Py Data` directory found above the selected SDK or native runtime base, then `~/Library/RenPy/<name>`. `None` or an empty name uses the running project's `game/saves`. A safe absolute literal `config.savedir` overrides this calculation. Literal absolute lists/tuples in `config.extra_savedirs` add separate locations. For the SDK, the local mirror belongs to `userData/games/<gameId>/modules/renpy/projects/<sdkVersion>/game/saves`; source game assets remain linked and the original game does not receive compilation/cache/save writes. Existing original `game/saves` remains discoverable for prior saves. Native Mac bundles omit the engine mirror. Save Tools can choose among detected roots without moving or rewriting saves.

Dynamic expressions, conditional/deferred assignments, conflicting settings, traversing paths and malformed literals remain unresolved and carry a warning. An existing `game/saves` mirror can still be offered as an inferred location; the unknown configured primary is not replaced with a title guess. When no setting is found, `game/saves` is the inferred engine-local location. A custom configuration outside the bounded inspection scope may require an explicit folder override. Extracted options use the same policy, and hydration repairs stale blank or title-guessed paths in existing records while preserving explicit user overrides.

RPYC inspection uses a bounded Node pickle stack machine whose globals, constructors, reducers and object state are inert records. It imports no Python classes, calls no reducer and never unpickles or executes third-party code. It accepts only known configuration-bearing AST classes and literal expressions; it does not decompile or evaluate arbitrary code. RPA indexes are restricted to primitives and reject object/reducer/global opcodes. Bounds include 16 MiB decompressed archive indexes, 8 MiB per script, 24 MiB aggregate source, 256 scripts, 32 archives, 64 directories/depth 3, and pickle operation, collection, stack and memo caps. Compiled configuration adds a traversal budget and caps extracted assignments/expressions; shared conditional AST nodes remain unresolved. Inspection follows regular source members and the declared literal pickle operations. Additional save directories must be a single literal source line or compiled literal expression.

For example, a literal `config.save_directory = "MyGame-1234"` resolves to `~/Library/RenPy/MyGame-1234` without environment or portable overrides.

Detected engine versions record their source and confidence. A literal `renpy/vc_version.py` version or selected `renpy/__init__.py` tuple is `exact`; a complete standalone `script_version.txt` value is `reported`, while a major-only value is `inferred`. A Python-dependent 7/8 tuple without identifiable runtime Python libraries is unknown rather than selecting its first branch.

## Extraction and decompilation

The **Extract** action builds a fresh staging directory and promotes it only after all required phases succeed. A failed archive or compiled script preserves the previous extraction. Errors from individual files are collected across archive extraction, archived-script decompilation, and loose-script decompilation. Loose `.rpy`, `.rpym` and `.py` sources are copied with filesystem precedence over archived versions; saves and caches are excluded from this copy.

```sh
pnpm launch --game /Games/MyRenpyGame --action extractGame \
  --payload '{"mode":"auto","tryHarder":false}'
```

Options are explicit: `mode` accepts `auto` (default), `current`, or `legacy`; `tryHarder` is a boolean (default false). Runtime fallback remains off. The existing runtime manager continues to select Ren'Py 7/Python 2 versus Ren'Py 8/Python 3; selecting a decompiler mode does not change the game's runtime version.

Successful reports live in `extracted/.maclauncher-renpy-tools-report.json`. The last failed report lives beside `extracted` at `extraction-last-failure.json`. Reports include the detected Ren'Py version, options, actual tool Python version, decompiler source versions, per-file results/logs and bounded process diagnostics. Paths under temporary staging describe the attempted work; `outputRoot` identifies the promoted destination. An unrecorded extraction directory is no longer treated as ready. Concurrent extractions for one game are rejected.

The bundled rpatool is loaded from its pinned, extensionless executable rather than a globally installed Python package. A module overlay validates RPA 2/3/3.2 and RPI 1 index dictionaries, rejects object construction and reducer/global pickle opcodes, bounds indexes and output, and rejects traversal or symlink destinations. Multi-part members and prefixes are read using [Ren'Py's archive loader semantics](https://github.com/renpy/renpy/blob/master/renpy/loader.py). RPI 1 requires the companion `.rpa` data file. Index values use inert primitive records; object construction and reducer execution remain outside archive decoding. Decompilation uses the existing unrpyc compatibility machinery; game scripts are not executed.

## Opt-in console

The cheats panel offers **Ren'Py console (Shift+O)**. Installation adds an owned `zz_maclauncher_console.rpy` file and leaves existing scripts untouched. Restart the game after installing or removing. The default enables only `config.console`; it does not enable developer reload or fast skipping. The console can inspect/change live variables and ask Ren'Py to save a new slot through its normal serializer, preserving runtime object/rollback behavior and the engine's signature handling.

```sh
pnpm launch --game /Games/MyRenpyGame --action installRenpyConsole
pnpm launch --game /Games/MyRenpyGame --action installRenpyConsole \
  --payload '{"developer":true,"fastSkip":true}'
pnpm launch --game /Games/MyRenpyGame --action removeRenpyConsole
```

Inside the game, Shift+O opens the [documented console](https://www.renpy.org/doc/html/developer_tools.html). For a game with a `money` variable, inspect it with `money`, change it with `money = 100`, then use `save 99-1` to create a separate slot. Actual variables and useful values depend on each game. This executes Python inside the already running, explicitly trusted game; it is separate from offline save inspection/editing. A game may override console settings or keybindings. Removing the patch removes owned source/compiled caches; conflicting third-party files or unverifiable compiled-only files are preserved and produce an error.

## Limits

Variable changes use console actions through the selected runtime and game settings.
