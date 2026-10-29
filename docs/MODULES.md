# Module system

MacLauncher is module-first. The launcher never hard-codes per-engine branches; it discovers modules at runtime and drives UI and behavior from module metadata.

This doc describes the module contract, detection pipeline, and how modules integrate into UI, settings, runtimes, saves, and cheats.

## Modules and backends

A **module** owns detection, game metadata, engine-specific actions and launch preparation. A **backend** is one runtime choice within that module. A **runtime manager** supplies versions and installations for a backend or tool. These are separate contracts: GameMaker is one module with OpenGMK, Butterscotch and official runner backends; AliceSoft is one module with three engine generations; the HTML modules share one NW.js manager.

The registry discovers game-type modules and optional runtime providers. The tables list their declared runtime IDs, including inspection-only entries. Each guide describes available features, accepted formats and runtime requirements.

### Common engines and HTML exports

| Module | Runtime backends / tools | Guide |
| --- | --- | --- |
| `gamemaker` | `opengmk` ([OpenGMK](https://github.com/OpenGMK/OpenGMK)), `butterscotch` ([Butterscotch](https://github.com/ButterscotchRunner/Butterscotch)), `official-studio` ([GameMaker](https://gamemaker.io/)), `native`, `inspection`; decompilers | [GameMaker](runtimes/GAMEMAKER.md) |
| `mv` | `electron`, `nwjs`, `nwjs-patched`, `native`; cheats, asset tools and save editing | [RPG Maker MV/MZ](runtimes/RUNTIMES.md), [save editor](MVMZ_SAVE_EDITOR.md) |
| `mz` | `electron`, `nwjs`, `nwjs-patched`, `native`; cheats, asset tools and save editing | [RPG Maker MV/MZ](runtimes/RUNTIMES.md), [save editor](MVMZ_SAVE_EDITOR.md) |
| `rgss` | `mkxpz` ([MKXP-Z](https://github.com/mkxp-z/mkxp-z)); RPG Maker XP/VX/VX Ace, scripts and cheats | [MKXP-Z](runtimes/MKXPZ.md), [RGSS tools](RGSS_TOOLS.md) |
| `easyrpg` | `easyrpg` ([EasyRPG Player](https://easyrpg.org/)); RPG Maker 2000/2003, LCF project exports | [EasyRPG](runtimes/EASYRPG.md) |
| `wolfrpg` | `browser-woditor` ([Browser Woditor](https://frostyhowl.com/browser-woditor/)); WOLF RPG Editor, archive tools | [WOLF RPG Editor](runtimes/WOLFRPG.md) |
| `scummvm` | `scummvm` ([ScummVM](https://www.scummvm.org/)); supported adventure-game data, managed ScummVM Tools | [ScummVM](runtimes/SCUMMVM.md) |
| `dosbox` | `dosbox-staging` ([DOSBox Staging](https://www.dosbox-staging.org/)); DOS EXE/COM/BAT, private game files and managed Rizin/Ghidra inspection | [DOS](runtimes/DOSBOX.md) |
| `anyps5` | `anyps5` ([AnyPS5](https://github.com/boykopovar/AnyPS5)); PS5 ELF/SELF conversion, Intel runtime libraries, Rosetta and managed Rizin/Ghidra inspection | [PlayStation 5](runtimes/ANYPS5.md) |
| `nxnative` | `nxnative` ([nxnative](https://github.com/seedds/nxnative)); Switch application containers, ARM64 host, keys and NSO ELF export with managed Rizin/Ghidra inspection | [Nintendo Switch](runtimes/NXNATIVE.md) |
| `unity` | `unity` ([Unity](https://unity.com/) Mono player), `native`; exact-version player replacement, ILSpy and AssetRipper | [Unity Mono](runtimes/UNITY.md) |
| `fna` | `fna` ([FNA](https://github.com/FNA-XNA/FNA) / XNA 4 managed host), `native`; managed decompilation | [FNA](runtimes/FNA.md) |
| `godot` | `godot` ([Godot](https://github.com/godotengine/godot)), `native`; recovery tools | [Godot](runtimes/RUNTIMES.md#godot) |
| `love` | `love` ([LÖVE](https://github.com/love2d/love)), `native`; archives, fused exports and AppImages | [LÖVE](runtimes/LOVE.md) |
| `java` | `java` ([Temurin](https://github.com/adoptium/temurin-build)); decompilation and exact JNI bridges | [Java](runtimes/RUNTIMES.md#temurin--vineflower), [Steam bridges](runtimes/JAVA_STEAM.md) |
| `flash` | `projector` (Adobe Flash Player), `ruffle` ([Ruffle](https://github.com/ruffle-rs/ruffle)); managed FFDec exports | [Flash](runtimes/RUNTIMES.md#ruffle--flash-player), [tools](FLASH_TOOLS.md) |
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
| `mages` | `impacto` ([Impacto](https://github.com/CommitteeOfZero/impacto)); native playback of Windows HD releases and MPK/SC3 tools | [MAGES.](runtimes/MAGES.md) |
| `nitroplus` | `npengine` ([NPengine](https://github.com/FGRE/libnpengine) / [libnpa](https://github.com/FGRE/libnpa)); NPA/NSS playback and script tools | [Nitroplus](runtimes/NITROPLUS.md) |
| `vnds` | `vnds_love` ([VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) hosted by LÖVE); converted exports and save editing | [VN engines](runtimes/VN_ENGINES.md) |
| `bgi` | `bgi-tools`; BGI/Ethornell archive/program tools, [OpenBGI](https://github.com/Cytlan/openbgi) format references; no native interpreter | [BGI](runtimes/VN_ENGINES.md) |
| `catsystem2` | `catsystem2-tools`; encrypted KIF, CatScene, CSTL and FES tools; no native interpreter | [CatSystem2](runtimes/CATSYSTEM2.md) |
| `minori` | `reminori` ([ReMinori](https://github.com/luoyily/ReMinori)); native PAZ playback, private saves and script tools on Apple Silicon | [Minori](runtimes/MINORI.md) |
| `fvp` | `rfvp` ([RFVP](https://github.com/xmoezzz/rfvp)); managed FAVORITE/FVP interpreter, scenario inspection and asset exports | [FAVORITE / FVP](runtimes/FVP.md) |

### Other game types

| Module | Runtime backends / tools | Guide |
| --- | --- | --- |
| `gemrb` | `gemrb` ([GemRB](https://github.com/gemrb/gemrb)); compatible Infinity Engine resources, managed Near Infinity inspector | [Other engines](runtimes/OTHER_ENGINES.md), [tools](INFINITY_TOOLS.md) |
| `ikemen` | `ikemen` ([Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO)); MUGEN-compatible content | [Other engines](runtimes/OTHER_ENGINES.md) |
| `hashlink` | `hashlink` ([HashLink](https://github.com/HaxeFoundation/hashlink)); bytecode and native-module ABI profiles | [Other engines](runtimes/OTHER_ENGINES.md) |
| `haxe` | `inspection`; Windows [Haxe](https://haxe.org/) C++ builds using [hxcpp](https://github.com/HaxeFoundation/hxcpp) / [Lime](https://github.com/openfl/lime), without a native Mac interpreter | [Other engines](runtimes/OTHER_ENGINES.md) |
| `android` | `klepton` (managed common/JVM and ART packages with managed Java 21), `macapk` (managed publisher releases), `aim` (managed adapted host and separately acquired Android image) | [Android](runtimes/ANDROID.md), [architecture](runtimes/ANDROID_ARCHITECTURE.md) |
| `ios` | `playcover`; managed PlayTools adaptation of unencrypted ARM64 IPA packages | [iOS / iPadOS](runtimes/IOS.md) |
| `generic-app` | `native`; macOS app bundles, selected shell/shebang scripts and Mach-O executables; app quarantine repair; `mac32` provider for i386-only apps | [User guide](README.md), [32-bit Intel apps](runtimes/MAC32.md) |
| `mac32` | `mac32` ([mac32](https://github.com/Shagulka/mac32)); managed 32-bit Intel macOS runtime provider | [32-bit Intel apps](runtimes/MAC32.md) |
| `crossover` | `sikarugir`, `crossover`; managed Sikarugir Wine versions, local CrossOver applications and Windows executable fallback | [Sikarugir](runtimes/SIKARUGIR.md), [CrossOver](runtimes/CROSSOVER.md) |

Sikarugir (Wine) also appears as a runtime choice for detected x86/x64 Windows
games in other modules, with automatic download consent during Play. CrossOver
appears when a usable local application is available. The engine identity,
inspection actions and usual backend defaults remain available. Generic Windows
games default to Sikarugir. Generic i386-only macOS app imports default to mac32;
recognized engines retain their preferred runtime, and apps with compatible
64-bit executables retain their native backend.

### Managers and shared services

`RuntimeRegistration` in `shared/runtime/custom-runtime.js` supplies local
registration storage, installed-list composition, opaque path IDs, section
defaults, selection and registration removal. Runtime managers declare layout
inspectors and existing provider methods through `configure`. Provider declarations
map list and resolver methods to compatible sections, preserve version parsers and
comparators, and keep managed install directories separate from external paths.
Composed managers inherit these declarations. Their own layout inspector supplies
the same metadata to runtime panels, installed providers and launch selectors;
base and sibling managers retain their own provider behavior.
Legacy selector shapes use `createSelector`; ordinary catalog and managed-version
calls retain their existing implementations. [Custom runtime layouts](runtimes/CUSTOM_RUNTIME_LAYOUTS.md)
describes the supported runtime inputs.

The `dosbox` module supplies the managed `dosbox-staging` player and reuses the shared `native-inspector` tools.

Managers are registered once by ID, even when several modules use them. Engine-owned playback managers include `mkxpz`, `sdk`, `godot`, `love`, `java`, `ruffle`, `fna`, `unity`, `butterscotch`, `opengmk`, `gamemaker-official`, `system3`, `xsystem35`, `xsystem4`, `krkrsdl2`, `onscripter-en`, `ai5`, `siglus`, `rlvm`, `npengine`, `impacto`, `reminori`, `rfvp`, `gemrb`, `ikemen`, `hashlink`, `easyrpg`, `scummvm` and `browser-woditor`. The `mac32` provider supplies the managed `mac32` manager. The Windows module provides the managed `sikarugir` manager and the `crossover` manager for local applications. Versioned tools include [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool), [GM8Decompiler](https://github.com/OpenGMK/OpenGMK), [sys3c](https://github.com/kichikuou/sys3c), [xsys35c](https://github.com/kichikuou/xsys35c), [AssetRipper](https://github.com/AssetRipper/AssetRipper), [FFDec](https://github.com/jindrapetrik/jpexs-decompiler), [Near Infinity](https://github.com/Argent77/NearInfinity) and [ScummVM Tools](https://github.com/scummvm/scummvm-tools). Backend IDs can differ from manager IDs: `official-studio` uses `gamemaker-official`.

The `nwjs`, `onsyuri`, `innoextract`, `ilspy` and `native-inspector` managers are discovered from `src/modules/shared/`. [ILSpy](https://github.com/icsharpcode/ILSpy) manages C# export tool versions and compatible .NET hosts for FNA and Unity; [Rizin / Ghidra](NATIVE_INSPECTION.md) supplies static native binary inspection. The [complete tool tables](GAME_TOOLS.md) list all module/runtime coverage, tool-manager locations, output kinds and limits. The [installer reader](runtimes/INSTALLERS.md) unpacks supported offline installers before normal engine detection; it is shared import infrastructure. Greenworks is an NW.js manager section, not a separate game type. Shared Steam API resolution, runtime catalogs, native payload verification, Rosetta checks, save snapshots, icons and preparation utilities also live in the shared namespace.

Version choices and release fetching use the [shared catalog contract](runtimes/RUNTIME_CATALOGS.md). Included helpers and players execute from verified application resources; downloadable versions use the manager's userData directory. [Distribution declarations](runtimes/RUNTIME_DISTRIBUTION.md) describe the exact payload, CPU, macOS floor, source revision and build recipe.

## Module behavior
- Extensible: adding a new module automatically appears in the UI, settings, and runtime manager lists.
- Modular: engine-specific logic and assets live inside the module directory.
- Uniform: modules follow the same file layout and data conventions.
- Offline by default: network access follows explicit user actions (runtime catalog refresh/install).

## Runtime providers

A module can export a `runtimeProviders` array to offer backends for games
detected by other modules. This array takes precedence over the legacy singular
`runtimeProvider` export. Each provider declares a unique `runtimeId`, runtime-entry metadata,
`managerId`, `supportsEntry(entry, moduleSettings, context)`, and
`launchRuntime(runtimeId, entry, context)`. Optional hooks include
`decorateEntry`, `canLaunchRuntime`, `ensureRuntime`, `prepareLaunch`,
`prepareInput`, `getRuntimeRequirements`, `getSteamApiRequirement` and
`resolveSaveLocations`. Duplicate provider runtime IDs are rejected.

A provider runtime entry can declare `input` with `fileExtensions`, `binaryFormats`,
`gameTypes` and `webContent`. Settings offers the provider for a module whose detection
declarations or `runtime.inputFormats` match one of them: Wine backends for modules that accept
Windows executables, mac32 for modules with the macOS i386 format and Prosper for PS5 games.
A provider without `input`, or one listed in the module's own `runtime.supported`, applies to
every module that allows it. The inspector narrows these choices to the imported game through
`supportsEntry`. A saved choice that no longer applies stays visible and editable instead of
becoming another backend, and launching it is refused.

The registry adds provider labels, settings and manager mappings to module
metadata. Entry-specific support is filtered from cached format evidence and
local runtime availability. Detection decoration stays offline and records
positive and negative evidence. Refreshing evidence preserves per-game runtime
version choices. Selecting a provider routes setup and launch through its hooks
instead of the engine's ordinary hooks. Other backend choices retain their
engine behavior and defaults.

Automatic selection keeps a module runtime that can launch the game. A runtime
entry with `launch: false`, or a module with `supports.launch: false`, never
launches; when none of a module's own runtimes can launch the game, automatic
selection takes the first applicable provider in provider order. The Windows
module lists CrossOver before Sikarugir, so BGI, CatSystem2 and Windows Haxe
builds use a registered CrossOver application when one is available and
Sikarugir otherwise. An explicit provider choice is kept.

Provider `supports` flags override the engine's capabilities for that runtime.
Unknown save formats can disable save tools; an engine's save codec must not be
applied to unrelated runtime storage. The Windows module uses this contract for
managed Sikarugir and local CrossOver playback. Sikarugir exposes save locations;
engine-specific save editors and cheats belong to their engine modules.

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

Cross-module utilities live in `src/modules/shared/`; engine modules depend on those shared contracts.
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
  - `description`, `requirements`, `preparation` and `dataNotice`: optional runtime description, platform requirements, automatic setup and data-separation text shown with its settings.
  - `networkAccess`: optional capability flag; `false` disables network access controls for that runtime.
  - `settings`: optional runtime settings schema (`defaults`, `fields`).
  - `supports`: optional capability overrides for a runtime provider.
- `runtime.hosted`: optional hosted-runtime config (`id`, optional `fallback`, optional `userAgent`).
  - `userAgent.suffix` supports `{nwjsVersion}` to insert the configured NW.js runtime version.
- `runtime.manager`: optional map of runtime id -> runtime manager id.
- `runtime.managerSectionBy`: optional map of runtime id -> entry field name to select a manager section.
- `runtime.managerVersionSectionBy`: optional map of runtime id -> `major` for version groups whose numeric section matches the version's major number. The inspector ignores a saved patch from another section, including with an automatic section selection.
- `runtime.managerSectionAuto`: optional map of runtime id -> automatic section options. `defaultKey` names a runtime-manager state field holding a default section; with `minimum`, a default below the detected section is ignored. `minimumKey` names a `moduleData` field holding the compatibility minimum. A version-only choice at or above that minimum keeps its own section even when the automatic section is newer.
- `runtime.inspectorSections`: optional runtime-id map to `"all"` or `{ "exclude": [sectionIds] }`. The inspector combines installed and discovered versions from those sections while Runtimes keeps its compatibility subtabs. Independent tool/helper sections can be excluded without hiding runtime versions.
- A runtime-manager section can declare `selectionSectionId` to map a compatibility subtab to an existing settings channel. This preserves runtime IDs and stored preferences when the download view has finer groups.
- Provider runtime entries can declare `uiOrder` to order appended runtime choices. Module `ui.settingsOrder` controls the Settings sidebar, and runtime-manager `ui.category` and `ui.order` place Runtimes groups under their sidebar heading and order them where that heading is not alphabetical.
- `runtime.managerSectionOverrideKey`: optional map of runtime id -> per-game `runtimeData` key used to override manager section selection.
- `runtime.managerSectionMap`: optional map of runtime id -> map of entry values to section ids.
- `runtime.preLaunch`: optional map of runtime id -> pre-launch checks (`statusAction`, `readyWhen`, `fixAction`, optional `declineAction`, optional `prompt`).

Runtime settings schema:
- `defaults`: key/value map for global runtime settings defaults.
- `fields`: list of field definitions (`key`, `type`, `label`, optional `description`, optional `default`).
- `provider: {readAction, writeAction, gameOnly?}` adds locally generated settings through the same controls. The read action returns `{schema: {fields, defaults?}, values, message?}`; the write action receives `{values}` and returns the updated result. Game scopes use module actions and module scopes use settings actions. `gameOnly: true` limits generation to individual games. The module owns validation and persistence, including native preference stores; generated choices do not enter the static runtime-defaults file. Opening settings does not fetch runtimes or game data.
- `advanced: true` places a field in one collapsed **Advanced** group after the common fields, with a count of its fields. The group appears only when a runtime has both kinds of field; otherwise the fields stay in one list.
- Fields can carry `section` for an ordered heading. Number fields accept `min`, `max` and `step` for their controls; providers validate values before storing or using them.
- Network access comes from the launcher default and one per-game override. Modules receive the effective `context.networkAllowed` value and the derived `runtimeSettings.networkIsolation` flag; runtime panels do not define separate network controls. A runtime that cannot support online execution declares `networkAccess: false` in its metadata.
- Supported `type` values: `boolean`, `number`, `string`, `select`, `list`, `display`.
- `display` fields show a read-only table from `rows: [{label, value}]` in module and per-game settings. They have no stored value and do not participate in defaults, overrides or reset comparisons.
- `select` fields require `options` entries with `{ value, label }`.
- `disabledWhen` uses the same conditions as module actions, evaluated against the current runtime settings. It disables the control without discarding its saved value.
- `visibleWhen` and `hiddenWhen` use those conditions in both global and per-game settings. A field with `visibleWhen` appears when any condition matches; any matching `hiddenWhen` condition hides it. Hidden fields retain their values, defaults and overrides. Local option providers load only for visible fields.
- `requiresInstall: {managerId, sectionId}` disables a field until its runtime-manager section contains a ready installation. Boolean controls display as off while the installation is missing and preserve their saved preference.
- `optionsAction` and `optionsKey` populate a field from local choices. Per-game windows call `actions[optionsAction](entry, payload, context)`; global runtime settings call `settingsActions[optionsAction]({runtimeId}, context)`. Fields available in both scopes expose the same provider through both routes. Static `options` provide the initial choices while loading. Saved dynamic identities remain unchanged through normalization, including when unavailable; the consuming provider validates the selected identity before use. Static select fields accept only declared options. Providers finish independently and do not fetch files.
- Runtime version fields use `optionsAction: "listRuntimeVersions"` with `optionsKey: "runtimeVersions"`. The shared `runtimeVersionChoices` helper in `src/modules/shared/runtime/version-choices.js` returns the field's static options followed by the manager's installed versions and the cached catalog versions this Mac can install, newest first, with Runtimes labels.
- String fields can declare `pickerAction` and optional `pickerResultKey` (default `filePath`) for a native **Browse…** action. The same per-game/global action routes return the selected path or `null` on cancellation. The existing settings writer persists the path; canceled or failed selection preserves the saved value. A field that also declares `fileStatusAction` becomes a file registration control: the action receives `{filePath}` and reports whether the file is registered, missing or invalid with a short reason. The control offers **Choose file…**, accepts one dropped local file (the picker action then receives `{filePaths}`), and provides **Replace…** and **Remove**, which change only the saved path.
- `list` fields store string arrays; the UI accepts one entry per line (commas also supported). `listSeparator: "newline"` preserves commas inside arguments, DLL overrides and environment values.

Supports flags:
- `supports.cheats`: module exposes a cheat schema/runtime.
- `supports.cheatsPatcher`: module supports tools patching on disk.
- `supports.saveEditing`: module supplies a JSON save codec.
- `supports.saveLocation`: module provides a reliable save directory for the game detail panel.
- `supports.saveLocationOverride: false`: keep the save folder fixed while retaining reveal and save tools; other modules retain the folder chooser. An optional async `prepareSaveLocation(entry, context)` hook prepares owned storage before opening save tools.
- `supports.structuredSaveEditing`: optional structured-edit UI capability, advertised alongside `save.structured` action IDs.
- `detection`: manifest-owned input kinds, extension ownership, cheap markers/signatures, artifact probes and fallback policy; see [DETECTION.md](DETECTION.md).

Other fields:
- `settingsDefaults`: per-module settings defaults (drives Settings UI sections).
- `ui.infoFields`: list of extra fields for the game detail panel.
- `ui.entrySelectors`: module-owned launch choices shown above the inspector's Files section.
- `ui.actions`: list of module actions (patch/build/probe/etc).
- `ui.actionGroups`: ordering and grouping of actions in the UI.
- `ui.accounts`: one module account panel. `ui.accountProviders` adds independent account panels using the same `label`, `stateAction`, `signInAction`, `signInLabel` and `removeAction` fields. Optional `runtimeIds` limits a panel to the selected runtime's Settings tab. Each panel calls its declared `settingsActions`; account inventories and credentials remain owned by that backend.
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
- `inspector`: set to `false` for actions presented by specialized controls, such
  as a cheats panel. Their metadata and backend actions remain available there.
- `cancellable`: show Cancel while running. The action receives `context.signal`
  and passes it to its asynchronous work; cancellation also follows the initiating
  window's lifetime. Folder pickers and download consent retain their own controls.
- `resultFields`: list of info fields to display after action.
- `disabledWhen` / `hiddenWhen`: array of conditions.

`ui.entrySelectors` entries:
- `id`, `label`, `optionsAction`, `setAction` (required).
- `description`: optional help text; the current action result can supply a more specific `description`.
- `hiddenWhen`: array of conditions evaluated against the library entry.

The local `optionsAction` returns `{ value, options: [{ value, label, disabled? }], description? }`.
The `setAction` receives `{ value }`, validates and persists the choice, and returns the same result shape.
Choices load when the inspector opens, after playback stops, and on explicit Refresh.
Selection stays disabled during preparation, playback and pending requests.
These actions use local files and saved state; they do not fetch network resources.

Conditions:
- `key`: dotted path in the game entry or action result.
- `equals`, `notEquals`, `truthy`, `falsy`, `endsWith`.

`ui.actionGroups` entries:
- `id`, `label`
- `actions`: ordered list of action ids.
- `note`: optional help shown by the group's question-mark button.
- `collapsed`: place advanced actions in a native disclosure.
- `inlineActions`: keep a compact group of related actions visible together.

By default, an uncollapsed group keeps its primary action visible and places supporting actions
in **More…**. Running status, Cancel for cancellable actions, and operation results
remain visible when a disclosure is closed. Absolute paths in `path` result
fields appear as a labeled **Reveal** button that opens the location in Finder, instead of
the printed path. Numeric results, including zero, remain visible. Modules without groups share one
Game tools group.

Declared inspector actions omitted from groups appear under More tools. Actions
with `inspector: false` remain in their specialized controls. With no declared
groups, the inspector uses one Game tools group. Backend operations without
inspector metadata remain separate from this presentation.

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
  - `context.readOnly: true` permits path calculation and existing-view reads without creating directories or copying files. `context.signal` carries cancellation before and during preparation.
  - Use real directory scaffolding, private mutable files and immutable asset links. Plugin/library writes must atomically replace linked leaf files instead of modifying the original target. [writable input views](GAME_PREPARATION.md#writable-input-views) contains the corresponding reference.

- `getContentReadRoots(entry, context)`
  - Optional declaration of this game's original immutable content roots for read-only HTTP asset serving. The ordinary contained-root policy remains the default; declarations must not admit unrelated directories.

- `cleanupGameData(entry, context)`
  - Called during exclusive per-game removal after launches, tools and save actions have stopped or finished.
  - Use to delete per-game data stored under `userData/games/<gameId>/` (extracted bundles, wrappers, builds, etc).
  - `context` includes `userDataDir`, `settings`, `logger`, `gameId`, `gamePath`, and `moduleId`.

- `filterRuntimeSupport(entry, supported, moduleSettings)`
  - Returns a filtered runtime list for a specific game.

Selecting a different runtime refreshes its module-provided save locations in the backend worker before the updated inspector state is returned.
Runtime providers keep the detected engine's save locations while another backend is selected and restore them before returning to engine preparation. Providers with `supports.saveLocation: false` expose no save tools or active engine save root, including explicit engine save-folder overrides.

- `normalizeRuntimeId(runtimeId)`
  - Normalizes runtime ids (lowercase and fallback when missing).

- `canLaunchRuntime(runtimeId, entry, moduleSettings, context)`
  - Returns true if the runtime is eligible to launch.

- `launchRuntime(runtimeId, entry, context)`
  - Launches module runtimes that are not handled by hosted/native flows (returns handle or null).
  - A runtime with an owned supervisor can bind its returned child through `core/process-lifecycle.bindProcessStop(child, callback)`. UI Stop and command-line interruption call the same idempotent owner; other children retain process-group termination. The callback completes the runtime's bounded shutdown protocol and rejects cleanup failures. Its pending operation retains game/runtime leases after the root process exits. The callback receives the original child, PID and a current-binding predicate; process IDs alone never select a later launch.
  - Native macOS applications can use `shared/runtime/native-app-stop.bindNativeAppStop` before publishing the child. It requests normal AppKit Quit without activation, verifies the owned process incarnation and executable, and waits for exit. Timeout escalation uses forced termination without starting a concurrent SIGTERM teardown. Godot uses this shared binding.
  - `child.runtimeRetirement` describes asynchronous teardown after normal exit, window close or Stop. Publish the promise in the terminal listener or before requesting Stop. Backend workers and game, runtime and graphics leases remain owned until retirement completes. A rejected retirement preserves those owners and records `runtimeRetirementError`; runtime cleanup retains files and descriptors still used by live consumers.

- `launchNativeRuntime(entry, context)`
  - Optionally launches a module-owned native entry point and returns its process handle. Returning `null` uses the shared app-bundle launch flow. The macOS Game module uses this hook for selected scripts and standalone executables, with shared graphics settings and process-group lifecycle tracking.

- `nativeHostDependencies()`
  - Returns exact native plugin relationships supplied during launch. Each record identifies the supplemental resource/version, plugin file and SHA-256, loader-relative dependency, matching included provider/version/file, and retained publisher install names. Java JNI and LuaSteam use this for their per-game Steam API layout. Other native dependencies remain part of the component's own closure.

- `prepareNativeLaunch(entry, context, { appPath, executable })`
  - Optionally returns `{ args, environment }` for a native app. The launcher retains the original executable, bundle, working directory, Steam environment and process lifecycle. Module preparation belongs in its private game data directory.

- `resolveGraphicsInputs(entry, context)`
  - Optionally describes the selected renderer's inputs, including `{ cameraProjection, source, methods }` for a camera integration. The graphics service intersects these methods with installed providers and the selected presentation host. Native video can advertise `nativeVideo`, `sourceResolution: false`, its spatial filter registry and `shaderBindingsNextLaunch`. Modules that prepare their own integration can set `context.graphicsInputs` before applying the graphics environment; `null` explicitly disables additional inputs for that launch. Runtime status exposes eligible inputs to the inspector. Live changes use the inputs recorded at launch.

- `prepareEffectsEntry(entry, context)`
  - Optionally returns a transient entry for shared graphics preparation. The saved entry and full Advanced plan remain intact. The video module uses this hook to keep original mpv shader prefixes and native Simple scaling inside its renderer, while later RGB stages use the shared processor. The same transformation applies to launch preparation and graphics edits. See [graphics pipeline](GRAPHICS_PIPELINE.md) for input metadata and ordering.

`runtime.providers` can restrict a module to specific external runtime providers.
An empty array keeps only the module's own runtimes; macOS Game uses this to retain
its native app runtime. `ui.settingsOrder` orders module Settings sidebar entries before the
usual alphabetical ordering. Launcher remains the first tab, followed by App.

- `getRuntimeRequirements(entry, context, { primary })`
  - Adds exact `{ managerId, version, installOptions?, requiresDownload? }` plans for native bridges or other dependencies. Return `[]` when they are already available. The backend validates and deduplicates the complete plan, then obtains every required download consent before installing anything.
  - Optional `label` and `progressLabel` name the dependency in consent and progress displays. Shared assets can describe their download without changing the runtime selection or its default.

- `getSteamApiRequirement(entry, context, { cmd, args, options })`
  - Optional native-process preflight. Return `null` for unrelated games and tool processes, or a positive requirement with the actual consumer's CPU, imported symbols/interface versions and application-ID evidence. The shared backend resolves a matching native library or included helper before spawning.
  - `applySteamApi(entry, prepared, context, plan)` can add module-specific private plugin links or bootstrap paths. Modules with their own staging flow may instead call `await context.prepareSteamApi(requirement, { baseEnvironment })` directly. During Play, a preparation that selects the game's own library for a Steam library installation also applies the Steam client choice: after consent or a standing Start automatically choice, it starts the Steam client and waits a bounded time for its sign-in. Native launch hooks call `await context.prepareNativeSteam(appPath)` for the installed application ID and the same client handling for apps that ship the macOS Steam API.

- `resolveNativeLaunchPath(entry, context)`
  - Returns a native app bundle or selected script/executable path when the module supports native launches.

- `resolveGameIcon(entry, context)`
  - Optional custom icon extraction hook; return a module-specific icon path when available.
  - Preserved custom library artwork takes precedence, followed by this hook, app/exe extraction and the module default icon. An optional extraction failure leaves later candidates available; cancellation remains observable.

- `resolveGameMetadata(entry, context)`
  - Optional asynchronous package metadata lookup in the backend worker. Returns entry fields such as a localized name and module metadata; does not run in the renderer.
  - Optional title/artwork lookup, diagnostic observers and metadata-cache publication cannot prevent use of a detected entry. Cancellation and required game-record, save or input writes remain observable.
  - `context.signal` carries pending launch cancellation through uncached metadata and icon lookup before runtime preparation begins.
  - `metadataCacheKey(entry, context)` includes module-specific source, locale and installed-reader identities in the library cache. `mergeEntry(existing, incoming, settings)` applies to fresh and cached metadata, including preservation of custom names.
  - Optional `metadataSources` lists up to 32 additional metadata-reader source files, relative to the module directory; shared readers can use `../shared/` paths. Their file identities join the application/module source profile once when the metadata service starts, so reader changes invalidate stored facts while unchanged refreshes reuse cached facts without reopening game assets. No source-directory traversal is performed.

- `getState(context)`
  - Returns module state exposed to the UI as `moduleStates[<id>]`.

- `runtimeManagers`
  - Array of runtime manager objects (deduped globally by id).
  - Optional manifest `runtime.managerUi` maps manager IDs to `{groupId,tabLabel,order,sectionLabel,memberOrder,componentGroup,category}`. It groups and orders compact UI tabs without changing runtime IDs, settings, installation paths or action routing. The panel shows the manager label when the visible compact tabs omit the runtime name, with the section label as a fallback. Managers without metadata retain their own label and follow ordered groups. `category` places the group under a Runtimes sidebar heading from the shared ordered list in `src/modules/shared/runtime/category-ui.json`: `engines` (Game engines, sorted by label), `platforms` (Consoles and mobile), `compatibility`, `graphics` and `tools`. A group takes the first category its members declare; an unclassified group appears under Game engines. Engine-specific tools join their engine's group, and the shared `tools` group holds cross-engine tools. `componentGroup: true` presents the manager's group as one component overview, with each component marked installed or automatic on Play and the ordinary version controls collapsed under **Advanced · versions and components**; section tabs are not shown for that group.
  - Optional manager UI `hidden: true` omits its Runtimes controls and sidebar contribution while retaining internal registration, settings, installation and resolution. Hidden managers do not create launcher-library tabs.
  - Default actions call `applySettingsUpdate(action,payload,settings,{userDataDir})`. An optional `updateSettingsAfterDefault(nextSettings,payload,{userDataDir,previousSettings})` records related preferences before the settings commit. Custom path defaults use the same post-selection hook.

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

`explainDetection` / `explainDetectionAsync` return candidates, trace, cache metrics and version evidence. The [flowchart and declaration contract](DETECTION.md) describes bounds/parallelism. CLI `--inspect` and inspector **Details** expose the report without executing game files; engine/version evidence is already visible in the inspector header.

Web module detection handles:
- NW.js app bundles at `Contents/Resources/app.nw`.
- Electron-style layouts at `Contents/Resources/app` (using `dist/index.html`) and `resources/app` roots.

This means new modules automatically show up in detection and error messaging with no launcher changes.

## Runtime integration
- Runtime selection is derived from `manifest.runtime.supported`.
- Default runtime uses `settings.modules[<id>].defaultRuntime`, then the optional module hook `resolveDefaultRuntime(entry, moduleSettings, context)` or `manifest.runtime.default`. The hook is synchronous and offline; `context.getRuntimeManagerState` supplies cached installed-runtime state when available. Explicit game and module choices take priority. `getResolvedModuleSettings(settings)` exposes effective defaults without writing them into stored settings.
- Hosted runtime behavior is defined by `manifest.runtime.hosted` (id, optional fallback, optional UA hints).
- Runtime managers are declared by modules or shared services and shown in the Runtimes view.
- A runtime manager may provide asynchronous `prepareLocalState(context)` for offline device queries before its synchronous `getState(context)`. Other managers publish independently while that local query runs. Acquisition remains an explicit runtime action.
- Managed native package files declare their CPU architectures and optional `format` (`mach-o` by default, or `pe` for Windows libraries). The [shared verifier](../src/modules/shared/runtime/bundled-native.js) checks the declared format and architectures against the file bytes; macOS code-signature checks apply to Mach-O files. Mixed packages retain the same inventory, checksum and permission checks for every file.
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
- App bundle icon extraction reads XML or binary `Contents/Info.plist`. Its declared `CFBundleIconFile` takes precedence over `Contents/Resources/icon.icns` and other contained `*.icns` files. Structural application bundles without an `.app` suffix use the same path. Resource aliases outside the bundle are excluded.
- HTML, Construct, Tyrano and GameMaker HTML5 modules read local NW.js `window.title`, `productName` and `window.icon`, and document titles and icon links. PNG and WebP resources remain local; ICO artwork is converted to a cached PNG. Remote URLs and resources outside the content directory are excluded. Dynamic scripts are not evaluated.
- LÖVE uses literal titles and PNG/WebP icons from `conf.lua` in source folders, `.love` archives and fused ZIP exports. Java reads bounded PNG resources from the JAR, tries later candidates after invalid artwork and invalidates its icon cache when the archive identity changes.
- IPA packages use declared loose PNG icon resources and conventional application icon filenames. Siglus and RealLive loose ICO icons use the shared bounded PNG/DIB decoder.
- Metadata refresh retains custom library titles and artwork. Names and icons otherwise follow observed source changes; runtime selection retains the detected game module's identity.
- Generated web, LÖVE, IPA and Siglus artwork uses bounded per-game cache slots. Validated unchanged bytes are reused; changed artwork replaces the owned cache file atomically. Web icon inspection considers at most 16 candidates and reads at most 32 MiB in total.

## Save and cheat integration
- The save path row is shown only when `supports.saveLocation` is true.
- Save tools are available when either `saveLocation` or `saveEditing` is true; only codec-capable modules show JSON editing. Snapshots/import/export work on declared files without decoding them.
- Cheats are shown only when `supports.cheats` is true.
- Tools patching is available only when `supports.cheatsPatcher` is true.

## Uniform file scheme
Module storage uses these locations:
- Per-game data lives under `userData/games/<gameId>/` (modules and runtime staging).
- Per-module shared assets can live under `userData/modules/<moduleId>/` when they are not per-game.
- `gameId` identifies per-game storage independently of `gamePath`.
- Runtime installations live under `userData/runtimes/<managerId>/`.
- Runtime settings defaults live under `userData/runtimes/<runtimeId>/settings.json`.
- Bundled assets live under `resources/` inside the module.
- Diagnostic logs belong in owned per-game userData, not beside original game files.

## Adding new modules

A module consists of its manifest, Node hooks, detection metadata, base icon and backend tests. Versioned managers declare their distribution and overlay inputs. The module inventory records runtime IDs and guides; [attributions](ATTRIBUTIONS.md) and the source inventory record upstream identities and notices. Module imports and game actions run independently of Electron.

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
child runs and keeps its backend worker available for later session actions.
Temporary inspector servers can pass `{ stopOnLauncherExit: true }` as the second
argument to stop with the launcher; ordinary game and editor processes retain
their normal lifecycle. Shutdown closes new backend admission, drains accepted
jobs and stops temporary servers registered during that drain. Long-running GUI tools call `use.retainUntilClosed(child)`
inside `withRuntimeUse` to protect their tool and host versions after the action
returns. Shared tool commands also bind their actual tool/host reader lease to
the child PID, protecting removal after worker exit. Processes and callbacks use
plain Node APIs.
Runtime hooks keep using `context.spawnDetachedChecked`, runtime settings, cheat paths,
and entry/runtime state callbacks. [BACKEND.md](BACKEND.md) describes backend integration.

`entry.launchArguments` is a game-level setting shared by all runtime choices.
During game launch, `context.gameArguments` contains its parsed string array;
tool and preparation-only contexts receive an empty array. Native adapters add
these values at the final game argument boundary, after their required launcher
options and any older runtime-specific application arguments. Interpreter and
virtual-machine options remain separate. Helpers, downloads and configuration
tools do not receive game arguments. Hosted web adapters transport the array
separately from browser switches and expose application arguments through
`nw.App.argv` and the game renderer's `process.argv`.
Every game process with nonempty arguments also receives
`MACLAUNCHER_GAME_ARGUMENTS`, a JSON array of the same strings. This preserves
the values for application types without a conventional game `argv`, including
Android processes and library-based hosts. An empty argument list clears an
inherited value. The application decides which arguments it recognizes.
Service and helper spawns use `gameArguments: false` in spawn options to clear
this environment value. `context.applyGameEnvironment(environment, { gameArguments: false })`
provides the same behavior for adapters that prepare their own process options.
Android JVM, Mac.apk and AIM launch adapters also provide the JSON string as the
initial Activity Intent extra `maclauncher.arguments`. ART keeps the same
environment contract while retaining its selected boot image.

`runtime.hosted.saveDirectory: true` opts into hosted save-directory injection. Modules
without that flag keep their existing save behavior.

Modules may implement `onRuntimeCrash(entry, { runtimeId, signal }, context)` to
offer engine-specific recovery through injected UI services. The launcher handles
process lifecycle and persistence generically; Godot's existing extraction prompt
lives in its module rather than an engine branch in the launcher.
