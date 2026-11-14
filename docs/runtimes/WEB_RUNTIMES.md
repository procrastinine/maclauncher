# Web runtimes: Electron and NW.js

MacLauncher runs HTML5 games in one of two browser-based runtimes, [Electron](https://github.com/electron/electron) and [NW.js](https://github.com/nwjs/nw.js), and every web game type chooses among the same options:

| Game type | Runtimes |
| --- | --- |
| [RPG Maker MV and MZ](../game-types/RPGMAKER_MV_MZ.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |
| [Construct](../game-types/CONSTRUCT.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |
| [Tyrano](../game-types/TYRANO.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |
| [GameMaker HTML5](../game-types/GAMEMAKER_HTML5.md) | Electron (default), NW.js, Game's macOS app |
| [Web](../game-types/WEB.md) | Electron (default), NW.js, NW.js (Patched), Game's macOS app |

The ONScripter-Yuri Web runtime for [NScripter](../game-types/NSCRIPTER.md#onscripter-yuri-web) also runs in an NW.js window.

Electron is included with MacLauncher, while NW.js versions are downloaded separately. **NW.js (Patched)** runs the same NW.js installation with MacLauncher's compatibility patches and the game type's optional patch settings. **Game's macOS app** launches a compatible macOS app supplied with the game. Each game type has its own default, and RPG Maker MV and MZ [prefer NW.js (Patched)](../game-types/RPGMAKER_MV_MZ.md#runtimes) when a usable NW.js SDK is installed.

## Electron

The `electron` runtime runs the game in a standalone Electron game host, separate from the launcher window. On macOS, the Dock label and icon come from the game's cached icon.

The host keeps the game's original window behavior:

- Legacy NW.js fullscreen calls (enter, leave and toggle) control the game's own window.
- When a page has a single visible canvas and no visible text, media or controls outside it, the window is fitted to that canvas when it first opens. Pages with several visible canvases keep the host window size.
- Window dimensions declared in the game's `package.json` take precedence over automatic fitting.

The host serves game files from a local loopback server, which handles media byte ranges, HEAD requests, stream failures and safe asset paths. If the window cannot be set up, the host closes the server and removes the session's permissions. A host that keeps running after the launcher stops capturing its startup output still writes its runtime diagnostics to the profile log.

A game type can declare a fallback runtime, which the launcher offers when the Electron host fails.

## NW.js

The `nwjs` runtime launches an installed NW.js version through a small wrapper. MacLauncher installs the SDK variant of NW.js.

### Versions

Play chooses the NW.js version in the [usual order](README.md#versions). The default set in **Runtimes** prefers a ready, compatible installed SDK, then a compatible stable version from the catalog. When the recommended version or the saved default is not installed, Play uses the newest compatible installed NW.js before asking for a download, while a version chosen by hand for one game is used exactly. NW.js and NW.js (Patched) share these choices and use the same version for preparation, runtime status and launch. A game that uses Greenworks considers only NW.js versions with a matching [Greenworks ABI](#greenworks).

Installing an NW.js version from **Runtimes** that is newer than the current default makes it the default, because newer NW.js versions run older games.

### Preparation and launch

For an NW.js game, MacLauncher prepares a private wrapper under the game's runtime directory. The wrapper links to the original HTML, scripts and assets, so the complete game is never copied. It holds MacLauncher's own small package manifest, the runtime helpers that MacLauncher injects (startup helpers and browser injections among them) and any selected native-library replacements. Browser scripts run in the game window's context, and Node guards stay in the background context.

Before an NW.js installation is used, MacLauncher checks its extracted app bundle and installed framework aliases. A damaged installation stays visible in **Runtimes**, but Play does not use it. After launch, both NW.js runtimes report success only once the native game window has loaded the expected document, with the wrapper, the app origin and the requested index page all matching.

## Chromium in Wine

A web game can also keep its bundled Windows browser and run through [Sikarugir](SIKARUGIR.md). Older Chromium builds can share graphics resources through Windows APIs that the selected Wine engine does not provide, so MacLauncher inspects the browser, its ANGLE libraries and Wine's Vulkan bridge. It does so for a bundled NW.js application that has no explicit graphics-backend arguments and does not use an existing Wine environment. When inspection data is missing, the original choices stay unchanged. A declared `vkGetMemoryWin32HandleKHR` interface alone does not show that resource sharing works.

When that interface is absent and the bundled browser supports the legacy ANGLE Direct3D 9 path, Play selects WineD3D for both Direct3D 8 and Direct3D 9. This needs matching Wine builtin libraries with executable `Direct3DCreate8` and `Direct3DCreate9` exports, because Direct3D 8 can depend on the Direct3D 9 library of the same translator. An explicit choice for either API takes precedence. Once WineD3D is actually selected for Direct3D 9, the launch adds `--disable-d3d11`, so Chromium uses its bundled ANGLE Direct3D 9 implementation and does not rely on DXVK to share Windows resources. The game files and saved translator choices stay unchanged.

A browser backend argument given explicitly in the launch arguments or in `package.json` takes precedence, including `--use-angle`, `--use-gl`, `--use-vulkan` and `--disable-d3d11`. The automatic adjustment never replaces these arguments, and it never disables GPU rendering or WebGL.

## NW.js (Patched)

The `nwjs-patched` runtime uses the same NW.js installations and adds MacLauncher's compatibility patches:

- **Enable case-insensitive assets** loads assets whose names differ only in case.
- **Enable user scripts** loads `*.maclauncher.js` and `*.maclauncher.mjs` files from the game root.
- Greenworks is injected automatically when the game files contain it.
- A game type loads only helpers that work with any engine, unless it enables patches of its own. RPG Maker MV and MZ offer Kawariki modules (remap, fixes and a variables inspector) and decrypted asset loaders; see [patched NW.js settings](../game-types/RPGMAKER_MV_MZ.md#nwjs-patched-settings).

## Greenworks

[Greenworks](https://github.com/greenheartgames/greenworks) is a native Node bridge that some NW.js games use for Steam integration. MacLauncher installs the Greenworks package, NW.js and the native Steamworks SDK libraries separately.

**Runtimes → NW.js → Greenworks** lists Greenworks releases from GitHub (`greenheartgames/greenworks`) and any imported native SDK libraries. Each release is identified by the NW.js version it targets and installs under `userData/runtimes/greenworks/<nwjsVersion>/`. Greenworks packages can be downloaded from **Runtimes** on their own, but Play uses one only in a supported combination of native dependencies:

| NW.js | Greenworks | Steamworks SDK | CPU and Steam API | Minimum macOS |
| --- | --- | --- | --- | --- |
| 0.103.1 | 0.22.0 | 1.63 | ARM64: included offline helper. Intel: native SDK API and Steam | 13.5 |

### Version pairing

Greenworks is paired with the game's exact NW.js version, so neither a default Greenworks version nor a newer installed one ever changes which NW.js the game uses. NW.js versions chosen explicitly, for one game or globally, take priority and must match an available Greenworks ABI; when none matches, Play reports the mismatch.

Without an explicit NW.js version, Play uses the newest installed NW.js that has a compatible Greenworks ABI in the list, or prepares a compatible pair when none is installed. The SDK and ABI are matched before Play asks to download anything. When both NW.js and Greenworks are missing, Play plans the two downloads together, and declining either one leaves both installations unchanged. Refresh, installation and SDK import never set a global NW.js preference.

### Steam API modes

On the supported ARM64 combination, automatic mode uses the included offline Steam API and encrypted-ticket loader, so no SDK import is needed. The offline API remains the default even when official libraries have been imported. Its profile, `greenworks-0.22.0-nw0.103.1-sdk1.63-ml1-arm64-offline-abi0.5.0`, covers client initialization, the typed application ID, the language, local application information and asynchronous delivery of stats callbacks. The encrypted-ticket loader has its own version number and rejects ticket operations, so online services and encrypted-ticket decryption are unavailable. [Steam support](STEAM_API.md) describes the helper versions and their limits.

On Intel, this combination has no offline mode. It needs the official native API from an imported SDK together with a running Steam client. Backend code can select the imported official API instead of the offline helper with `context.runtimeSettings.steamApiMode = "native"`, which likewise requires a working native Steam client. Games in which no Steam bridge is detected do not need this setting.

Play checks the exact Steam API selection and the application ID, then links the native libraries into a small private wrapper. The launcher's own environment is unchanged, and the native libraries are shared between games.

### Importing the Steamworks SDK

**Import Steamworks SDK 1.63…** in the Greenworks section accepts an authorized [Steamworks SDK](https://partner.steamgames.com/doc/sdk) folder, or a folder that contains its genuine native libraries. Native mode and Intel Macs need the import:

- Required: `libsdkencryptedappticket.dylib`, normally under `public/steam/lib/osx/`.
- Native API: `libsteam_api.dylib`, normally under `redistributable_bin/osx/`. The import checks it when it is present.

The import verifies exact file hashes, CPU slices, exports and signatures, then creates one shared registration under `userData/runtimes/greenworks-sdk/sdk-1.63-c3a1cd191b1e-7824c030a762/`, normally in `~/Library/Application Support/maclauncher/`. Importing again reuses intact files, and adding the API library later updates the same registration. Headers, SDK source and compilers are neither copied nor needed. Valve's libraries keep their own terms and are not part of MacLauncher's packages.

## Settings

Electron and NW.js both offer **Block child processes**. With it on, game code can still `require("child_process")` to check for the capability, but its actual `spawn`, `exec` and `fork` calls are blocked. NW.js (Patched) adds the settings described above, and some game types add their own. The [settings reference](SETTINGS_REFERENCE.md) lists the settings for each game type.

The game's **Network access** choice applies to both browser and Node networking in Electron and NW.js, independently of child-process blocking: allowing network access does not allow child processes that the game starts. [Network isolation](NETWORK_ISOLATION.md) describes the policy.

## DevTools

The web runtimes have a DevTools keyboard shortcut: Cmd+Option+I on macOS (Cmd+Shift+I also works) and Ctrl+Shift+I on other platforms. NW.js runtimes open DevTools with `nw.Window.get().showDevTools()`, and the Electron host asks the main process to open them.

- `MACLAUNCHER_DEVTOOLS=1` enables the shortcut in hosts that supply DevTools.
- `MACLAUNCHER_DEVTOOLS_AUTO=1` opens DevTools automatically on Electron launcher and game windows.

## Implementation

- The Electron UI and the command-line runner both pass launches to `src/core/launcher.js`. Native module hooks receive an injected process launcher, so they also work under ordinary Node.
- Web games use `src/modules/shared/web/runtime/electron-host.js` with injected Electron APIs, and `src/runtime/electron-game.js` initializes only that host. The hosted runtime loads the module's `electron.js` and `src/modules/shared/web/preload/game.js`.
- `manifest.runtime.hosted` declares the hosted runtime id, its optional `fallback` runtime and user-agent hints. A module turns on save-directory injection with `runtime.hosted.saveDirectory: true`, which keeps engine names out of launcher code.
- The NW.js runtimes use the module's launcher helper and the runtime manager's settings. A module enables the patched wrapper by listing `nwjs-patched`, and the module itself decides when its engine-specific patches apply.
- `greenworks-preparation.js`, `greenworks-sdk.js` and `nwjs-manager.js` in [the shared web runtime module](../../src/modules/shared/web/runtime) provide SDK import, compatibility checks and preparation without Electron. Steam API setup calls `context.prepareSteamApi` with the bridge's exact interface requirements. Detection and native validation cache their results until the source files change.
