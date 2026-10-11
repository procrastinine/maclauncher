# Module system

MacLauncher is module-first. The launcher never hard-codes per-engine branches; it discovers modules at runtime and drives UI and behavior from module metadata.

This doc describes the module contract, detection pipeline, and how modules integrate into UI, settings, runtimes, saves, and cheats.

## Modules and backends

A **module** owns detection, game metadata, engine-specific actions and launch preparation. A **backend** is one runtime choice within that module. A **runtime manager** supplies versions and installations for a backend or tool. These are separate contracts: GameMaker is one module with OpenGMK, Butterscotch and official runner backends; AliceSoft is one module with three engine generations; the HTML modules share one NW.js manager.

The registry currently discovers **31 game-type modules**. The tables list their declared runtime IDs, including inspection-only entries. A registered module or runtime ID does not by itself establish playback compatibility. Each guide describes format, version, architecture and native-extension limits.

### Common engines and HTML exports

| Module | Runtime backends / tools | Guide |
| --- | --- | --- |
| `gamemaker` | `opengmk` ([OpenGMK](https://github.com/OpenGMK/OpenGMK)), `butterscotch` ([Butterscotch](https://github.com/ButterscotchRunner/Butterscotch)), `official-studio` ([GameMaker](https://gamemaker.io/)), `native`, `inspection`; decompilers | [GameMaker](runtimes/GAMEMAKER.md) |
| `mv` | `electron`, `nwjs`, `nwjs-patched`, `native`; cheats, asset tools and save editing | [RPG Maker MV/MZ](runtimes/RUNTIMES.md), [save editor](MVMZ_SAVE_EDITOR.md) |
| `mz` | `electron`, `nwjs`, `nwjs-patched`, `native`; cheats, asset tools and save editing | [RPG Maker MV/MZ](runtimes/RUNTIMES.md), [save editor](MVMZ_SAVE_EDITOR.md) |
| `rgss` | `mkxpz` ([MKXP-Z](https://github.com/mkxp-z/mkxp-z)); RPG Maker XP/VX/VX Ace, scripts and cheats | [MKXP-Z](runtimes/MKXPZ.md), [RGSS tools](RGSS_TOOLS.md) |
| `unity` | `unity` ([Unity](https://unity.com/) Mono player), `native`; exact-version player replacement | [Unity Mono](runtimes/UNITY.md) |
| `fna` | `fna` ([FNA](https://github.com/FNA-XNA/FNA) / XNA 4 managed host), `native`; managed decompilation | [FNA](runtimes/FNA.md) |
| `godot` | `godot` ([Godot](https://github.com/godotengine/godot)), `native`; recovery tools | [Godot](runtimes/RUNTIMES.md#godot) |
| `love` | `love` ([LÖVE](https://github.com/love2d/love)), `native`; archives, fused exports and AppImages | [LÖVE](runtimes/LOVE.md) |
| `java` | `java` ([Temurin](https://github.com/adoptium/temurin-build)); decompilation and exact JNI bridges | [Java](runtimes/RUNTIMES.md#temurin--vineflower), [Steam bridges](runtimes/JAVA_STEAM.md) |
| `flash` | `projector` (Adobe Flash Player), `ruffle` ([Ruffle](https://github.com/ruffle-rs/ruffle)) | [Flash](runtimes/RUNTIMES.md#ruffle--flash-player) |
| `construct` | `electron`, `nwjs`, `nwjs-patched`, `native`; Construct 2/3 exports | [HTML hosts](runtimes/RUNTIMES.md) |
| `tyrano` | `electron`, `nwjs`, `nwjs-patched`, `native`; Tyrano/KAG HTML exports | [HTML hosts](runtimes/RUNTIMES.md) |
| `gamemaker-html5` | `electron`, `nwjs`, `native`; [GameMaker HTML5](https://github.com/YoYoGames/GameMaker-HTML5) exports | [HTML hosts](runtimes/RUNTIMES.md) |
| `web` | `electron`, `nwjs`, `nwjs-patched`, `native`; generic HTML fallback | [HTML hosts](runtimes/RUNTIMES.md) |

The HTML hosts are [Electron](https://github.com/electron/electron) and [NW.js](https://github.com/nwjs/nw.js). Electron game windows use the separate game host and module preload; they do not run in the launcher window.

### Visual novels

| Module | Runtime backends / tools | Guide |
| --- | --- | --- |
| `renpy` | `sdk`, `patched`, `native` ([Ren'Py](https://github.com/renpy/renpy)); Python-generation detection, save metadata, decompilation, cheats and Live2D | [Ren'Py](runtimes/RUNTIMES.md#renpy), [tools](RENPY_TOOLS.md), [Live2D](runtimes/RENPY_LIVE2D.md) |
| `nscripter` | `onsyuri_mac`, `onsyuri_web` ([Onscripter-Yuri](https://github.com/YuriSizuku/OnscripterYuri)), `onscripter_en` ([ONScripter-EN](https://github.com/Galladite27/ONScripter-EN)), `external` | [NScripter](runtimes/NSCRIPTER.md) |
| `alicesoft` | `system3` ([System3](https://github.com/kichikuou/system3-sdl2)), `xsystem35` ([xsystem35](https://github.com/kichikuou/xsystem35-sdl2)), `xsystem4` ([xsystem4](https://github.com/nunuhara/xsystem4)); compiler/decompiler tools | [AliceSoft](runtimes/VN_ENGINES.md) |
| `kirikiri` | `krkrsdl2` ([krkrsdl2](https://github.com/krkrsdl2/krkrsdl2) / [KAG3](https://github.com/krkrsdl2/kag3)); compatible XP3/script profiles | [KiriKiri](runtimes/VN_ENGINES.md) |
| `ai5` | `ai5` ([AI5-SDL2](https://github.com/nunuhara/ai5-sdl2)); configuration/archive and original-disc profiles | [AI5WIN](runtimes/AI5.md) |
| `siglus` | `siglus` ([siglus_rs](https://github.com/xmoezzz/siglus_rs)) for Siglus, RealLive and AVG32; `rlvm` ([RLVM](https://github.com/eglaysher/rlvm)) for RealLive archives | [Siglus / RealLive](runtimes/SIGLUS.md) |
| `mages` | `impacto` ([Impacto](https://github.com/CommitteeOfZero/impacto)); Windows HD native beta and MPK/SC3 tools | [MAGES.](runtimes/MAGES.md) |
| `nitroplus` | `npengine` ([NPengine](https://github.com/FGRE/libnpengine) / [libnpa](https://github.com/FGRE/libnpa)); NPA/NSS tools and limited native VM | [Nitroplus](runtimes/NITROPLUS.md) |
| `vnds` | `vnds_love` ([VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) hosted by LÖVE); converted exports and save editing | [VN engines](runtimes/VN_ENGINES.md) |
| `bgi` | `bgi-tools`; BGI/Ethornell archive/program tools, [OpenBGI](https://github.com/Cytlan/openbgi) VM remains incomplete | [BGI](runtimes/VN_ENGINES.md) |
| `catsystem2` | `catsystem2-tools`; encrypted KIF, CatScene, CSTL and FES tools; native gameplay unsupported | [CatSystem2](runtimes/CATSYSTEM2.md) |
| `minori` | `reminori` ([ReMinori](https://github.com/luoyily/ReMinori)); selected PAZ native beta, private saves and script tools on Apple Silicon | [Minori](runtimes/MINORI.md) |

### Other game types

| Module | Runtime backends / tools | Guide |
| --- | --- | --- |
| `gemrb` | `gemrb` ([GemRB](https://github.com/gemrb/gemrb)); compatible Infinity Engine resources | [Other engines](runtimes/OTHER_ENGINES.md) |
| `ikemen` | `ikemen` ([Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO)); MUGEN-compatible content | [Other engines](runtimes/OTHER_ENGINES.md) |
| `hashlink` | `hashlink` ([HashLink](https://github.com/HaxeFoundation/hashlink)); bytecode and native-module ABI profiles | [Other engines](runtimes/OTHER_ENGINES.md) |
| `haxe` | `inspection`; Windows [Haxe](https://haxe.org/) C++ builds using [hxcpp](https://github.com/HaxeFoundation/hxcpp) / [Lime](https://github.com/openfl/lime), without macOS playback | [Other engines](runtimes/OTHER_ENGINES.md) |
| `generic-app` | `native`; existing macOS app bundles and quarantine repair | [User guide](README.md) |

### Managers and shared services

Managers are registered once by ID, even when several modules use them. Engine-owned playback managers include `mkxpz`, `sdk`, `godot`, `love`, `java`, `ruffle`, `fna`, `unity`, `butterscotch`, `opengmk`, `gamemaker-official`, `system3`, `xsystem35`, `xsystem4`, `krkrsdl2`, `onscripter-en`, `ai5`, `siglus`, `rlvm`, `npengine`, `impacto`, `reminori`, `gemrb`, `ikemen` and `hashlink`. Versioned tools include [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool), [GM8Decompiler](https://github.com/OpenGMK/OpenGMK), [sys3c](https://github.com/kichikuou/sys3c) and [xsys35c](https://github.com/kichikuou/xsys35c). Backend IDs can differ from manager IDs: `official-studio` uses `gamemaker-official`.

The `nwjs`, `onsyuri`, `innoextract` and `ilspy` managers are discovered from `src/modules/shared/`. [ILSpy](https://github.com/icsharpcode/ILSpy) manages C# export tool versions and compatible .NET hosts for FNA and Unity. The [installer reader](runtimes/INSTALLERS.md) unpacks supported offline installers before normal engine detection; it is shared import infrastructure. Greenworks is an NW.js manager section, not a separate game type. Shared Steam API resolution, runtime catalogs, native payload verification, Rosetta checks, save snapshots, icons and preparation utilities also live in the shared namespace.

Version choices and release fetching use the [shared catalog contract](runtimes/RUNTIME_CATALOGS.md). Included helpers and players execute from verified application resources; downloadable versions use the manager's userData directory. [Distribution declarations](runtimes/RUNTIME_DISTRIBUTION.md) describe the exact payload, CPU, macOS floor, source revision and build recipe.

## Goals
- Extensible: adding a new module automatically appears in the UI, settings, and runtime manager lists.
- Modular: engine-specific logic and assets live inside the module directory.
- Uniform: modules follow the same file layout and data conventions.
- Safe: network access is only used behind explicit user actions (runtime catalog refresh/install).

## Standard module layout
Each module lives in `src/modules/<moduleId>/` and uses a consistent layout:
- `manifest.json` (required): metadata and UI contract.
- `main.js` (required): module hooks and runtime integrations.
- `detect.js` (optional): detection helpers (imported by `main.js`).
- `electron.js` (optional): electron runtime bootstrap (loaded by `src/modules/shared/web/preload/game.js`) for engine-specific shims and setup.
- `runtime/` (optional): runtime managers, patchers, installers, wrappers.
- `libs/` (optional): library catalog + patcher.
- `resources/` (optional): bundled assets required by the module.
  Large third-party bundles can live under `src/external/` instead of `resources/` to avoid duplication.
  If a module depends on new `src/external` assets, add the needed subpaths to `build.extraResources`.
- `resources/icon.png` (required for game-type modules): recorded default artwork when no original icon is available.

Do not reference other modules directly from a module. Share code in `src/modules/shared/` instead.
`shared/` is a special namespace for cross-module code. It is not a module (no manifest),
but the registry records its subdirectories as shared submodules for internal wiring.
Shared submodules never appear in the UI and do not need `manifest.json`.
If a shared submodule contains `runtime/*.js` files that export runtime manager objects,
they are auto-registered globally.

## Manifest reference
`manifest.json` is the module contract read by the launcher UI.

Required fields:
- `id`: stable module id (folder name, lowercase recommended).
- `family`: family label for grouping similar modules.
- `label`: full display name.
- `shortLabel`: short display name.
- `gameType`: broad type string (for grouping and UI labels).

Runtime config:
- `runtime.default`: default runtime id (for new entries).
- `runtime.supported`: runtime ids to show in the runtime dropdown.
- `runtime.entries`: optional map of runtime id -> runtime metadata.
  - `label`: display label.
  - `settings`: optional runtime settings schema (`defaults`, `fields`).
- `runtime.hosted`: optional hosted-runtime config (`id`, optional `fallback`, optional `userAgent`).
  - `userAgent.suffix` supports `{nwjsVersion}` to insert the configured NW.js runtime version.
- `runtime.manager`: optional map of runtime id -> runtime manager id.
- `runtime.managerSectionBy`: optional map of runtime id -> entry field name to select a manager section.
- `runtime.managerSectionOverrideKey`: optional map of runtime id -> per-game `runtimeData` key used to override manager section selection.
- `runtime.managerSectionMap`: optional map of runtime id -> map of entry values to section ids.
- `runtime.preLaunch`: optional map of runtime id -> pre-launch checks (`statusAction`, `readyWhen`, `fixAction`, optional `declineAction`, optional `prompt`).

Runtime settings schema:
- `defaults`: key/value map for global runtime settings defaults.
- `fields`: list of field definitions (`key`, `type`, `label`, optional `description`, optional `default`).
- Supported `type` values: `boolean`, `number`, `string`, `select`, `list`.
- `select` fields require `options` entries with `{ value, label }`.
- `list` fields store string arrays; the UI accepts one entry per line (commas also supported).

Supports flags:
- `supports.cheats`: module exposes a cheat schema/runtime.
- `supports.cheatsPatcher`: module supports tools patching on disk.
- `supports.saveEditing`: module supplies a JSON save codec.
- `supports.saveLocation`: module provides a reliable save directory for the game detail panel.
- `supports.structuredSaveEditing`: optional structured-edit UI capability, advertised alongside `save.structured` action IDs.
- `detection`: manifest-owned input kinds, extension ownership, cheap markers/signatures, artifact probes and fallback policy; see [DETECTION.md](DETECTION.md).

Other fields:
- `settingsDefaults`: per-module settings defaults (drives Settings UI sections).
- `ui.infoFields`: list of extra fields for the game detail panel.
- `ui.actions`: list of module actions (patch/build/probe/etc).
- `ui.actionGroups`: ordering and grouping of actions in the UI.
- `acknowledgments`: list of `{ label, url }` credits. Give separate dependencies their own upstream links, including tools and source references, and retain applicable license notices. Credits combines this list with `src/modules/shared/acknowledgments.json`; see [attributions](ATTRIBUTIONS.md).

### UI field and action schema
`ui.infoFields` entries:
- `key`: dotted path into the game entry (for example, `moduleData.version`).
- `label`: display label.
- `format`: optional `boolean`, `date`, `path`, or `string`.
- `empty`: placeholder text when the value is missing.
- `hiddenWhen`: array of conditions to hide the field.

`ui.actions` entries:
- `id`, `label` (required)
- `kind`: `primary`, `secondary`, or `danger`.
- `confirm`: confirmation prompt text.
- `autoRun`: run on expand (status probes).
- `resultFields`: list of info fields to display after action.
- `disabledWhen` / `hiddenWhen`: array of conditions.

Conditions:
- `key`: dotted path in the game entry or action result.
- `equals`, `notEquals`, `truthy`, `falsy`, `endsWith`.

`ui.actionGroups` entries:
- `id`, `label`
- `actions`: ordered list of action ids.
- `note`: optional text displayed in the detail panel.

When groups are declared, only their listed actions appear in inspector tool groups. Assign every intended inspector tool to a group; actions used by dedicated cheats controls or automatic status queries can remain outside those groups. With no declared groups, the inspector uses the action list directly.

## Module hooks (main.js)
A module can implement any subset of these hooks:

- `detectGame(context, helpers)`
  - Returns a detection object or `null`.
  - `context` includes `inputPath`, `rootDir`, `isAppBundle`, and `stat`.
  - `helpers.findIndexHtml` is provided by the registry.

- `mergeEntry(existing, incoming, settings)`
  - Optional hook to merge per-game data before normalization.

- `onImport(entry, context)`
  - Called when a game is first added to the library.
  - `context` includes `userDataDir`, `settings`, and `logger`.
  - Use for one-time setup like staging bundled assets (no background network).

- `prepareInput(entry, context)`
  - Optional synchronous hook for imports, launches, module/tool actions and direct save operations. It may return a transient runtime/tool entry with remapped content paths.
  - Source-reading actions use the canonical `sourceEntry`; runtime, patch and plugin actions use the writable view.
  - Preserve the original entry's `gameId`, `gamePath`, `importPath`, `contentRootDir`, `indexDir`, `indexHtml` and `containerData`. Per-game `moduleData`, `defaultSaveDir` and unsafe in-container save overrides may resolve to launcher-owned outputs.
  - `context.readOnly: true` permits path calculation and existing-view reads without creating directories or copying files. Check `context.signal` before and during preparation.
  - Use real directory scaffolding, private mutable files and immutable asset links. Plugin/library writes must atomically replace linked leaf files instead of modifying the original target. See [writable input views](GAME_PREPARATION.md#writable-input-views).

- `getContentReadRoots(entry, context)`
  - Optional declaration of this game's original immutable content roots for read-only HTTP asset serving. The ordinary contained-root policy remains the default; declarations must not admit unrelated directories.

- `cleanupGameData(entry, context)`
  - Called during exclusive per-game removal after launches, tools and save actions have stopped or finished.
  - Use to delete per-game data stored under `userData/games/<gameId>/` (extracted bundles, wrappers, builds, etc).
  - `context` includes `userDataDir`, `settings`, `logger`, `gameId`, `gamePath`, and `moduleId`.

- `filterRuntimeSupport(entry, supported, moduleSettings)`
  - Returns a filtered runtime list for a specific game.

Selecting a different runtime refreshes its module-provided save locations in the backend worker before the updated inspector state is returned.

- `normalizeRuntimeId(runtimeId)`
  - Normalizes runtime ids (lowercase and fallback when missing).

- `canLaunchRuntime(runtimeId, entry, moduleSettings, context)`
  - Returns true if the runtime is eligible to launch.

- `launchRuntime(runtimeId, entry, context)`
  - Launches module runtimes that are not handled by hosted/native flows (returns handle or null).

- `getRuntimeRequirements(entry, context, { primary })`
  - Adds exact `{ managerId, version, installOptions?, requiresDownload? }` plans for native bridges or other dependencies. Return `[]` when they are already available. The backend validates and deduplicates the complete plan, then obtains every required download consent before installing anything.
  - Optional `label` and `progressLabel` name the dependency in consent and progress displays. Shared assets can describe their download without changing the runtime selection or its default.

- `getSteamApiRequirement(entry, context, { cmd, args, options })`
  - Optional native-process preflight. Return `null` for unrelated games and tool processes, or a positive requirement with the actual consumer's CPU, imported symbols/interface versions and application-ID evidence. The shared backend resolves a matching native library or included helper before spawning.
  - `applySteamApi(entry, prepared, context, plan)` can add module-specific private plugin links or bootstrap paths. Modules with their own staging flow may instead call `await context.prepareSteamApi(requirement, { baseEnvironment })` directly.

- `resolveNativeLaunchPath(entry, context)`
  - Returns a native app bundle path when the module supports native launches.

- `resolveGameIcon(entry, context)`
  - Optional custom icon extraction hook; return a module-specific icon path when available.
  - The launcher prefers this over app/exe extraction and the module default icon.

- `getState(context)`
  - Returns module state exposed to the UI as `moduleStates[<id>]`.

- `runtimeManagers`
  - Array of runtime manager objects (deduped globally by id).
  - Optional manifest `runtime.managerUi` maps manager IDs to `{groupId,tabLabel,order,sectionLabel,memberOrder}`. It groups and orders compact UI tabs without changing runtime IDs, settings, installation paths or action routing. Managers without metadata retain their own label and follow ordered groups.

- `save`
  - `extensions` and optional exact `names` declare save files, including location-only modules.
  - Optional `decode(raw, {maxOutputBytes})` / `encode(json)` supply a bounded JSON codec. `binary: true` declares Buffer representation; default codecs use UTF-8 strings.
  - Optional `structured: {inspectAction,editAction}` advertises structured editing.
  - Write actions receive `context.assertSaveWriteAllowed()` and `context.snapshotSaves({reason})`; see [SAVE_SNAPSHOTS.md](SAVE_SNAPSHOTS.md).

- `cheats`
  - Cheat schema, defaults, normalization, equality, and patcher.

- `libs`
  - Library catalog + patcher for managed runtime files.

## Detection pipeline
The registry delegates to `src/modules/detection.js`: normalize once; honor manifest extension ownership; gate/aggregate specific probes; inspect bounded artifacts; then run generic fallbacks. Equal strong matches report a conflict. UI label order never selects an engine. The synchronous API remains available; asynchronous imports/launches use bounded workers for expensive probes and shared archive inventories.

`explainDetection` / `explainDetectionAsync` return candidates, trace, cache metrics and version evidence. Read the [flowchart and declaration contract](DETECTION.md) for bounds/parallelism. CLI `--inspect` and inspector **Details** expose the report without executing game files; engine/version evidence is already visible in the inspector header.

Web module detection handles:
- NW.js app bundles at `Contents/Resources/app.nw`.
- Electron-style layouts at `Contents/Resources/app` (using `dist/index.html`) and `resources/app` roots.

This means new modules automatically show up in detection and error messaging with no launcher changes.

## Runtime integration
- Runtime selection is derived from `manifest.runtime.supported`.
- Default runtime uses `settings.modules[<id>].defaultRuntime`, then the optional module hook `resolveDefaultRuntime(entry, moduleSettings, context)` or `manifest.runtime.default`. The hook is synchronous and offline; `context.getRuntimeManagerState` supplies cached installed-runtime state when available. Explicit game and module choices take priority. `getResolvedModuleSettings(settings)` exposes effective defaults without writing them into stored settings.
- Hosted runtime behavior is defined by `manifest.runtime.hosted` (id, optional fallback, optional UA hints).
- Runtime managers are declared by modules or shared services and shown in the Runtimes view.
- `manifest.runtime.preLaunch` can gate launch on module-specific readiness checks.
- Modules can add `nwjs-patched` to opt into the shared patched wrapper; engine-specific patches remain module-gated.

## Settings integration
- `settingsDefaults` defines the Settings UI fields for the module.
- Settings sections are driven by the module's declared settings; empty sections do not need placeholder controls.
- Settings sections are ordered from module metadata (label/shortLabel/id), not from a hard-coded module id list.
- Runtime settings are defined per runtime in `runtime.entries[<id>].settings` and surfaced in Settings and the game inspector.

## Icon handling
- Modules can optionally override icon extraction with `resolveGameIcon`.
- If no module icon is resolved, the launcher extracts app/exe icons and falls back to `resources/icon.png` when present.
- App bundle icon extraction checks `Contents/Info.plist` (`CFBundleIconFile`), `Contents/Resources/icon.icns`, and `Contents/Resources/*.icns` (best match).

## Save and cheat integration
- The save path row is shown only when `supports.saveLocation` is true.
- Save tools are available when either `saveLocation` or `saveEditing` is true; only codec-capable modules show JSON editing. Snapshots/import/export work on declared files without decoding them.
- Cheats are shown only when `supports.cheats` is true.
- Tools patching is available only when `supports.cheatsPatcher` is true.

## Uniform file scheme
Follow these conventions for new modules:
- Per-game data lives under `userData/games/<gameId>/` (modules and runtime staging).
- Per-module shared assets can live under `userData/modules/<moduleId>/` when they are not per-game.
- Use `gameId` for per-game file paths; do not derive per-game ids from `gamePath`.
- Runtime installations live under `userData/runtimes/<managerId>/`.
- Runtime settings defaults live under `userData/runtimes/<runtimeId>/settings.json`.
- Bundled assets live under `resources/` inside the module.
- Diagnostic logs belong in owned per-game userData, not beside original game files.

## Adding new modules

Add the manifest, Node hooks, detection evidence, base icon and backend tests together. Register versioned managers and owned distribution/overlay declarations as needed. Add the module and all of its runtime IDs to the inventory above, link its runtime guide, and record upstream projects and notices in [attributions](ATTRIBUTIONS.md) and the source inventory. Module imports and game actions must also work without Electron.

## UI-independent module hooks

Registry discovery and module imports work under plain Node. UI services are provided
through `context.ui = { shell, dialog, nativeImage }` by an Electron host; module code
uses `shared/ui-services.js` to retrieve them. File dialogs and reveal actions fail with
actionable errors when no adapter exists. Optional icon conversion can return `null`.
GDRE file actions also accept `payload.filePaths`, allowing tools to run without dialogs.
Optional tool actions use `context.confirmRuntimeInstall(plan)` for missing downloads,
then install the selected version and continue. Declined consent raises `AbortError`
with `code: "ABORT_ERR"`; installed or included tools need no download prompt. An
explicit Node action without a consent adapter authorizes its required downloads.
`context.onToolProcessSpawn(child)` retains the game's reservation while a tool
child runs. Shared tool commands also bind their actual tool/host reader lease to
the child PID, protecting removal after worker exit. Processes and callbacks use
plain Node APIs.
Runtime hooks keep using `context.spawnDetachedChecked`, runtime settings, cheat paths,
and entry/runtime state callbacks. See [BACKEND.md](BACKEND.md) for backend integration.

`runtime.hosted.saveDirectory: true` opts into hosted save-directory injection. Modules
without that flag keep their existing save behavior.

Modules may implement `onRuntimeCrash(entry, { runtimeId, signal }, context)` to
offer engine-specific recovery through injected UI services. The launcher handles
process lifecycle and persistence generically; Godot's existing extraction prompt
lives in its module rather than an engine branch in the launcher.
