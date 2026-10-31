# Module system

A module adds support for one game type to MacLauncher and lives in its own directory under `src/modules/`. The launcher has no per-engine branches: the module registry discovers modules at runtime, and the library, inspector, Settings and Runtimes views are built from module metadata.

This page covers the module contract: the module inventory, runtime managers and providers, the directory layout, the manifest fields and `main.js` hooks, and how modules take part in detection, icons, tool actions and game arguments.

## Modules and backends

A *module* handles detection, game metadata, engine-specific actions and launch preparation for a game type. A *backend*, also called a runtime, is one way to run games within that module. A *runtime manager* supplies the versions and installations behind a backend or a tool. These are separate contracts. GameMaker is one module with OpenGMK, Butterscotch and official runner backends, AliceSoft is one module with backends for three engine generations, and the HTML modules share one NW.js manager. A *runtime provider* is a module that offers backends to games detected by other modules; see [runtime providers](#runtime-providers).

Adding a module makes it appear in the UI, in Settings and in the runtime manager lists without launcher changes. Engine-specific logic and assets stay inside the module directory, and every module follows the same file layout and data conventions. Modules use the network only after an explicit user action, such as a runtime catalog refresh or install.

### Module inventory

The registry discovers one module per game type, plus provider modules that supply runtimes to other game types. The table lists each module's declared runtime IDs, including inspection-only entries. Each game-type page describes accepted formats, features and runtime requirements, and the [settings reference](../runtimes/SETTINGS_REFERENCE.md) lists every game type's backends by display name with its default.

| Game type | Module | Runtime IDs | Notes |
| --- | --- | --- | --- |
| [AI5WIN](../game-types/AI5.md) | `ai5` | `ai5` | |
| [AliceSoft](../game-types/ALICESOFT.md) | `alicesoft` | `system3`, `xsystem35`, `xsystem4` | |
| [Android](../game-types/ANDROID.md) | `android` | `klepton`, `macapk`, `aim` | [Architecture](../game-types/android/ARCHITECTURE.md) |
| [BGI / Ethornell](../game-types/BGI.md) | `bgi` | `bgi-tools` | Tools only; no native interpreter |
| [CatSystem2](../game-types/CATSYSTEM2.md) | `catsystem2` | `catsystem2-tools` | Tools only; no native interpreter |
| [Construct](../game-types/CONSTRUCT.md) | `construct` | `electron`, `nwjs`, `nwjs-patched`, `native` | |
| [DOS](../game-types/DOS.md) | `dosbox` | `dosbox-staging` | |
| [FAVORITE / FVP](../game-types/FVP.md) | `fvp` | `rfvp` | |
| [Flash](../game-types/FLASH.md) | `flash` | `projector`, `ruffle` | |
| [FNA / XNA 4](../game-types/FNA.md) | `fna` | `fna`, `native` | |
| [GameMaker](../game-types/GAMEMAKER.md) | `gamemaker` | `opengmk`, `butterscotch`, `official-studio`, `native`, `inspection` | |
| [GameMaker HTML5](../game-types/GAMEMAKER_HTML5.md) | `gamemaker-html5` | `electron`, `nwjs`, `native` | |
| [Godot](../game-types/GODOT.md) | `godot` | `godot`, `native` | |
| [HashLink (Haxe bytecode)](../game-types/HASHLINK.md) | `hashlink` | `hashlink` | |
| [Haxe native build](../game-types/HAXE.md) | `haxe` | `inspection` | Windows Haxe C++ builds; no native Mac interpreter |
| [Infinity Engine (GemRB)](../game-types/INFINITY_ENGINE.md) | `gemrb` | `gemrb` | |
| [iOS / iPadOS](../game-types/IOS.md) | `ios` | `playcover` | |
| [Java](../game-types/JAVA.md) | `java` | `java` | |
| [KiriKiri](../game-types/KIRIKIRI.md) | `kirikiri` | `krkrsdl2` | |
| [LÖVE](../game-types/LOVE.md) | `love` | `love`, `native` | |
| [macOS Game](../game-types/MACOS.md) | `generic-app` | `native` | App bundles, selected scripts and Mach-O executables |
| [macOS Game](../game-types/MACOS.md#32-bit-mac) | `mac32` | `mac32` | Provider of the downloadable 32-bit Intel macOS runtime |
| [MAGES.](../game-types/MAGES.md) | `mages` | `impacto` | |
| [Minori](../game-types/MINORI.md) | `minori` | `reminori` | |
| [MUGEN / Ikemen GO](../game-types/MUGEN.md) | `ikemen` | `ikemen` | |
| [Nintendo Switch](../game-types/SWITCH.md) | `nxnative` | `nxnative`, `inspection` | |
| [Nitroplus](../game-types/NITROPLUS.md) | `nitroplus` | `npengine` | |
| [NScripter](../game-types/NSCRIPTER.md) | `nscripter` | `onsyuri_mac`, `onscripter_en`, `onsyuri_web`, `external` | |
| [PlayStation 5](../game-types/PS5.md) | `anyps5` | `anyps5`, `inspection` | |
| [PlayStation 5](../game-types/PS5.md#prosper) | `prosper` | `prosper` | Provider of the Prosper runtime for PS5 games |
| [Ren'Py](../game-types/RENPY.md) | `renpy` | `patched`, `sdk`, `native` | |
| [RPG Maker 2000/2003](../game-types/RPGMAKER_2000_2003.md) | `easyrpg` | `easyrpg` | |
| [RPG Maker MV](../game-types/RPGMAKER_MV_MZ.md) | `mv` | `electron`, `nwjs`, `nwjs-patched`, `native` | |
| [RPG Maker MZ](../game-types/RPGMAKER_MV_MZ.md) | `mz` | `electron`, `nwjs`, `nwjs-patched`, `native` | |
| [RPG Maker XP/VX/VX Ace](../game-types/RPGMAKER_XP_VX.md) | `rgss` | `mkxpz` | |
| [ScummVM](../game-types/SCUMMVM.md) | `scummvm` | `scummvm` | |
| [Siglus / RealLive](../game-types/SIGLUS.md) | `siglus` | `siglus`, `rlvm` | |
| [Tyrano](../game-types/TYRANO.md) | `tyrano` | `electron`, `nwjs`, `nwjs-patched`, `native` | |
| [Unity](../game-types/UNITY.md) | `unity` | `unity`, `native` | |
| [Video](../game-types/VIDEO.md) | `video` | `mpv` | |
| [VNDS](../game-types/VNDS.md) | `vnds` | `vnds_love` | |
| [Web](../game-types/WEB.md) | `web` | `electron`, `nwjs`, `nwjs-patched`, `native` | Generic HTML fallback |
| [Windows Game](../game-types/WINDOWS.md) | `crossover` | `sikarugir`, `crossover` | Also provides both runtimes to other game types |
| [WOLF RPG Editor](../game-types/WOLFRPG.md) | `wolfrpg` | `browser-woditor` | |

The HTML hosts are [Electron](https://github.com/electron/electron) and [NW.js](https://github.com/nwjs/nw.js), described in [web runtimes](../runtimes/WEB_RUNTIMES.md). Electron game windows run in a separate game host with the module's preload, outside the launcher window.

## Runtime managers

### Where runtime files come from

Every file a runtime or tool uses belongs to one of three categories, and each category has one home:

| Category | What it holds | Home | Versions and checksums |
| --- | --- | --- | --- |
| Included | Files inside the app (`src/resources`, included MacLauncher Builds packages, the embedded Python, 7-Zip) and the inputs MacLauncher Builds compiles from | Application resources; [`bundled-input.js`](../../src/modules/shared/runtime/bundled-input.js) describes an input, which has no download | One exact version and checksum, reproducible |
| MacLauncher Builds | Packages MacLauncher Builds publishes and the app downloads at run time | [`maclauncher-builds.js`](../../src/modules/shared/runtime/maclauncher-builds.js) | From the Builds catalog records |
| Upstream | Everything else downloaded at run time from a publisher: runtimes, tools, models, plugins, store helpers and store content | [`upstream.js`](../../src/modules/shared/runtime/upstream.js) | Discovered from the publisher; the publisher's digest, or a SHA-256 recorded at install |

Upstream publishers can change their releases at any time, so an upstream source never depends on a particular version. A source names where the publisher lists its releases and how the publisher verifies its files: a GitHub repository, its commits or its Actions workflow, a feed or listing, a PyPI project, a NuGet package, a vendor location verified by Developer ID, or an authenticated store API. Each kind of source accepts its own list of fields, and none of them holds a version, a checksum, a size, an exact file name or a fixed file URL; any other field is dropped. Versions come from discovery. A file's size and digest are checked only when the publisher returned them, and otherwise the download's SHA-256 is recorded in the installation record.

When choosing a file, a source prefers the exact current file name, then a file for this Mac's CPU, then a universal one, in any supported archive format. Installation finds files that a package moves. A release that cannot run here is listed with its reason, and the last good release list stays when a refresh fails. Only the shared download layer reaches the network; `tests/upstream-structure.test.js` checks this from each file's syntax tree.

Modules and shared services declare runtime managers, and the Runtimes window shows them. Each manager is registered once by ID, even when several modules use it. A module exports its managers in the `runtimeManagers` array of `main.js`. Backend IDs can differ from manager IDs: the `official-studio` backend uses the `gamemaker-official` manager.

Engine modules own these playback managers: `mkxpz`, `sdk`, `godot`, `love`, `java`, `ruffle`, `fna`, `unity`, `butterscotch`, `opengmk`, `gamemaker-official`, `system3`, `xsystem35`, `xsystem4`, `krkrsdl2`, `onscripter-en`, `ai5`, `siglus`, `rlvm`, `npengine`, `impacto`, `reminori`, `rfvp`, `gemrb`, `ikemen`, `hashlink`, `easyrpg`, `scummvm` and `browser-woditor`. The `mac32` provider supplies the downloadable `mac32` manager, and the Windows module supplies the downloadable `sikarugir` manager and the `crossover` manager for local applications. A module can also reuse shared managers; for example, `dosbox` supplies the downloadable `dosbox-staging` player and uses the shared `native-inspector` tools.

The registry discovers the `nwjs`, `onsyuri`, `innoextract`, `ilspy` and `native-inspector` managers in `src/modules/shared/`. [ILSpy](https://github.com/icsharpcode/ILSpy) manages C# export tool versions and compatible .NET hosts for FNA and Unity, and [Rizin / Ghidra](../tools/NATIVE_INSPECTION.md) provides static inspection of native binaries. Greenworks is a section of the NW.js manager and has no game type of its own. The [installer reader](../tools/INSTALLERS.md) is shared import infrastructure that unpacks supported offline installers before normal engine detection. The shared namespace also holds Steam API resolution, runtime catalogs, native package verification, Rosetta checks, save snapshots, icons and preparation utilities.

Versioned tools include [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool), [GM8Decompiler](https://github.com/OpenGMK/OpenGMK), [sys3c](https://github.com/kichikuou/sys3c), [xsys35c](https://github.com/kichikuou/xsys35c), [AssetRipper](https://github.com/AssetRipper/AssetRipper), [FFDec](https://github.com/jindrapetrik/jpexs-decompiler), [Near Infinity](https://github.com/Argent77/NearInfinity) and [ScummVM Tools](https://github.com/scummvm/scummvm-tools). The [tool reference](../tools/README.md) lists every tool with the modules and runtimes it covers, the location of its manager, its output kinds and its limits.

### Versions and installation

Version choices and release fetching use the [shared catalog contract](../runtimes/RUNTIME_CATALOGS.md). Included helpers and players run from verified application resources, and downloadable versions install into the manager's directory under userData. Downloadable versions come from catalog discovery. The list is the cached result of the last Reload; when the manager knows no version yet, installation runs the discovery itself, also during consented Play preparation, and takes the newest compatible release. `createPinnedNativeManager` has no option that names a version; its rows come from its `upstream` source, MacLauncher Builds records (`projectBuilds` or `buildsRepository`) or a `discoverCatalog` callback. Installed versions resolve offline from their installation records (`catalogEntry`), even after a release leaves the catalog. [Distribution declarations](../runtimes/RUNTIME_DISTRIBUTION.md) record each package's exact files, CPU, minimum macOS version, source revision and build recipe.

Native package files declare their CPU architectures and an optional `format`: `mach-o` (the default) or `pe` for Windows libraries. The [shared verifier](../../src/modules/shared/runtime/bundled-native.js) checks the declared format and architectures against the file bytes, and applies macOS code-signature checks to Mach-O files. Packages that mix formats get the same inventory, checksum and permission checks for every file.

A manager can provide an asynchronous `prepareLocalState(context)` for offline device queries, which runs before its synchronous `getState(context)`. Other managers publish their state independently while that query runs. Acquiring a runtime is always a separate, explicit action.

Default actions call `applySettingsUpdate(action, payload, settings, { userDataDir })`. An optional `updateSettingsAfterDefault(nextSettings, payload, { userDataDir, previousSettings })` records related preferences before the settings are committed, and custom path defaults use the same hook after selection.

### Processor architectures and macOS versions

[`host-capabilities.js`](../../src/modules/shared/runtime/host-capabilities.js) answers every question about the Mac. `launcherArch` is the app process's own CPU (`process.arch`); it chooses default builds and decides what can load into the launcher. `hardwareArch`, `translated`, `rosettaAvailable`, `macOSVersion` and the measured Metal support describe what the Mac itself can run, and `architectureSupport(arch)` tells whether a build for `arm64`, `x64` or `universal` runs here and whether Rosetta must be installed first (`installRosetta`). `versionAtLeast` is the only version comparison, and it compares the leading digits of each dotted part. [`rosetta.js`](../../src/modules/shared/runtime/rosetta.js) owns the Rosetta location, license prompt and installation.

[`architecture.js`](../../src/modules/shared/runtime/architecture.js) holds the shared CPU decisions:

- `recordArchitecture` and `matchesArchitecture` read a catalog row's CPU.
- `assetArchitecture` reads the CPU in a publisher's file name.
- `chooseArchitecture` picks a manager's build: an explicit request, then the game's saved build, the manager's saved default and the launcher's CPU. With an `offers(cpu)` test, a saved or automatic choice whose CPU has no build gives way to the launcher's CPU and then to another CPU the hardware runs, such as Apple Silicon builds in the Intel app on Apple Silicon. Java variant selection and NW.js use the same function.
- `requiresRosetta` and `imageRequiresRosetta` decide whether a build or a Mach-O image runs under Rosetta. A module passes the result to the process launcher as `needsRosetta`.
- `tagInstall` adds an installed row's CPU, support and reason.
- `withArchitecture` carries an explicit build choice through one action.

`createPinnedNativeManager` wraps each manager it creates in [`architecture-manager.js`](../../src/modules/shared/runtime/architecture-manager.js). Each CPU gets its own manager instance, catalog cache and installation directory (`runtimes/<manager>/<arm64|x64>/<version>`), so both apps can share one data folder; a Universal install serves both. `getState` merges the instances and adds `launcherArchitecture`, `automaticArchitecture`, `defaultArchitecture` and `catalog.architectureCatalogs`, which the shared **Build** menu in Runtimes reads. Each instance reports `offersBuild`, whether its CPU lists or holds a usable build, and the facade's `chooseArchitecture` passes it to the shared resolver; `resolveSelection`, an `installRuntime` without an explicit CPU, Set default and the automatic list in `getState` all use that one choice. A project-build manager also counts its included packages, and MKXP-Z forwards the per-CPU lists and the chosen CPU to its Builds packages. Java and NW.js keep their own CPU-separated installations, tag them with `tagInstall` and report them through the same fields (`architectureVariants`), so every runtime uses the same menu and tags.

Catalog rows state facts, and managers decide policy. A MacLauncher Builds record carries `arch`, `launcherArchitectures` and `minimumMacOS`. An upstream mapper sets `architecture` on each row, from the publisher's file name where it states one; it either lists every CPU the publisher offers and declares `allArchitectures: true`, or reads `options.arch` on each call. The per-CPU instances share one discovery when its rows cover their CPUs, and builds of one release for different CPUs share its version. The shared manager reads the minimum macOS version that the installed executable declares, so a mapper does not record one per release. For each version, the default is the launcher's CPU, then Universal, then an Intel build through Rosetta on Apple Silicon. A build for another CPU appears in the Build menu. Managers take availability from these records and `architectureSupport`, so adding a CPU for a project means publishing its record; the launcher needs no change. A Builds record for a CPU that the installed MacLauncher version does not know is listed as requiring a newer MacLauncher.

Files inside a downloaded package are located by one rule when a publisher has moved them between versions. An open-ended version threshold (`versionAtLeast`) orders the known locations, a bounded search of the package's contents runs when none of them match, and the location found is recorded with the installation. Unity player templates ([`unity/runtime/package.js`](../../src/modules/unity/runtime/package.js)) and Sikarugir Template renderers ([`sikarugir/graphics/closure.js`](../../src/modules/crossover/sikarugir/graphics/closure.js)) follow this rule.

### Registered local runtimes

`RuntimeRegistration` in `shared/runtime/custom-runtime.js` handles runtimes registered from local files. It stores registrations, composes the installed list, assigns opaque path IDs, and handles section defaults, selection and removal of a registration. A manager declares its layout inspector and its provider methods through `configure`. These declarations map list and resolver methods to compatible sections, keep the manager's version parsers and comparators, and keep the manager's own install directories apart from registered external paths.

Composed managers inherit the declarations. A composed manager's own layout inspector supplies the same metadata to runtime panels, installed providers and launch selectors, while base and sibling managers keep their own provider behavior. Managers with an older selector shape use `createSelector`; ordinary catalog and installed-version calls keep the manager's own implementation. [Custom runtime layouts](../runtimes/CUSTOM_RUNTIME_LAYOUTS.md) describes the runtime files and folders that can be registered.

### Presentation in Runtimes

A module manifest's optional `runtime.managerUi` maps manager IDs to `{groupId, tabLabel, order, sectionLabel, memberOrder, componentGroup, category}`; a shared manager carries the same metadata in its own `ui` object. This metadata groups and orders compact tabs without changing runtime IDs, settings, installation paths or action routing. When the visible compact tabs omit the runtime name, the panel shows the manager label, or the section label as a fallback. Managers without metadata keep their own label and follow the ordered groups.

`category` places a group under a Runtimes sidebar heading from the ordered list in `src/modules/shared/runtime/category-ui.json`:

| Category | Sidebar heading |
| --- | --- |
| `engines` | Game engines, sorted by label |
| `platforms` | Consoles and mobile |
| `compatibility` | Compatibility |
| `graphics` | Graphics |
| `tools` | Tools |

A group takes the first category that one of its members declares, and an unclassified group appears under Game engines. `order` sets the position within a heading that is not sorted alphabetically. Engine-specific tools join their engine's group, and the shared `tools` group holds tools that serve several engines.

With `componentGroup: true`, the group appears as one component overview. Each component is marked as installed or as installed automatically on Play, the ordinary version controls are collapsed under **Advanced · versions and components**, and no section tabs are shown for that group. With `hidden: true`, the manager has no Runtimes controls or sidebar entry, and creates no launcher-library tabs, but it stays registered for settings, installation and resolution.

A manager section can declare `selectionSectionId` to map a compatibility subtab to an existing settings channel. Runtime IDs and stored preferences stay the same when the download view has finer groups than the settings. A section whose versions another manager installs declares `catalog.packagesFrom: { managerId, label }`; Runtimes then names that runtime, with a button that opens it, instead of a download list, while the section keeps its own installed versions and default.

## Runtime providers

A runtime provider offers backends for games that another module detected. The Windows module provides Sikarugir (Wine) and CrossOver for modules that accept Windows executables, `mac32` provides its runtime for modules that accept the macOS i386 format, and `prosper` provides Prosper for PS5 games.

For x86 and x64 [Windows games detected by other modules](../game-types/WINDOWS.md#windows-executables-in-other-game-types), Sikarugir appears as a runtime choice, and CrossOver appears when a usable local application is available. The game keeps its detected engine, inspection actions and usual default backend. Generic Windows games default to Sikarugir, and generic macOS app imports that contain only i386 code default to mac32. Recognized engines keep their preferred runtime, and apps with compatible 64-bit executables keep their native backend.

### Declaring a provider

A module exports a `runtimeProviders` array, which takes precedence over the older singular `runtimeProvider` export. Each provider declares:

- a unique `runtimeId`, with runtime-entry metadata and a `managerId`;
- `supportsEntry(entry, moduleSettings, context)`;
- `launchRuntime(runtimeId, entry, context)`.

Optional hooks are `decorateEntry`, `canLaunchRuntime`, `ensureRuntime`, `prepareLaunch`, `prepareInput`, `getRuntimeRequirements`, `getSteamApiRequirement` and `resolveSaveLocations`. Duplicate provider runtime IDs are rejected.

A provider's runtime entry can declare `input` with `fileExtensions`, `binaryFormats`, `gameTypes` and `webContent`. Settings offers the provider to every module whose detection declarations or `runtime.inputFormats` match one of them. A provider without `input`, or one listed in the module's own `runtime.supported`, applies to every module that allows it. A module's `runtime.providers` restricts it to specific external providers; an empty array keeps only the module's own runtimes, which is how macOS Game keeps its native app runtime. Provider runtime entries can declare `uiOrder` to order the choices appended after the module's own runtimes.

### Selection and launch

The registry adds provider labels, settings and manager mappings to module metadata. The inspector narrows the choices to the imported game through `supportsEntry`, using recorded format evidence and local runtime availability; it never reads the game's files, so a game on a disconnected drive keeps its choices. `decorateEntry` runs offline during detection and records positive and negative evidence. Providers that share one decorator run it once, and refreshing the evidence keeps per-game runtime version choices. A saved choice that no longer applies stays visible and editable, the game is not moved to another backend, and launching it is refused.

Selecting a provider routes setup and launch through the provider's hooks instead of the engine's. Other backend choices keep the engine's behavior and defaults.

Automatic selection keeps a module runtime that can launch the game. A runtime entry with `launch: false`, or any runtime of a module with `supports.launch: false`, never launches. When none of a module's own runtimes can launch the game, automatic selection takes the first applicable provider in provider order. The Windows module lists CrossOver before Sikarugir, so BGI, CatSystem2 and Windows Haxe builds use a registered CrossOver application when one is available and Sikarugir otherwise. An explicit provider choice is kept.

### Capabilities and saves

A provider's `supports` flags override the engine's capabilities for that runtime. An engine's save codec never applies to an unrelated runtime's storage, so a provider with an unknown save format can turn save tools off. The Windows module uses this contract for downloaded Sikarugir and local CrossOver playback: Sikarugir exposes save locations, and engine-specific save editors and cheats stay with their engine modules.

While another backend is selected, a provider keeps the detected engine's save locations and restores them before the game returns to engine preparation. A provider with `supports.saveLocation: false` exposes no save tools and no active engine save root, even when the game has an explicit engine save-folder override.

## Standard module layout

Each module lives in `src/modules/<moduleId>/`:

| Path | Required | Contents |
| --- | --- | --- |
| `manifest.json` | Yes | Metadata and the UI contract |
| `main.js` | Yes | Module hooks and runtime integrations |
| `detect.js` | No | Detection helpers, imported by `main.js` |
| `electron.js` | No | Electron runtime bootstrap with engine-specific shims and setup, loaded by `src/modules/shared/web/preload/game.js` |
| `runtime/` | No | Runtime managers, patchers, installers and wrappers |
| `libs/` | No | Library catalog and patcher |
| `resources/` | No | Bundled assets the module needs |
| `resources/icon.png` | For game-type modules | Default artwork recorded when a game has no original icon |

Large third-party bundles can live under `src/external/` instead of `resources/` to avoid duplication. A module that depends on new `src/external` assets adds their subpaths to `build.extraResources`.

`src/modules/shared/` holds cross-module code, and engine modules depend on its contracts. It is a special namespace, not a module, and has no manifest. Its subdirectories are recorded as shared submodules for internal wiring; they never appear in the UI and need no `manifest.json`. Runtime manager objects exported from a shared submodule's `runtime/*.js` files are registered globally.

## Storage locations

| Data | Location |
| --- | --- |
| Per-game data, including module data and runtime staging | `userData/games/<gameId>/` |
| Per-module assets shared by all games | `userData/modules/<moduleId>/` |
| Runtime installations | `userData/runtimes/<managerId>/` |
| Runtime settings defaults | `userData/runtimes/<runtimeId>/settings.json` |
| Bundled assets | `resources/` inside the module |
| Diagnostic logs | The game's own userData directory, never beside the original game files |

`gameId` identifies per-game storage independently of `gamePath`.

## Manifest reference

`manifest.json` is the module contract that the launcher UI reads.

### Identity fields

These fields are required.

| Field | Meaning |
| --- | --- |
| `id` | Stable module ID, matching the folder name; lowercase is recommended |
| `family` | Family label that groups similar modules |
| `label` | Full display name |
| `shortLabel` | Short display name |
| `gameType` | Broad type string used for grouping and UI labels |

### Runtime configuration

- `runtime.default`: the runtime ID assigned to new entries.
- `runtime.supported`: the runtime IDs shown in the runtime menu. Adding `nwjs-patched` opts the module into the shared patched NW.js wrapper; engine-specific patches stay under the module's control.
- `runtime.entries`: an optional map from runtime ID to runtime metadata:
  - `label`: the display label.
  - `description`, `requirements`, `preparation` and `dataNotice`: optional text shown with the runtime's settings, covering what it is, its platform requirements, its automatic setup and how its data is kept separate.
  - `networkAccess`: an optional capability flag; `false` turns off network access controls for that runtime.
  - `settings`: an optional runtime settings schema; see [runtime settings schema](#runtime-settings-schema).
  - `supports`: optional capability overrides for a runtime provider.
  - `launch: false`: the runtime never launches games.
  - `hostFeature`: the name of a requirement in `src/modules/shared/runtime/feature-requirements.js`, such as `APPLE_SILICON`. On a Mac that can never meet it, the runtime is removed from `runtime.supported`, games of that type show the requirement instead of **Play**, and Runtimes hides managers whose `managerUi` entry names the same requirement.
- `runtime.hosted`: optional hosted-runtime configuration with `id`, an optional `fallback` and an optional `userAgent`. `userAgent.suffix` accepts `{nwjsVersion}`, which inserts the configured NW.js version. `runtime.hosted.saveDirectory: true` opts into hosted save-directory injection; modules without it keep their usual save behavior.
- `runtime.providers`: restricts the module to specific external runtime providers; see [declaring a provider](#declaring-a-provider).
- `runtime.capabilities`: what this game type's games can use from a provider, such as `bepinex` or `temporal-integration`. A provider settings field that declares `capability` appears only for game types that declare it.
- `runtime.preLaunch`: an optional map from runtime ID to readiness checks that must pass before launch, each with `statusAction`, `readyWhen`, `fixAction` and optionally `declineAction` and `prompt`.

Manager and section selection:

- `runtime.manager`: an optional map from runtime ID to runtime manager ID.
- `runtime.managerSectionBy`: an optional map from runtime ID to the entry field that selects a manager section.
- `runtime.managerSectionMap`: an optional map from runtime ID to a map of entry values to section IDs.
- Manager state can add `selectionSections`, keyed by section ID, for inspector choices grouped under a broader Runtimes section. `selectionSectionTemplate` describes an undiscovered major line with its parent `sectionId`, `versionSectionBy: "major"` and a `label` containing `{section}`. The inspector keeps that line's versions separate and preserves an exact saved version before discovery.
- `runtime.managerSectionOverrideKey`: an optional map from runtime ID to a per-game `runtimeData` key that overrides the section selection.
- `runtime.managerVersionSectionBy`: an optional map from runtime ID to `major`, for version groups whose numeric section matches the version's major number. The inspector ignores a saved patch version from another section, including when the section is chosen automatically.
- `runtime.managerSectionAuto`: an optional map from runtime ID to automatic section options. `defaultKey` names a runtime-manager state field that holds a default section; with `minimum`, a default below the detected section is ignored. `minimumKey` names a `moduleData` field that holds the compatibility minimum. A version-only choice at or above that minimum keeps its own section even when the automatic section is newer.
- `runtime.inspectorSections`: an optional map from runtime ID to `"all"` or `{ "exclude": [sectionIds] }`. The inspector combines installed and discovered versions from those sections, while Runtimes keeps its compatibility subtabs. Excluding a section hides an independent tool or helper section without hiding runtime versions. With `managerSectionOverrideKey`, choosing a version also sets the override to the `managerSectionMap` value that maps to the version's section, or to the section's `selectionSectionId` when it declares one. A version from a section that no value maps to clears the override, so the automatic section follows that version.
- `runtime.managerUi`: manager grouping and order in Runtimes; see [presentation in Runtimes](#presentation-in-runtimes).

### Runtime settings schema

`runtime.entries[<id>].settings` defines a runtime's settings, which appear in Settings as module defaults and in the game inspector as per-game overrides. It has two parts:

- `defaults`: a key/value map of global defaults for the runtime's settings.
- `fields`: a list of field definitions, each with `key`, `type` and `label`, and optionally `description` and `default`.

Field types are `boolean`, `number`, `string`, `select`, `list` and `display`:

- `select` fields require `options` entries of the form `{ value, label }`. Static select fields accept only the declared options.
- `number` fields accept `min`, `max` and `step` for their controls. Providers validate values before storing or using them.
- `list` fields store string arrays. The UI accepts one entry per line, and commas also separate entries unless the field declares `listSeparator: "newline"`, which keeps commas inside arguments, DLL overrides and environment values.
- `display` fields show a read-only table from `rows: [{label, value}]` in module and per-game settings. They store no value and take no part in defaults, overrides or reset comparisons.

Layout:

- `section` places a field under an ordered heading.
- `hostFeature`, on a field or on one of its `options`, names a requirement in `feature-requirements.js`. A Mac that can never meet it, by processor or macOS version, does not list that field or choice. An unmeasured host fact keeps it listed.
- `advanced: true` places a field in one collapsed **Advanced** group after the common fields, labeled with the number of fields it holds. The group appears only when a runtime has both kinds of field; otherwise all fields stay in one list.

Conditions:

- `disabledWhen` uses the same conditions as module actions, evaluated against the current runtime settings. It disables the control and keeps its saved value.
- `visibleWhen` and `hiddenWhen` use those conditions in both global and per-game settings. A field with `visibleWhen` appears when any of its conditions match, and any matching `hiddenWhen` condition hides it. Hidden fields keep their values, defaults and overrides. Option providers load only for visible fields.
- `requiresInstall: {managerId, sectionId}` disables a field until that runtime-manager section has a ready installation. A boolean control shows as off while the installation is missing and keeps its saved preference.

Choices from local data:

- `optionsAction` and `optionsKey` fill a field with local choices. Per-game windows call `actions[optionsAction](entry, payload, context)`, and global runtime settings call `settingsActions[optionsAction]({runtimeId}, context)`. A field available in both scopes exposes the same provider through both routes. These calls read installed runtimes and saved state without preparing game input or saving the entry, so runtime settings remain available when the game's source is missing. Static `options` supply the initial choices while the provider loads. Each provider finishes independently and fetches no files. Saved values from these providers are not changed by normalization, even when they are currently unavailable; the provider that consumes the value validates it before use.
- Runtime version fields use `optionsAction: "listRuntimeVersions"` with `optionsKey: "runtimeVersions"`. The shared `runtimeVersionChoices` helper in `src/modules/shared/runtime/version-choices.js` returns the field's static options, then the manager's installed versions and the cached catalog versions this Mac can install, newest first, with the labels used in Runtimes.

File fields:

- A string field can declare `pickerAction`, with an optional `pickerResultKey` (default `filePath`), to show a native **Browse…** action. The per-game and global action routes return the selected path, or `null` when the user cancels. The ordinary settings writer stores the path, and a canceled or failed selection keeps the saved value.
- A field that also declares `fileStatusAction` becomes a file registration control. The action receives `{filePath}` and reports whether the file is registered, missing or invalid, with a short reason. The control offers **Choose file…**, accepts one dropped local file (the picker action then receives `{filePaths}`), and provides **Replace…** and **Remove**, which change only the saved path.

Generated settings:

- `provider: {readAction, writeAction, gameOnly?}` adds settings generated from local data, shown with the same controls. The read action returns `{schema: {fields, defaults?}, values, message?}`; the write action receives `{values}` and returns the updated result. Game scopes use module actions and module scopes use settings actions, and `gameOnly: true` generates settings for individual games only. The module validates and stores the values itself, including in native preference stores, and generated choices never enter the static runtime-defaults file. Opening settings fetches no runtimes or game data.

Network access is not a runtime setting. It comes from the launcher default and one per-game override. Modules receive the effective value as `context.networkAllowed` and the derived `runtimeSettings.networkIsolation` flag, and runtime panels define no network controls of their own. A runtime that cannot run online declares `networkAccess: false` in its metadata.

### Capability flags

| Flag | Effect |
| --- | --- |
| `supports.cheats` | The module exposes a cheat schema and runtime, and the inspector shows Cheats |
| `supports.cheatsPatcher` | The module can patch the cheat tools into game files on disk, and the inspector shows Tools patching |
| `supports.saveEditing` | The module supplies a JSON save codec |
| `supports.saveLocation` | The module provides a reliable save directory, and the inspector shows the save path row |
| `supports.saveLocationOverride: false` | The save folder stays fixed, while reveal and save tools remain; other modules keep the folder chooser |
| `supports.structuredSaveEditing` | The module offers the structured editing UI, advertised together with the `save.structured` action IDs |
| `supports.launch: false` | No runtime of the module launches games |

Save tools are available when either `saveLocation` or `saveEditing` is set, and only modules with a codec show JSON editing. Snapshots, import and export work on the declared save files without decoding them. A module with a fixed save folder can provide an async `prepareSaveLocation(entry, context)` hook that prepares its own storage before save tools open.

### Settings, UI and credits fields

- `settingsDefaults`: per-module settings defaults. They define the module's fields in Settings, and a module without declared settings shows an empty section with no placeholder controls.
- `ui.settingsOrder`: a number that orders the module's Settings sidebar entry. The sidebar lists Launcher first, then module sections by `ui.settingsOrder` (lower first, 0 by default) and alphabetically by label within the same value. macOS Game uses a negative value, so its section follows Launcher. No module ID list is hard-coded.
- `detection`: input kinds, extension ownership, cheap markers and signatures, artifact probes and fallback policy; see [detection](../library/DETECTION.md).
- `ui.infoFields`, `ui.entrySelectors`, `ui.actions` and `ui.actionGroups`: inspector fields, launch choices and actions; see [UI field and action schema](#ui-field-and-action-schema).
- `ui.accounts`: one module account panel. `ui.accountProviders` adds independent account panels with the same `label`, `stateAction`, `signInAction`, `signInLabel` and `removeAction` fields. An optional `runtimeIds` shows a panel only in the selected runtime's Settings tab. Each panel calls its declared `settingsActions`, and the backend that manages the accounts keeps their inventories and credentials.
- `acknowledgments`: a list of `{ label, url }` credits. Each separate dependency, including tools and source references, has its own upstream link, and applicable license notices are kept. Credits combines this list with `src/modules/shared/acknowledgments.json`; see [attributions](../ATTRIBUTIONS.md).

### UI field and action schema

`ui.infoFields` entries are read-only rows in the inspector's **Detection** disclosure:

| Property | Meaning |
| --- | --- |
| `key` | Dotted path into the game entry, such as `moduleData.version` |
| `label` | Display label |
| `format` | Optional `boolean`, `date`, `path` or `string` |
| `empty` | Placeholder text when the value is missing |
| `hiddenWhen` | Conditions that hide the field |

`ui.actions` entries describe the module's inspector actions:

| Property | Meaning |
| --- | --- |
| `id`, `label` | Required |
| `kind` | `primary`, `secondary` or `danger` |
| `icon`, `iconOnly` | Optional button icon, and whether the button shows only the icon |
| `confirm` | Confirmation prompt text |
| `autoRun` | Run when the section expands, for status probes |
| `inspector` | `false` for actions shown by a specialized control, such as a cheats panel; their metadata and backend actions stay available there |
| `cancellable` | Show Cancel while running |
| `resultFields` | Info fields to display after the action runs |
| `disabledWhen`, `hiddenWhen` | Conditions |

A cancellable action receives `context.signal` and passes it to its asynchronous work, and closing the window that started the action also cancels it. Folder pickers and download consent keep their own controls.

`ui.entrySelectors` entries are module launch choices shown in the inspector's Files section, below the game path. Each has a required `id`, `label`, `optionsAction` and `setAction`, an optional `description` with help text, and `hiddenWhen` conditions evaluated against the library entry. The `optionsAction` returns `{ value, options: [{ value, label, disabled? }], description? }`, where a returned `description` replaces the static one. The `setAction` receives `{ value }`, validates and stores the choice, and returns the same shape. Choices load when the inspector opens, after playback stops and on an explicit Refresh, and the selector is disabled during preparation, playback and pending requests. Both actions read only local files and saved state.

Conditions in `hiddenWhen` and `disabledWhen` have a `key`, the dotted path in the game entry or action result, and one of the operators `equals`, `notEquals`, `truthy`, `falsy` or `endsWith`.

`ui.actionGroups` entries order and group the actions:

| Property | Meaning |
| --- | --- |
| `id`, `label` | Group identity |
| `actions` | Ordered list of action IDs |
| `note` | Help text shown by the group's question-mark button |
| `collapsed` | Place advanced actions in a native disclosure |
| `inlineActions` | Show a compact group of related actions together |

An expanded group shows its primary action and puts supporting actions in **More…**. Running status, Cancel for cancellable actions and results stay visible when a disclosure is closed. An absolute path in a `path` result field appears as a labeled **Reveal** button that opens the location in Finder. Numeric results stay visible, including zero. Declared inspector actions left out of every group appear under More tools, and a module with no groups shows its actions in one Game tools group. Backend operations without inspector metadata are not shown in the inspector.

## Module hooks (main.js)

A module's `main.js` can implement any subset of these hooks. They run in the backend under plain Node; see [running without Electron](#running-without-electron).

### Detection, import and removal

- `detectGame(context, helpers)` returns a detection object or `null`. `context` includes `inputPath`, `rootDir`, `isAppBundle` and `stat`. The registry provides `helpers.findIndexHtml`. A detection object can include `releaseRootDir`, the folder of the release around `gamePath` when the game's own folder is only part of it. The registry fills it in for an NW.js app package whose parent `package.json` names a start page inside it, or a `package.nw` folder; it never changes `gamePath` or `contentRootDir`, and runtime providers search it for the game's executables.
- `mergeEntry(existing, incoming, settings, context)` optionally merges per-game data before normalization. It applies to fresh and cached metadata alike, including the preservation of custom names. `context` includes `userDataDir`.
- `onImport(entry, context)` runs when a game is first added to the library, for one-time setup such as staging bundled assets, with no background network access. `context` includes `userDataDir`, `settings` and `logger`.
- `prepareInput(entry, context)` is an optional synchronous hook for imports, launches, module and tool actions, and direct save operations. It can return a transient runtime or tool entry with remapped content paths.
  - Actions that read the source use the canonical `sourceEntry`; runtime, patch and plugin actions use the writable view.
  - The returned entry keeps the original `gameId`, `gamePath`, `importPath`, `contentRootDir`, `indexDir`, `indexHtml` and `containerData`. Per-game `moduleData`, `defaultSaveDir` and unsafe save overrides inside the container may point to outputs in launcher data.
  - With `context.readOnly: true`, the hook calculates paths and reads existing views without creating directories or copying files. `context.signal` carries cancellation before and during preparation.
  - Views use real directories, private copies of mutable files and links to immutable assets. Plugin and library writes atomically replace a linked leaf file and never modify its original target. See [writable input views](../library/GAME_PREPARATION.md#writable-input-views).
- `getContentReadRoots(entry, context)` optionally declares the game's original, immutable content roots for read-only HTTP asset serving. Without it, the usual policy of serving only from the contained root applies. The declared roots must not include unrelated directories.
- `cleanupGameData(entry, context)` runs while a game is being removed, with exclusive access, after its launches, tools and save actions have stopped or finished. It deletes per-game data under `userData/games/<gameId>/`, such as extracted bundles, wrappers and builds. `context` includes `userDataDir`, `settings`, `logger`, `gameId`, `gamePath` and `moduleId`.

### Runtime selection

The runtime menu lists `manifest.runtime.supported`. The default runtime is `settings.modules[<id>].defaultRuntime`, then the result of the optional `resolveDefaultRuntime` hook, then `manifest.runtime.default`. Explicit game and module choices take priority over the hook. `getResolvedModuleSettings(settings)` exposes the effective defaults without writing them into stored settings.

- `normalizeRuntimeId(runtimeId)` normalizes runtime IDs: it lowercases them and supplies a fallback when one is missing.
- `filterRuntimeSupport(entry, supported, moduleSettings)` returns the runtime list filtered for a specific game.
- `resolveDefaultRuntime(entry, moduleSettings, context)` chooses an automatic default. It is synchronous and offline; `context.getRuntimeManagerState` supplies cached installed-runtime state when available.
- `canLaunchRuntime(runtimeId, entry, moduleSettings, context)` returns true when the runtime can launch the game.
- `runtimeRecommendation(entry, context)` returns what the game's own data recommends for its selected managed runtime, as `{ version?, sectionId?, variant?, requiredVariant?, requiredVariantReason? }`, or `null`. A recommended `variant` is the one Play uses when the game has no variant override; Godot reports Standard or .NET from the game's files and the builds installed for its version. A `requiredVariant` is one that Play uses whatever variant is chosen for the game, with a short `requiredVariantReason`; Godot reports .NET for games with C# content. The inspector names a recommended version as **Recommended (vX)** and a recommended variant in the **Variant** menu's **Default** entry, and it shows a required variant as the menu's selection, with the other variants disabled and the reason under the menu.
- `getRuntimeRequirements(entry, context, { primary })` adds exact `{ managerId, version, installOptions?, requiresDownload? }` plans for native bridges and other dependencies, or returns `[]` when they are already available. The backend validates and deduplicates the complete plan and obtains consent for every required download before installing anything. Optional `label` and `progressLabel` name the dependency in consent and progress displays, so a shared asset can describe its download without changing the runtime selection or its default.

Selecting a different runtime refreshes the module's save locations for it in the backend worker before the updated inspector state is returned.

### Launch and process lifetime

- `launchRuntime(runtimeId, entry, context)` launches module runtimes that the hosted and native flows do not handle, and returns a process handle or `null`.
  - A runtime with its own supervisor can bind the returned child with `core/process-lifecycle.bindProcessStop(child, callback)`. Stop in the UI and interruption on the command line then call the same idempotent callback; other children are stopped by terminating their process group. The callback runs the runtime's shutdown protocol within its time limit and rejects if cleanup fails. Until it settles, the game and runtime leases stay held, even after the root process exits. A lease keeps the game reserved and keeps its runtime version from being replaced or removed while in use. The callback receives the original child, its PID and a predicate that reports whether the binding is still current, so a process ID alone never selects a later launch.
  - A native macOS application can call `shared/runtime/native-app-stop.bindNativeAppStop` before publishing the child. It sends a normal AppKit Quit without activating the app, checks that the process is the launched instance and executable, and waits for it to exit. On timeout it terminates the process forcibly, without starting a concurrent SIGTERM teardown. Godot uses this binding.
  - `child.runtimeRetirement` is a promise for asynchronous teardown after a normal exit, a window close or Stop. The module sets it in the exit listener or before requesting Stop. The backend worker and the game, runtime and graphics leases stay held until it completes. If it rejects, they stay held and the error is recorded as `runtimeRetirementError`; runtime cleanup keeps files and descriptors that live consumers still use.
- `launchNativeRuntime(entry, context)` optionally launches the module's own native entry point and returns its process handle. Returning `null` uses the shared app-bundle launch flow. The macOS Game module uses this hook for selected scripts and standalone executables, with the shared graphics settings and process-group lifetime tracking.
- `resolveNativeLaunchPath(entry, context)` returns a native app bundle or the selected script or executable when the module supports native launches.
- `prepareNativeLaunch(entry, context, { appPath, executable })` optionally returns `{ args, environment }` for a native app. The launcher keeps the original executable, bundle, working directory, Steam environment and process lifetime. Files the module prepares go in its private game data directory.
- `nativeHostDependencies()` returns the exact native plugin relationships supplied during launch. Each record identifies the additional resource and its version, the plugin file and its SHA-256, the loader-relative dependency, the matching included provider, version and file, and the original install names that are kept. Java JNI and LuaSteam use it for their per-game Steam API layout. Other native dependencies are packaged with the component that uses them.
- `getSteamApiRequirement(entry, context, { cmd, args, options })` is an optional check before a native process starts. It returns `null` for unrelated games and tool processes, or a requirement with evidence from the actual consumer: its CPU, imported symbols and interface versions, and application ID. The shared backend resolves a matching native library or included helper before spawning the process.
  - `applySteamApi(entry, prepared, context, plan)` can add module-specific private plugin links or bootstrap paths. A module with its own staging flow can instead call `await context.prepareSteamApi(requirement, { baseEnvironment })` directly.
  - During Play, when preparation selects the game's own library for a game installed by Steam, it also applies the Steam client choice. After consent, or with a standing Start automatically choice, it starts the Steam client and waits a limited time for it to sign in. Native launch hooks call `await context.prepareNativeSteam(appPath)`, which handles the installed application ID and the same client start for apps that ship the macOS Steam API.
- `onRuntimeCrash(entry, { runtimeId, signal }, context)` can offer engine-specific recovery through the injected UI services. The launcher handles process lifetime and persistence for every module; Godot's extraction prompt, for example, lives in the Godot module.

### Graphics

- `resolveGraphicsInputs(entry, context)` optionally describes the selected renderer's inputs, including `{ cameraProjection, source, methods }` for a camera integration. The graphics service intersects these methods with the installed providers and the selected presentation host. Native video can advertise `nativeVideo`, `sourceResolution: false`, its spatial filter registry and `shaderBindingsNextLaunch`. A module that prepares its own integration can set `context.graphicsInputs` before applying the graphics environment, and setting it to `null` turns off additional inputs for that launch. Runtime status passes the eligible inputs to the inspector. Live changes use the inputs recorded at launch.
- `prepareEffectsEntry(entry, context)` optionally returns a transient entry for shared graphics preparation, leaving the saved entry and its full Advanced plan unchanged. The video module uses it to keep its original mpv shader prefixes and native Simple scaling inside its renderer, while later RGB stages use the shared processor. The same transformation applies to launch preparation and graphics edits. The [graphics pipeline](../graphics/PIPELINE.md) describes input metadata and ordering.

### Metadata and icons

- `resolveGameIcon(entry, context)` optionally extracts a module-specific icon and returns its path. Preserved custom library artwork comes first, then this hook, then app or executable extraction, then the module's default icon. When an optional extraction fails, the later candidates are still tried; cancellation still reaches the caller.
- `resolveGameMetadata(entry, context)` is an optional asynchronous package metadata lookup that runs in the backend worker, never in the renderer. It returns entry fields such as a localized name and module metadata. A failure in the optional title or artwork lookup, in a diagnostic observer or in publishing to the metadata cache never prevents use of a detected entry, while cancellation and failed writes to the game record, saves or inputs still reach the caller. `context.signal` carries cancellation of a pending launch through uncached metadata and icon lookups, until runtime preparation begins.
  - `metadataCacheKey(entry, context)` adds module-specific values, such as the source, the locale and the installed reader, to the library cache key.
  - `metadataSources` optionally lists up to 32 additional metadata-reader source files, relative to the module directory; shared readers can use `../shared/` paths. When the metadata service starts, it adds these files once to the fingerprint of the application and module sources. A changed reader therefore invalidates stored facts, and an unchanged refresh reuses cached facts without reopening game assets. Only the listed files are read; source directories are never traversed.

### State and exported objects

- `getState(context)` returns module state, exposed to the UI as `moduleStates[<id>]`.
- `actions` and `settingsActions` hold the module's action handlers. Inspector actions are called as `actions[id](entry, payload, context)`, and module-scope settings actions as `settingsActions[id](payload, context)`.
- `runtimeManagers` is the array of the module's runtime manager objects, deduplicated globally by ID; see [runtime managers](#runtime-managers).
- `save` declares save files:
  - `extensions` and optional exact `names` identify save files, including for modules that only provide a location.
  - Optional `decode(raw, {maxOutputBytes})` and `encode(json)` supply a JSON codec with an output size limit. `binary: true` declares that the codec works on Buffers; by default codecs use UTF-8 strings.
  - Optional `structured: {inspectAction, editAction}` advertises structured editing.
  - Write actions receive `context.assertSaveWriteAllowed()` and `context.snapshotSaves({reason})`; see [save snapshots](../tools/SAVE_SNAPSHOTS.md).
- `cheats` holds the cheat schema, defaults, normalization, equality and patcher.
- `libs` holds the library catalog and patcher for the library versions the module manages.

## Detection

The registry delegates detection to `src/modules/detection.js`. It normalizes the input once, applies manifest extension ownership, decides which specific probes run and combines their results, inspects artifacts within fixed limits, and then runs generic fallbacks. Two equally strong matches are reported as a conflict, and the order of labels in the UI never chooses an engine. A synchronous API is also available, and asynchronous imports and launches run expensive probes and shared archive inventories in workers with fixed limits. A new module takes part in detection and its error messages without launcher changes.

`explainDetection` and `explainDetectionAsync` return the candidates, a trace, cache metrics and version evidence. The [detection pipeline](../library/DETECTION.md) describes the flow, the declaration contract, the limits and parallelism. The CLI's `--inspect` option and the inspector's **Detection** disclosure show this report without running game files, and the inspector header already shows the engine and version evidence.

The web modules also detect NW.js app bundles at `Contents/Resources/app.nw`, and Electron-style layouts at `Contents/Resources/app` (using `dist/index.html`) and in `resources/app` roots.

## Titles and icons

A module can supply its own icon through the `resolveGameIcon` hook and its own title and metadata through `resolveGameMetadata`; see [metadata and icons](#metadata-and-icons). When no module icon is resolved, the launcher extracts the app or executable icon and falls back to the module's `resources/icon.png`. The built-in readers for app bundles, Windows executables, HTML exports, Ren'Py, LÖVE, Java, IPA packages, Siglus and RealLive, and Android packages are described in [icon readers](../library/GAME_ICONS.md#icon-readers), with their caches.

A metadata refresh keeps custom library titles and artwork. Otherwise names and icons follow changes observed in the source, and changing the runtime keeps the detected game module.

## Running without Electron

Registry discovery, module imports and game actions work under plain Node, without Electron. An Electron host provides UI services as `context.ui = { shell, dialog, nativeImage }`, and module code retrieves them through `shared/ui-services.js`. Without an adapter, file dialogs and reveal actions fail with errors that say what to do, and optional icon conversion can return `null`. GDRE file actions also accept `payload.filePaths`, so the tools can run without dialogs.

Optional tool actions call `context.confirmRuntimeInstall(plan)` for missing downloads, then install the selected version and continue. Declined consent raises an `AbortError` with `code: "ABORT_ERR"`. Installed and included tools need no download prompt. Without a consent adapter, an explicit Node action counts as consent to the downloads it requires.

`context.onToolProcessSpawn(child)` keeps the game reserved while a tool's child process runs, and keeps its backend worker available for later actions in the same session. A temporary inspector server can pass `{ stopOnLauncherExit: true }` as the second argument so that it stops with the launcher; ordinary game and editor processes keep their usual lifetime. At shutdown, the backend stops accepting new jobs, finishes the jobs it has accepted and stops temporary servers registered meanwhile. Long-running GUI tools call `use.retainUntilClosed(child)` inside `withRuntimeUse`, which protects their tool and host versions after the action returns. Shared tool commands also bind their tool and host reader lease to the child's PID, so the versions cannot be removed after the worker exits. Processes and callbacks use plain Node APIs.

Runtime hooks continue to use `context.spawnDetachedChecked`, runtime settings, cheat paths and the entry and runtime state callbacks. The [backend guide](BACKEND.md) describes the backend integration.

## Game arguments

`entry.launchArguments` is a per-game setting shared by every runtime choice. During a game launch, `context.gameArguments` holds its parsed string array; tool and preparation-only contexts receive an empty array.

- Native adapters add these values at the end of the game's argument list, after the launcher's required options and any older runtime-specific application arguments. Interpreter and virtual machine options stay separate.
- Helpers, downloads and configuration tools never receive game arguments.
- Hosted web adapters pass the array separately from browser switches, and expose the application arguments through `nw.App.argv` and the game renderer's `process.argv`.
- Every game process with arguments also receives `MACLAUNCHER_GAME_ARGUMENTS`, a JSON array of the same strings. It carries the values to application types without a conventional `argv`, including Android processes and library-based hosts. An empty argument list clears an inherited value.
- Android JVM, Mac.apk and AIM launch adapters also pass the JSON string as the initial Activity Intent extra `maclauncher.arguments`. ART follows the same environment contract and keeps its selected boot image.

Service and helper spawns pass `gameArguments: false` in their spawn options to clear the environment value. `context.applyGameEnvironment(environment, { gameArguments: false })` does the same for adapters that build their own process options. The game application decides which arguments it recognizes.

## Adding a module

A module consists of:

- its manifest, Node hooks and detection metadata;
- a base icon at `resources/icon.png`;
- backend tests.

Versioned managers also declare their distribution and overlay inputs. Add the module to the [module inventory](#module-inventory) with its runtime IDs and game-type page, and record its upstream sources and license notices in the [attributions](../ATTRIBUTIONS.md) and the source inventory.
