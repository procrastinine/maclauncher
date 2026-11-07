# Web runtimes: Electron and NW.js

HTML5 games run in one of two browser-based hosts: [Electron](https://github.com/electron/electron) and [NW.js](https://github.com/nwjs/nw.js). The same hosts serve every web game type:

| Game type | Runtimes |
| --- | --- |
| [RPG Maker MV and MZ](../game-types/RPGMAKER_MV_MZ.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |
| [Construct](../game-types/CONSTRUCT.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |
| [Tyrano](../game-types/TYRANO.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |
| [GameMaker HTML5](../game-types/GAMEMAKER_HTML5.md) | Electron (default), NW.js, Game's macOS app |
| [Web](../game-types/WEB.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |

The ONScripter-Yuri Web runtime for [NScripter](../game-types/NSCRIPTER.md#onscripter-yuri-web) also runs in an NW.js window.

Electron is included with MacLauncher, and NW.js versions are downloaded separately. **NW.js (Patched)** runs the same NW.js installation with MacLauncher's compatibility patches and the game type's optional patch settings. **Game's macOS app** launches a compatible macOS app supplied with the game. Each game type keeps its own default; RPG Maker MV and MZ [prefer NW.js (Patched)](../game-types/RPGMAKER_MV_MZ.md#runtimes) when a usable NW.js SDK is installed.

## Electron

The `electron` runtime runs the game in a standalone Electron game host, separate from the launcher window. On macOS the game's cached icon supplies the Dock label and icon.

The host keeps the game's original window behavior:

- Legacy NW.js fullscreen calls (enter, leave and toggle) control the game's own window.
- When a page has a single visible canvas and no visible text, media or controls outside it, the window is fitted to that canvas when it first opens. Pages with several visible canvases keep the host window size.
- Window dimensions declared in the game's `package.json` take precedence over automatic fitting.

Game files are served from a local loopback server. The server handles media byte ranges, HEAD requests, stream failures and safe asset paths. If the window cannot be set up, the host closes the server and removes the session's permissions. A host that keeps running after startup capture ends still writes its runtime diagnostics to the profile log.

A game type can declare a fallback runtime, which the launcher offers when the Electron host fails.

## NW.js

The `nwjs` runtime launches an installed NW.js version with a small wrapper. NW.js installations use the SDK variant.

### Versions

Play chooses the NW.js version in the [usual order](README.md#versions); the manager default prefers a ready compatible installed SDK, then a compatible stable catalog version. A missing recommended version or saved default uses the newest compatible local host before requesting a download; manual per-game versions stay exact. NW.js and NW.js (Patched) share these choices and use the same version for preparation, runtime status and launch. A game that uses Greenworks only considers hosts with a matching [bridge ABI](#greenworks).

Installing an NW.js version from **Runtimes** that is newer than the current default makes it the default, because newer NW.js versions run older games.

### Preparation and launch

NW.js projects link the original HTML, scripts and assets. The launcher writes its own small package manifest, injected runtime helpers and any selected native-library replacements under the game's runtime directory, without copying the complete game. Startup helpers and browser injections live in this private wrapper. Browser scripts run in the game window's context, and Node guards stay in the background context.

Before an NW.js installation is used, MacLauncher checks its extracted app bundle and installed framework aliases. A damaged installation stays visible in **Runtimes** but does not satisfy Play. After launch, both NW.js modes confirm that the native game window loaded the expected document, matching the wrapper, app origin and requested index page, before reporting success.

## Chromium in Wine

A web game can also keep its bundled Windows browser and run through [Sikarugir](SIKARUGIR.md). Older Chromium builds can share graphics resources through Windows APIs that the selected Wine engine does not provide. For a bundled NW.js application with no explicit graphics-backend arguments or external Wine environment, MacLauncher checks the browser, its ANGLE libraries and Wine's Vulkan bridge. Missing inspection data leaves the original choices unchanged; a declared `vkGetMemoryWin32HandleKHR` interface alone does not establish that resource sharing works.

When that interface is absent and the bundled browser supports the legacy ANGLE Direct3D 9 path, Play selects WineD3D for both Direct3D 8 and Direct3D 9. This requires matching Wine builtin libraries with executable `Direct3DCreate8` and `Direct3DCreate9` exports, because Direct3D 8 can depend on the same provider's Direct3D 9 library. An explicit choice for either API takes precedence. With WineD3D actually selected for Direct3D 9, the launch adds `--disable-d3d11`, so Chromium uses its bundled ANGLE Direct3D 9 implementation without DXVK's Windows shared-resource transport. The game files and saved translator choices stay unchanged.

An explicit browser backend argument in the launch arguments or `package.json` takes precedence, including `--use-angle`, `--use-gl`, `--use-vulkan` and `--disable-d3d11`. The automatic adaptation neither replaces these arguments nor disables GPU rendering or WebGL.

## NW.js (Patched)

The `nwjs-patched` runtime uses the same NW.js installations and adds MacLauncher's compatibility patches:

- **Enable case-insensitive assets** loads assets whose names differ only in case.
- **Enable user scripts** loads `*.maclauncher.js` and `*.maclauncher.mjs` files from the game root.
- Greenworks is injected automatically when the game files contain it.
- Game types load only engine-independent helpers unless they opt in to their own patches. RPG Maker MV and MZ offer Kawariki modules (remap, fixes and a variables inspector) and decrypted asset loaders; see [patched NW.js settings](../game-types/RPGMAKER_MV_MZ.md#nwjs-patched-settings).

## Greenworks

[Greenworks](https://github.com/greenheartgames/greenworks) is a native Node bridge that some NW.js games use for Steam integration. The Greenworks package, the NW.js host and the native Steamworks SDK libraries are separate inputs.

**Runtimes → NW.js → Greenworks** lists Greenworks releases from GitHub (`greenheartgames/greenworks`) and any imported native SDK libraries. Releases are keyed by the NW.js version they target and install under `userData/runtimes/greenworks/<nwjsVersion>/`. Bridge packages can be downloaded from **Runtimes** independently, but Play uses a bridge only in a supported combination of native dependencies:

| NW.js | Greenworks | Steamworks SDK | CPU and Steam API | Minimum macOS |
| --- | --- | --- | --- | --- |
| 0.103.1 | 0.22.0 | 1.63 | ARM64: included offline helper. Intel: native SDK API and Steam | 13.5 |

### Version pairing

Greenworks is paired with the game's exact NW.js version. A bridge default or a newer installed bridge never changes the game's NW.js selection. Explicit per-game and global NW.js versions take priority and must match an available bridge ABI; an explicit version without one reports the mismatch.

Without an explicit NW.js version, Play uses the newest installed host that has a listed compatible Greenworks ABI, or prepares a compatible pair when none is installed. SDK and ABI matching happens before Play asks to download anything. When both are missing, Play plans both downloads together, and declining either one leaves both installations unchanged. Refresh, installation and SDK import do not set a global host preference.

### Steam API routes

On the supported ARM64 pair, automatic mode uses the included offline Steam API and encrypted-ticket loader, so no SDK import is needed. The offline API is used by default even when official libraries have been imported. Its profile, `greenworks-0.22.0-nw0.103.1-sdk1.63-ml1-arm64-offline-abi0.5.0`, covers client initialization, the typed application ID, language and identity, and asynchronous delivery of stats callbacks. The separately versioned encrypted-ticket loader rejects ticket operations, so online services and encrypted-ticket decryption are unavailable. [Steam support](STEAM_API.md) describes helper versions and limits.

Intel has no offline route for this pair. It needs the official native API from an imported SDK and a running Steam client. Backend callers can select the imported official API instead of the offline helper with `context.runtimeSettings.steamApiMode = "native"`, which also requires a working native Steam client. Games without a detected Steam bridge do not need this setting.

Play checks the exact API route and application ID, then links the native libraries into a small private wrapper. The launcher's own environment is unchanged, and the native libraries are shared between games.

### Importing the Steamworks SDK

**Import Steamworks SDK 1.63…** in the Greenworks section accepts an authorized [Steamworks SDK](https://partner.steamgames.com/doc/sdk) folder, or a folder that contains its genuine native libraries. The import is needed for native mode and on Intel:

- Required: `libsdkencryptedappticket.dylib`, normally under `public/steam/lib/osx/`.
- Native API: `libsteam_api.dylib`, normally under `redistributable_bin/osx/`. The import checks it when it is present.

The import verifies exact file hashes, CPU slices, exports and signatures. It creates one shared registration under `userData/runtimes/greenworks-sdk/sdk-1.63-c3a1cd191b1e-7824c030a762/`, normally in `~/Library/Application Support/maclauncher/`. Importing again reuses healthy files, and adding the API library later updates the same registration. Headers, SDK source and compilers are not copied or needed. Valve's libraries keep their own terms and are not part of MacLauncher's packages.

## Settings

Electron and NW.js offer **Block child processes**. Game code can still `require("child_process")` for capability checks, but actual `spawn`, `exec` and `fork` calls are blocked. NW.js (Patched) adds the settings described above, and some game types add their own. The [settings reference](SETTINGS_REFERENCE.md) lists the settings for each game type.

The game's **Network access** choice applies to both browser and Node networking in Electron and NW.js, independently of child-process blocking. Allowing network access does not allow game-launched child processes. [Network isolation](NETWORK_ISOLATION.md) describes the policy.

## DevTools

Web runtimes include a DevTools keyboard shortcut: Cmd+Option+I on macOS (Cmd+Shift+I also works) and Ctrl+Shift+I on other platforms. NW.js runtimes open DevTools with `nw.Window.get().showDevTools()`; the Electron host asks the main process to open them.

- `MACLAUNCHER_DEVTOOLS=1` enables the shortcut in hosts that supply DevTools.
- `MACLAUNCHER_DEVTOOLS_AUTO=1` opens DevTools automatically on Electron launcher and game windows.

## Implementation

- The Electron UI and the command-line runner both hand launch dispatch to `src/core/launcher.js`. Native module hooks receive an injected process launcher and work under ordinary Node.
- Web games use `src/modules/shared/web/runtime/electron-host.js` with injected Electron APIs. `src/runtime/electron-game.js` initializes only that host. The hosted runtime loads the module's `electron.js` and `src/modules/shared/web/preload/game.js`.
- `manifest.runtime.hosted` declares the hosted runtime id, its optional `fallback` runtime and user-agent hints. Modules opt in to save-directory injection with `runtime.hosted.saveDirectory: true`, which keeps engine names out of launcher code.
- The NW.js runtimes use the module's launcher helper and the runtime manager's settings. A module opts in to the patched wrapper by listing `nwjs-patched`; engine-specific patches stay gated by the module.
- `greenworks-preparation.js`, `greenworks-sdk.js` and `nwjs-manager.js` in [the shared web runtime module](../../src/modules/shared/web/runtime) provide SDK import, compatibility checks and preparation without Electron. Steam API setup uses `context.prepareSteamApi` with the bridge's exact interface requirements. Detection and native validation cache their results until the source files change.
