# MacLauncher repo guide

MacLauncher is a macOS-first Electron launcher with a modular engine system. All engine-specific behavior lives under `src/modules/*` and the launcher discovers modules dynamically at runtime. There are no per-engine branches in the launcher code.

This guide is the entry point for project documentation. Use the links below for deep dives.

## Docs index
- `docs/MODULES.md`: module architecture, manifest contract, hooks, detection pipeline.
- `docs/UI_GUIDE.md`: full launcher UI walkthrough.
- `docs/UI_STYLES.md`: UI style tokens, button maps, and code locations.
- `docs/DATA_MODEL.md`: settings, recents, module data, storage paths.
- `docs/RUNTIMES.md`: runtime managers, pre-launch checks, runtime flow.
- `docs/cheats.md`: cheats architecture, patching, runtime behavior.
- `docs/DEVELOPMENT.md`: local dev commands and debug tips.

## Core principles
- Mac-first UX and conventions.
- Offline by default; network only on explicit user actions.
- Modular engine system; launcher code never branches on engine names.
- Launcher/runtime separation; module code owns runtime changes.

## Design decisions
- Deleting a game removes all of its userData (including any unpacked or staged assets stored outside the original game directory).
- Treat everything under `src/` (including the bundled MKXP-Z app) as bundled app data, not userData. New MKXP-Z versions download to userData, and version checks compare bundled and downloaded versions.

## Repo map
- `src/main/main.js`: Electron main process, IPC, settings, runtime orchestration.
- `src/modules/shared/`: shared code (cheats base, web runtime helpers, shared utilities).
- `src/modules/shared/web/preload/launcher.js`: launcher IPC bridge.
- `src/modules/shared/web/preload/game.js`: game preload and module runtime loader.
- `src/renderer/`: launcher UI (React).
- `src/modules/`: module registry and engine modules.
- `src/modules/rgss/`: RGSS (RPG Maker XP/VX/VX Ace) module and MKXP-Z runtime manager.
- `src/modules/mv/`: RPG Maker MV module (shared MVMZ logic).
- `src/modules/mz/`: RPG Maker MZ module (shared MVMZ logic).
- `src/modules/renpy/`: Ren'Py module (SDK runtime + patching/builds).
- `src/modules/godot/`: Godot module (runtime downloads).
- `src/modules/nscripter/`: NScripter module (Onscripter Yuri runtime).
- `src/modules/construct/`: Construct module (packaged bundle extraction).
- `src/modules/tyrano/`: Tyrano module (packaged bundle extraction).
- `src/modules/web/`: generic web fallback module.
- `docs/`: documentation.

## Architecture overview

### Module registry
`src/modules/registry.js`:
- Discovers modules under `src/modules/<id>/`.
- Treats `src/modules/shared/` as special and records its submodules for internal wiring.
- Loads runtime managers exported from `src/modules/shared/*/runtime/`.
- Calls module `detectGame` functions in order.
- Falls back to generic web detection when no module matches.
- Exposes module metadata to the launcher UI.

### Main process
`src/main/main.js`:
- Owns `settings.json` and recents list.
- Normalizes entries via module metadata and migrations.
- Launches games via hosted runtimes, runtime managers, or native runtimes.
- Exposes IPC endpoints to the renderer.

### Preloads
- Launcher preload exposes IPC APIs to the renderer.
- Game preload loads the module electron runtime and installs security controls.

### Renderer
`src/renderer/src/ui/App.tsx`:
- Renders the launcher UI using module manifests and state.
- Renders Settings and Runtimes modals from module metadata.

## Launch flow (high level)
1. User picks a file/folder or drags it into the launcher.
2. Registry detects the module and returns a normalized record.
3. The main process merges/normalizes recents and applies migrations.
4. The renderer renders module-driven UI and settings.
5. On play, the main process resolves a runtime and launches the game.

## Adding a new module
- Update docs alongside code changes.

## What not to do
- Do not add background network traffic.
- Do not edit `src/external/`; treat external clones as read-only.
