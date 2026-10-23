# MacLauncher repo guide

MacLauncher is a macOS-first Electron launcher with a modular engine system. All engine-specific behavior lives under `src/modules/*` and the launcher discovers modules dynamically at runtime. There are no per-engine branches in the launcher code.

The [MacLauncher guide](README.md) describes imports, runtimes and game tools. This page indexes the repository and technical contracts.

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
- [External libraries](EXTERNAL.md): offline installed-game discovery, store accounts, version selection and downloads.
- [Graphics and effects](GRAPHICS.md): filters, upscaling, frame generation, supported formats and runtime coverage.
- [Graphics pipeline](GRAPHICS_PIPELINE.md): runtime adapters, frame inputs, effects API, ordering and GPU resource ownership.
- [Video playback](runtimes/VIDEO.md): managed mpv, native shader/scaling selection, preview and export of compatible graphics settings.

## Core principles
- Mac-first UX and conventions.
- Offline by default; network only on explicit user actions.
- Modular engine system; launcher code never branches on engine names.
- Launcher/runtime separation; module code owns runtime changes.

## Design decisions
- Per-game records and launcher data live under `userData/games/<gameId>/`. The Klepton Android runtime retains data under `userData/android/apps/<gameId>/data/`; Mac.apk and AIM use `userData/android/apps/<gameId>/providers/<runtimeId>/`; shared runtime installations never contain per-game data.
- Deleting a game removes all of its userData (including any unpacked or staged assets stored outside the original game directory).
- App resources and installed userData remain separate. Packaging selects the declared core graphics and internal-helper closure from `src/resources/`. Game runtimes, including MKXP-Z, download to userData and retain explicit version choices.

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
- `src/modules/android/`: Android import, settings, managed delivery and per-game process/storage orchestration.
- `src/external/maclauncher-android/`: pinned Android framework, JVM/native implementations and ART producers. Source-only aliases retain existing build entry paths. The app includes its small metadata helper; managed runtime packages install separately without Git or build tools.
- `src/modules/rgss/`: RGSS (RPG Maker XP/VX/VX Ace) module and MKXP-Z runtime manager.
- `src/modules/easyrpg/`: RPG Maker 2000/2003 detection and managed EasyRPG Player releases.
- `src/modules/scummvm/`: adventure-game data detection and managed ScummVM releases.
- `src/modules/wolfrpg/`: WOLF RPG Editor detection, archive preparation and managed Browser Woditor releases.
- `src/modules/crossover/`: managed Sikarugir Wine versions, local CrossOver applications and Windows executable playback across game types.
- `src/modules/mv/`: RPG Maker MV module (shared MVMZ logic).
- `src/modules/mz/`: RPG Maker MZ module (shared MVMZ logic).
- `src/modules/renpy/`: Ren'Py module (SDK runtime + patching/builds).
- `src/modules/godot/`: Godot runtime downloads and source-project preparation. Source projects use application titles and PNG, WebP or self-contained SVG icons declared in `project.godot` or legacy `engine.cfg`; exported packs also supply declared titles and icons, including Windows-native ICO artwork. Ordinary metadata refresh preserves custom library titles and icons. Icon resources must remain within the project or pack. SVG artwork uses a bounded cached PNG conversion without changing the source; scripts and external resources are excluded. Godot 4 projects without an existing resource cache are imported automatically with the selected runtime in writable per-game storage. Original project files remain unchanged; completed imports are reused until source assets or the runtime version change. Embedded pack loading preserves executable-relative resource offsets.
- `src/modules/nscripter/`: NScripter module (Yuri and ONScripter-EN runtimes).
- `src/modules/java/`: Java jar module (runtime manager + Vineflower extraction flow).
- `src/modules/love/`: LÖVE module (managed releases/nightlies, native app support, AppImage staging).
- `src/modules/fna/`, `src/modules/unity/`: managed FNA/XNA hosting and exact-version Unity Mono player replacement.
- `src/modules/flash/`: Flash module (`.swf`) with managed universal Flash Player and Ruffle versions.
- `src/modules/construct/`: Construct module (packaged bundle extraction).
- `src/modules/tyrano/`: Tyrano module (packaged bundle extraction).
- `src/modules/web/`: generic web fallback module.
- `src/modules/gamemaker/`, `src/modules/gamemaker-html5/`: GameMaker tools, native runtimes and HTML5 exports.
- `src/modules/kirikiri/`, `src/modules/alicesoft/`: native VN interpreters.
- `src/modules/ai5/`, `src/modules/siglus/`, `src/modules/nitroplus/`: edition-specific native VN interpreters.
- `src/modules/vnds/`: converted VNDS exports hosted by LÖVE.
- `src/modules/catsystem2/`: archive/script tools; Windows playback uses Sikarugir or CrossOver.
- `src/modules/minori/`: native PAZ playback, original-PE key handling, private saves and script tools.
- `src/modules/bgi/`: BGI archive and program tools; Windows playback uses Sikarugir or CrossOver.
- `src/modules/fvp/`: FAVORITE/FVP detection, private game preparation and managed RFVP versions.
- `src/modules/mages/`: MAGES MPK/SC3 tools and the Windows HD Impacto runtime.
- `src/modules/gemrb/`, `src/modules/ikemen/`, `src/modules/hashlink/`: native adapters.
- `src/modules/haxe/`: inspection of compiled Windows [Haxe](https://haxe.org/) C++ builds; Windows playback uses Sikarugir or CrossOver.
- `src/modules/generic-app/`: macOS app, script and native executable fallback.
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
  Current module presentation metadata also applies to cached runtime state;
  grouping and labels preserve the original manager, section and version IDs.
- Settings and Runtimes use a searchable left sidebar for sections and runtime
  groups. Search matches full labels and runtime names while the current content
  stays open. Cmd-F focuses sidebar search; Up/Down, Home and End navigate its
  choices. Runtime sub-tabs remain inside the content panel. Explicit runtime
  navigation reveals the selected group, including links to a specific runtime.
  Searching and changing sections do not query remote catalogs.

## Launch flow (high level)
1. User picks a file/folder (including `.jar`, `.love`, and `.AppImage`) or drags it into the launcher.
2. Registry detects the module and returns a normalized record.
3. The main process merges and normalizes game records.
4. The renderer renders module-driven UI and settings.
5. On Play, an isolated Node worker calls the same backend used by `pnpm launch`; native runtimes spawn directly and hosted web games run in the standalone host. The main process publishes cached state while backend work continues.

## Module and source ownership

Module metadata, Node hooks and runtime contracts are defined in
[Modules](MODULES.md). Upstream checkouts under `src/external/` remain read-only;
module-owned overlays supply adaptations. Network acquisition belongs to explicit
user actions.
