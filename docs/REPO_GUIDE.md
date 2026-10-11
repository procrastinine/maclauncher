# MacLauncher repo guide

MacLauncher is a macOS-first Electron launcher with a modular engine system. All engine-specific behavior lives under `src/modules/*` and the launcher discovers modules dynamically at runtime. There are no per-engine branches in the launcher code.

Start with the [MacLauncher guide](README.md) for adding games, runtimes, tools and compatibility. This page indexes the repository and technical contracts.

## Docs index

- [User guide](README.md): adding games, inspector actions, tools and storage.
- [Runtime guides](runtimes/README.md): engine support, runtime selection, versions, setup and distribution.
- [Backend](BACKEND.md) and [module contract](MODULES.md): standalone Node actions, workers and module hooks.
- [Detection](DETECTION.md): staged probes, cached facts and version evidence.
- [UI guide](UI_GUIDE.md) and [styles](UI_STYLES.md): launcher views and component styling.
- [Data model](DATA_MODEL.md) and [preparation](GAME_PREPARATION.md): per-game state and original-file handling.
- [Save snapshots](SAVE_SNAPSHOTS.md), [MV/MZ editing](MVMZ_SAVE_EDITOR.md), [RGSS tools](RGSS_TOOLS.md), [Ren'Py tools](RENPY_TOOLS.md) and [cheats](cheats.md): game data tools.
- [Flash tools](FLASH_TOOLS.md) and [Infinity Engine tools](INFINITY_TOOLS.md): managed decompilers and resource inspectors.
- [Development](DEVELOPMENT.md) and [CI](CI.md): source setup, checks and app builds.
- [Upstreams](UPSTREAMS.md), [attributions](ATTRIBUTIONS.md) and [release procedure](RELEASING.md): exact sources, licenses and publication requirements.
- [Game icons](GAME_ICONS.md) and [icon assets](ICON_ASSETS.md): extraction and fallback artwork.

## Core principles
- Mac-first UX and conventions.
- Offline by default; network only on explicit user actions.
- Modular engine system; launcher code never branches on engine names.
- Launcher/runtime separation; module code owns runtime changes.

## Design decisions
- All info about an individual game in userData must live under `userData/games/<gameId>/` (never under module/runtime roots).
- Deleting a game removes all of its userData (including any unpacked or staged assets stored outside the original game directory).
- App resources and installed userData remain separate. Packaging selects declared runtime payloads from `src/resources/` and excludes unused or developer-only sources. New MKXP-Z versions download to userData, and version checks compare included and downloaded versions.

## Repo map
- `src/core/`: UI-independent launch dispatch, runtime settings, process execution, library records and local game server.
- `src/core/backend-worker-client.js`, `backend-operations.js`: isolated Node workers for game/runtime/tools/save work and asynchronous host adapters.
- `src/core/game-metadata.js`, `file-observations.js`: persistent per-game facts/icons and observed-source invalidation.
- `src/main/bootstrap.js`: packaged launcher versus standalone web-game host entry selection.
- `src/main/main.js`: Electron launcher windows, UI state, dialogs and IPC adapters.
- `src/runtime/electron-game.js`: standalone Electron game runtime without the launcher UI.
- `scripts/run-game.mjs`: plain Node command-line entry point.
- `src/modules/shared/`: shared code (cheats base, web runtime helpers, shared utilities).
- `src/modules/shared/installers/`: bounded offline installer inspection, extraction and cached import.
- `src/modules/shared/web/preload/launcher.js`: launcher IPC bridge.
- `src/modules/shared/web/preload/game.js`: game preload and module runtime loader.
- `src/renderer/`: launcher UI (React).
- `src/modules/`: module registry and engine modules.
- `src/modules/rgss/`: RGSS (RPG Maker XP/VX/VX Ace) module and MKXP-Z runtime manager.
- `src/modules/easyrpg/`: RPG Maker 2000/2003 detection and managed EasyRPG Player releases.
- `src/modules/scummvm/`: adventure-game data detection and managed ScummVM releases.
- `src/modules/wolfrpg/`: WOLF RPG Editor detection, archive preparation and managed Browser Woditor releases.
- `src/modules/crossover/`: local CrossOver application versions and Windows executable playback across game types.
- `src/modules/mv/`: RPG Maker MV module (shared MVMZ logic).
- `src/modules/mz/`: RPG Maker MZ module (shared MVMZ logic).
- `src/modules/renpy/`: Ren'Py module (SDK runtime + patching/builds).
- `src/modules/godot/`: Godot module (runtime downloads).
- `src/modules/nscripter/`: NScripter module (Yuri and ONScripter-EN runtimes).
- `src/modules/java/`: Java jar module (runtime manager + Vineflower extraction flow).
- `src/modules/love/`: LÖVE module (managed releases/nightlies, native app support, AppImage staging).
- `src/modules/fna/`, `src/modules/unity/`: managed FNA/XNA hosting and exact-version Unity Mono player replacement.
- `src/modules/flash/`: Flash module (`.swf`) with an included universal Flash Player and managed Ruffle runtime.
- `src/modules/construct/`: Construct module (packaged bundle extraction).
- `src/modules/tyrano/`: Tyrano module (packaged bundle extraction).
- `src/modules/web/`: generic web fallback module.
- `src/modules/gamemaker/`, `src/modules/gamemaker-html5/`: GameMaker tools, native runtimes and HTML5 exports.
- `src/modules/kirikiri/`, `src/modules/alicesoft/`: native VN interpreters.
- `src/modules/ai5/`, `src/modules/siglus/`, `src/modules/nitroplus/`: edition-specific native VN interpreters.
- `src/modules/vnds/`: converted VNDS exports hosted by LÖVE.
- `src/modules/catsystem2/`: archive/script tools; not yet supported for play.
- `src/modules/minori/`: native PAZ playback, original-PE key handling, private saves and script tools.
- `src/modules/bgi/`: BGI archive and program tools; not yet supported for play.
- `src/modules/fvp/`: FAVORITE/FVP detection, private game preparation and managed RFVP versions.
- `src/modules/mages/`: MAGES MPK/SC3 tools and the Windows HD Impacto runtime.
- `src/modules/gemrb/`, `src/modules/ikemen/`, `src/modules/hashlink/`: native adapters.
- `src/modules/haxe/`: inspection of compiled Windows [Haxe](https://haxe.org/) C++ builds; not yet supported for play.
- `src/modules/generic-app/`: macOS app fallback.
- `src/modules/detection.js`: staged manifest-driven detection and aggregation.
- `docs/`: documentation.

The [module inventory](MODULES.md#modules-and-backends) lists every discovered game type and its runtime backends.

## Architecture overview

### Module registry
`src/modules/registry.js`:
- Discovers modules under `src/modules/<id>/`.
- Treats `src/modules/shared/` as special and records its submodules for internal wiring.
- Loads runtime managers exported by modules and from `src/modules/shared/*/runtime/`.
- Retains a backend worker while a registered inspector process runs, so later tool actions can reuse or close the session without marking the game as playing.
- Temporary inspector servers opt into shutdown with the launcher; independently opened game and editor processes retain their normal lifecycle.
- Gates module probes from manifest declarations, aggregates matches and reports conflicts.
- Uses bounded worker probes for async container inspection; generic web/app fallbacks run last.
- Derives game-dialog format filters from module detection metadata.
- Exposes module metadata to the launcher UI.
- Composes module-exported runtime providers so format-compatible backends can serve existing game types without changing their detected engine.

### Main process
`src/main/main.js`:
- Owns `settings.json` and per-game records under `userData/games/`.
- Normalizes entries via module metadata and schema defaults.
- Delegates runtime selection, launch dispatch and runtime settings to `src/core/launcher.js`.
- Injects Electron shell/dialog/icon services into module contexts; importing modules in Node does not load Electron.
- Exposes IPC endpoints to the renderer.

### Preloads
- Launcher preload exposes IPC APIs to the renderer.
- Game preload loads the module electron runtime and installs security controls.

### Renderer
`src/renderer/src/ui/App.tsx`:
- Renders the launcher UI using module manifests and state.
- Renders full Settings and Runtimes views from module metadata.

## Launch flow (high level)
1. User picks a file/folder (including `.jar`, `.love`, and `.AppImage`) or drags it into the launcher.
2. Registry detects the module and returns a normalized record.
3. The main process merges and normalizes game records.
4. The renderer renders module-driven UI and settings.
5. On Play, an isolated Node worker calls the same backend used by `pnpm launch`; native runtimes spawn directly and hosted web games run in the standalone host. The main process publishes cached state while backend work continues.

## Adding a new module
- Update docs alongside code changes.

## What not to do
- Do not add background network traffic.
- Do not edit `src/external/`; treat external clones as read-only.
