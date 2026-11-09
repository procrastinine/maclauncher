# Repository guide

MacLauncher is a macOS-first Electron launcher for games made with many different engines. Support for each game type comes from a module under `src/modules/`, and the module registry discovers the modules at runtime, so the launcher code has no per-engine branches.

This page is the starting point for contributors. It describes what the repository contains, how its parts fit together and which page documents each part. The [MacLauncher guide](../README.md) describes the app itself: adding games, inspector actions, tools and storage.

## Principles

- The launcher follows macOS conventions for windows, menus and shortcuts.
- The app uses the network only after an explicit user action, as [downloads and offline use](../runtimes/README.md#downloads-and-offline-use) describes. The one exception is the [update check](../UPDATES.md) at launch, which runs only when **Check for updates at launch** is turned on; it is off by default.
- Engine-specific behavior lives in modules. The launcher reads module metadata and calls module hooks through the shared backend contract.
- The launcher stays separate from the game runtimes, and module code makes any changes a runtime needs.
- Upstream checkouts under `src/external/` are read-only. MacLauncher's changes to upstream code are kept as overlays in the module that needs them.

## How the parts fit together

### Modules and the registry

A module handles detection, metadata, actions and launch preparation for one game type; the [module system](MODULES.md) defines the contract. The registry in `src/modules/registry.js`:

- discovers modules under `src/modules/<id>/` and treats `src/modules/shared/` as a special namespace whose subdirectories it records for internal wiring;
- loads the runtime managers that modules export, as well as those under `src/modules/shared/*/runtime/`;
- composes module-exported runtime providers, so that compatible backends can serve game types detected by other modules without changing the detected engine;
- runs detection through `src/modules/detection.js`: it selects probes from manifest declarations, uses worker probes with fixed limits for asynchronous container inspection, runs the generic web and app fallbacks last, combines matches and reports conflicts;
- derives the file-type filters of the add-game dialog from module detection metadata;
- exposes module metadata to the launcher UI;
- keeps a backend worker alive while a registered inspector process runs, so that later tool actions can reuse or close the session without marking the game as playing. Temporary inspector servers can opt to shut down with the launcher, while independently opened game and editor processes keep their normal lifetime.

### Shared backend

`src/core/launcher.js` resolves, prepares and launches games and runs module actions in plain Node, without Electron. The Electron app calls it through isolated backend workers, and the `pnpm launch` command line calls it directly. [Backend and command line](BACKEND.md) describes the service, its workers and the CLI.

### Main process

`src/main/main.js` runs the Electron launcher:

- it owns `settings.json` and the per-game records under `userData/games/`, and normalizes entries with module metadata and schema defaults;
- it delegates runtime selection, launch dispatch and runtime settings to `src/core/launcher.js`;
- it injects Electron shell, dialog and icon services into module contexts, so that importing a module in Node does not load Electron;
- it exposes the IPC endpoints that the renderer uses.

`src/main/app-update.js` checks GitHub for a newer MacLauncher release and installs it; [app updates](../UPDATES.md) describes the checks and the installation.

`src/main/bootstrap.js` chooses between the launcher and the standalone web-game host when the packaged app starts.

### Preloads

MacLauncher has two preload scripts. The launcher preload, `src/modules/shared/web/preload/launcher.js`, exposes the IPC API to the renderer, and the game preload, `src/modules/shared/web/preload/game.js`, loads the module's Electron runtime and installs the security controls for hosted web games.

### Renderer

The launcher's interface is a React app in `src/renderer/`, starting at `src/renderer/src/ui/App.tsx`. It renders the library, inspector, Settings and Runtimes views from module manifests and state. Current module presentation metadata also applies to cached runtime state; grouping and labels keep the original manager, section and version IDs. The [UI guide](UI_GUIDE.md) describes every window and control, and [UI styles](UI_STYLES.md) maps styles and components to their source files.

### Launch flow

1. The user picks a file or folder, including `.jar`, `.love` and `.AppImage` files, or drags it into the launcher.
2. The registry detects the module and returns a normalized record.
3. The main process merges and normalizes the game record.
4. The renderer shows the module-driven UI and settings.
5. On **Play**, an isolated Node worker calls the same backend that `pnpm launch` uses. Native runtimes start directly, and hosted web games run in the standalone game host. The main process sends cached state to the launcher windows while the backend work continues.

### Data and resources

Launcher data lives in Electron's `userData` directory: per-game records and files under `userData/games/<gameId>/`, and shared runtime installations that never contain per-game data. Removing a game removes all of its launcher data, including unpacked or staged assets stored outside the original game directory. The [data model](DATA_MODEL.md) describes the complete layout.

App resources stay separate from installed data: packaging takes the declared core graphics components and internal helpers from `src/resources/`, while game runtimes, including MKXP-Z, are downloaded into `userData`.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/core/` | UI-independent backend: launch dispatch, runtime settings, process execution, library records, the local game server, backend workers (`backend-worker-client.js`, `backend-operations.js`) and per-game facts (`game-metadata.js`, `file-observations.js`) |
| `src/main/` | Electron launcher process: windows, UI state, dialogs and IPC adapters |
| `src/runtime/electron-game.js` | Standalone Electron game host, without the launcher UI |
| `src/renderer/` | Launcher UI (React) |
| `src/modules/` | Module registry, detection and one directory per module |
| `src/modules/shared/` | Code shared by modules: runtime helpers, the cheats base, web runtime support, preloads and utilities |
| `src/modules/shared/installers/` | Offline installer inspection, extraction and cached import, within fixed limits |
| `src/external/` | Upstream source checkouts (Git submodules), each at an exact commit |
| `src/external/maclauncher-android/` | MacLauncher Android at an exact commit: the Android framework, JVM and native implementations and the build tools for the ART runtime. Source-only aliases keep existing build entry paths. The app includes its small metadata helper; the Android runtime packages download separately and need no Git or build tools. |
| `src/resources/` | App resources: artwork, the embedded Python runtime, 7-Zip and the included core graphics and internal helpers |
| `scripts/` | Development, setup, staging, packaging and release scripts, including `run-game.mjs`, the plain Node command-line entry point |
| `build/` | Packaging inputs: included runtime packages (`runtime-packages.json`), source dependencies for app builds (`source-dependencies.json`), the app icon and entitlements |
| `tests/` | Node backend and UI contract tests |
| `docs/` | Documentation |
| `website/` | Project website |

Each module directory is named after its module ID. The [module inventory](MODULES.md#module-inventory) lists every module with its game-type page and runtime IDs.

## Related repositories

[MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) provides the binary builds, version history and patches of the downloadable runtimes and tools, built from exact upstream commits, and [MacLauncher Android](https://github.com/procrastinine/maclauncher-android) contains the Android runtime implementation. [Releases](RELEASING.md) describes how the three repositories release.

Graphics and Vulkan native source lives in `src/modules/shared/reshade/` and `src/modules/shared/vulkan/native/`. MacLauncher Builds materializes these modules from an exact MacLauncher source commit and supplies the package recipes, manifests and licence inputs. The libplacebo provider build wrapper and dependency recipes live together in MacLauncher Builds under `producers/package-support/src/modules/shared/reshade/`.

## Documentation map

### Using MacLauncher

- [MacLauncher guide](../README.md): adding games, inspector actions, tools and storage.
- [Game types](../game-types/README.md): one page per game type, covering accepted inputs, detection, saves, tools and the runtimes that play it.
- [Runtime system](../runtimes/README.md): runtime selection, managers, version overrides, settings and launch. [Catalogs](../runtimes/RUNTIME_CATALOGS.md), [distribution](../runtimes/RUNTIME_DISTRIBUTION.md) and the [settings reference](../runtimes/SETTINGS_REFERENCE.md) cover the details. Runtimes that serve several game types have their own pages: the [Electron and NW.js web hosts](../runtimes/WEB_RUNTIMES.md), [Sikarugir](../runtimes/SIKARUGIR.md) and [CrossOver](../runtimes/CROSSOVER.md).
- [Graphics and effects](../graphics/README.md): shaders, effect order, upscaling, neural reconstruction and frame generation.
- [Video](../game-types/VIDEO.md): mpv playback, graphics settings, previews and video export.
- [Tools](../tools/README.md): inspector tools for every game type, with their outputs and limits. Shared tools have their own pages: [save snapshots](../tools/SAVE_SNAPSHOTS.md), [cheats](../tools/CHEATS.md), [native inspection](../tools/NATIVE_INSPECTION.md) with Rizin and Ghidra, and the [installer reader](../tools/INSTALLERS.md). Tools for a single game type are on its page, for example [Ren'Py tools](../game-types/RENPY.md#tools), [RGSS scripts](../game-types/RPGMAKER_XP_VX.md#ruby-scripts), [MV/MZ save editing](../game-types/RPGMAKER_MV_MZ.md#structured-save-editing), [Flash tools](../game-types/FLASH.md#tools) and [Near Infinity](../game-types/INFINITY_ENGINE.md#near-infinity).
- [External libraries](../library/EXTERNAL.md) and [Android downloads](../library/GOOGLE_PLAY.md): discovery of installed games, store accounts, version selection and downloads.
- [Preparation and storage](../library/GAME_PREPARATION.md): original assets, per-game files and shared runtimes.

### Architecture and contracts

- [Module system](MODULES.md): the module contract, manifest fields and `main.js` hooks.
- [Backend and command line](BACKEND.md): the Node service, backend workers, the CLI and module actions.
- [Data model](DATA_MODEL.md): stored settings, library records and runtime selections.
- [Detection](../library/DETECTION.md): staged probes, cached facts and version evidence.
- [Graphics pipeline](../graphics/PIPELINE.md): the shared graphics architecture, with links to the adapter, provider, frame API, live-update, media and delivery references.
- [UI guide](UI_GUIDE.md) and [UI styles](UI_STYLES.md): launcher windows and controls, design tokens, components and their source files.
- [Game icons](../library/GAME_ICONS.md) and [icon assets](ICON_ASSETS.md): artwork extraction, caching and the bundled icons.

### Building and releasing

- [Development](DEVELOPMENT.md): source setup, dependency policy, checks, packaging and included helpers.
- [macOS app builds](CI.md): the app build workflow.
- [Releases](RELEASING.md): runtime and app versions.
- [Upstreams](../runtimes/UPSTREAMS.md) and [attributions](../ATTRIBUTIONS.md): exact upstream sources and licenses.

Shared driver headers come from the pinned `src/external/maclauncher-kosmickrisp` source. Android runtime tests and fixtures belong to the pinned Android repository. Source initialization includes the shared helper submodules of both repositories.
