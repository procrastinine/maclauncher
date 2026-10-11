# Runtime system

This doc explains how runtime selection, runtime managers, and pre-launch checks work.
For tools required by Build/Register workflows, [Native tool setup](NATIVE_TOOL_SETUP.md) lists download sources and install locations. Existing compatible runtime directories can be registered without rebuilding.

## Runtime types
Modules declare their runtime ids in `manifest.runtime.supported`. Most modules use the common set:
- `electron`: the game runs inside the standalone Electron game host (set by `manifest.runtime.hosted.id`).
- `nwjs`: the launcher runs a NW.js runtime with a wrapper.
- `nwjs-patched`: NW.js wrapper with a patch overlay (case-insensitive assets, user scripts, module-gated engine patches).
- `native`: a native app bundle or executable is launched directly.

Modules can also define custom runtime ids that map to module-specific launchers or managers, including:
- `mkxpz` (RGSS)
- `java` (Java)
- `love` (LÖVE)
- `projector` / `ruffle` (Flash)
- `onsyuri_mac` / `onscripter_en` / `onsyuri_web` / `external` (NScripter)
- `patched` / `sdk` (Ren'Py)
- `official-studio` / `butterscotch` / `opengmk` (GameMaker Studio and Classic backends; a game's own app uses `native`)
- `krkrsdl2`, `system3`, `xsystem35`, `xsystem4`, `ai5`, `siglus`, `npengine`, `impacto` (native VN interpreters)
- `vnds_love`, `fna`, `unity` (VNDS, portable managed games and exact-version Unity Mono)
- `gemrb`, `ikemen`, `hashlink` (native adapters)

## Runtime selection flow
1. Module detection populates `moduleId` and metadata.
2. `normalizeGameEntry` selects a runtime:
   - If the entry has a runtime override, use it when supported.
   - Otherwise use `settings.modules[<id>].defaultRuntime`, then the module's automatic preference or `manifest.runtime.default`.
3. If the requested runtime is not supported, fallback to the first supported runtime.
4. If a runtime is supported but unavailable (for example missing a native path), the module can reject it via `canLaunchRuntime`.

The CLI uses the same service but explicit `--runtime <id>` requests are strict: unsupported or unlaunchable requests fail instead of selecting another runtime. The shared entry point is documented in [BACKEND.md](../BACKEND.md).

RPG Maker MV and MZ automatically prefer **NW.js (Patched)** when a usable NW.js SDK is installed, and use Electron otherwise. Existing game selections and explicit module defaults remain unchanged. Other HTML game types retain their own defaults. This host preference preserves the selected NW.js version and patch options.

## Hosted runtime boundary
The Electron UI and command-line runner both delegate launch dispatch to `src/core/launcher.js`.
Native module hooks receive an injected process launcher and work under ordinary Node.
Web games use `src/modules/shared/web/runtime/electron-host.js` with injected Electron APIs;
`src/runtime/electron-game.js` initializes only that host. MV/MZ manifests opt into save-directory
injection with `runtime.hosted.saveDirectory: true`, keeping engine names out of launcher branches.
Construct and Tyrano reuse the shared legacy NW.js window facade in their Electron adapters;
browser scripts retain their global libraries instead of taking unintended CommonJS paths.
Legacy enter, leave and toggle fullscreen calls control the owning game window through host IPC.
Tyrano's Electron file-save API writes its original escaped JSON format to per-game storage,
so the runner executable directory is not used for saves.
The loopback static server handles media byte ranges, HEAD, stream failures and safe asset paths.
Failed window setup closes its server and removes session permissions.
Detached hosts retain their runtime diagnostics in the profile log after startup capture ends.

Construct Windows exports may keep the game in a separate `package.nw` beside a renamed
NW.js executable. Direct executable imports verify bounded PE version metadata identifying
the NW.js carrier and independently verify the Construct package before preparing it for Play.
Unrelated executables do not inherit neighboring game files.
Generic Web executable imports also require NW.js or Electron PE identity and a contained,
unpacked app package with a real entry and HTML export. An adjacent HTML file by itself
does not identify an arbitrary executable as a web game.
MV/MZ labels use the contained `data/System.json` game title when available. Author titles
and useful folder names are preserved when the bundled executable has a generic name such as
`Game.exe`; metadata changes participate in the normal source-cache refresh.

## Runtime managers
Runtime managers provide:
- A list of included and installed versions
- A remote catalog for downloads
- Default runtime settings
- Install/uninstall actions
- A shared download manager entry for tracking concurrent downloads and cancellations

Play resolves the compatible runtime before launching. When it is missing, the UI asks whether
to download it, installs the selected version, and continues launching. A matching installation
does not trigger a catalog refresh or another download. Preparation then runs through the same
Node backend used by the command-line launcher, without extra setup steps in the inspector.
Ordinary game launches leave the global runtime defaults unchanged; explicit installation and
default-selection actions in Runtimes retain their existing behavior.

Optional decompilation actions use the same download-and-continue flow. Shared
[ILSpy](https://github.com/icsharpcode/ILSpy) versions appear under **Runtimes → ILSpy**;
explicit NuGet refresh supplies framework and checksum metadata. Tool choices apply
to FNA and Unity exports without changing their game runtimes. Compatible .NET hosts
are shared between tool versions and acquired automatically when needed.

Pinned immutable bundles run directly from app resources and show **Included** without
Install or Remove. Writable hosts prepare a private runtime copy automatically; required
downloads retain their selected manager/version and bounded progress when supplied.
Preparation and process startup show Starting; Stop is available
once the native process exists.

Modules can provide `ensureRuntime(entry, context)` to reuse their existing version selectors.
It returns `null` when the selected runtime is included or installed, or an exact
`{ managerId, version, installOptions }` plan for the shared installer. Godot uses the detected
version/major and per-game override, Java uses the required LTS line and its existing architecture
fallback, LÖVE uses its stable/nightly selector, and Flash uses Ruffle's override/default/installed
precedence. Catalog lookup happens only during explicit Play when required to identify the version;
native-app choices remain local. Flash Player uses the included universal player.

Runtime managers are declared by modules via `runtimeManagers` and are deduped by id.
Shared submodules can also expose runtime managers by exporting manager objects from
`src/modules/shared/<submodule>/runtime/*.js`.

`runtime.managerUi[managerId].management` declares `managed` for usable download or
automated build flows and `built-in` for fixed runtime profiles. Runtimes tabs and
inspector management links honor this metadata; engine Settings, per-game runtime
options, explicit versions and backend actions remain available. Included fallbacks
do not change this classification. Mixed managers can declare `sectionManagement`,
for example native `mac: "built-in"` and downloadable `web: "managed"`.

### Versioned native managers

The shared pinned-native manager exposes finite pinned versions without startup network calls. Downloads have pinned hashes; records include executable SHA-256, revision, architecture and provenance. Build actions verify clean revisions, stage tracked source separately, apply module overlays, and record tree/overlay hashes. Manual registration records the supplied source identity and executable checksum.

Explicit versions never silently switch to unrelated builds. Missing/incompatible choices fail with concrete status. Corrupt/incomplete owned records remain visible with **Needs repair** and Uninstall; included resources cannot be removed independently. Catalogs declare `installable`, optional `installableVersions`, `installLabel`, `installReason` and included-version metadata. Source-only backends offer **Build** when their inputs are available; pinned immutable binaries show **Included** and execute without copies or compilers. Existing exact registrations retain priority. [Distribution](RUNTIME_DISTRIBUTION.md) lists the execution policy of each backend.

The inspector records game engine and bytecode versions with their source and confidence. Runtime selection uses the module’s format and version requirements. See the [engine compatibility guide](../README.md#engine-compatibility) and engine references for supported formats and architectures.

### MKXP-Z (RGSS)
The RGSS module registers the `mkxpz` runtime manager:
- Remote catalog uses the GitHub CLI (`gh`) against `mkxp-z/mkxp-z` Actions autobuilds.
- Runtime refresh defaults to the most recent build; use "All versions..." to load the full list.
- The default binary is included and works without `gh`, authentication or network access.
- Additional Actions builds remain installable through authenticated `gh` (`gh auth status`); an unavailable selected build fails without switching versions.
- Bundled binary resources: `native-runtimes/mkxpz/<version>/<arch>/`; no source checkout is required.
- Install destination: `userData/runtimes/mkxpz/<version>/`.
- Every Play uses the same shared executable/frameworks and a tiny private session config; the included config helper redirects only its config-directory lookup. Original games and runtime apps are not copied per game. See [MKXP-Z config isolation](MKXPZ.md).

### Ren'Py
The Ren'Py module registers the `sdk` runtime manager:
- Two sections: Ren'Py (Python 2) for Ren'Py 7 and earlier, and Ren'Py 8 (selected by `entry.moduleData.major`).
- Remote catalog uses `https://www.renpy.org/dl/` plus latest-stable hints from `https://renpy.org/latest.html` and `https://renpy.org/latest-7.html`.
- Install downloads the SDK DMG and mounts it via `hdiutil`, then copies with `ditto`.
- On macOS, new SDK installs also launch the copied `Ren'Py.app` once in the background and quit it after a short delay so the SDK is ready for later `renpy.sh` launches.
- Install destination: `userData/runtimes/sdk/<major>/<version>/`.
- Per-game overrides live under `runtimeData.sdk.version` for the SDK runtime.

Ren'Py patching uses a separate SDK zip download (`renpy-<version>-sdk.zip`) when the user runs the Patch action.
This is not stored under `userData/runtimes/sdk/`; it is a temporary download used to stage macOS runtime files into the game.

### Temurin + Vineflower

The Java module registers the `java` runtime manager, shown as **Temurin** for [Eclipse Temurin](https://adoptium.net/):
- Sections: `8`, `11`, `17`, `21`, `25`, plus `vineflower`.
- Java catalog source: Adoptium API (`/v3/assets/feature_releases/<line>/ga`) using JDK assets.
- Java install destination: `userData/runtimes/java/<line>/<version>/<variant>/`.
- On Apple Silicon, installs prefer `arm64`; if unavailable, `x64` is selected with Rosetta fallback.
- If one architecture catalog endpoint returns no assets (for example Java 8 `aarch64`), that variant is treated as unavailable and the manager still uses other available variants.
- Variant controls are availability-driven per Java line; if only one variant is valid (for example Java 8 on Apple Silicon), the UI uses that variant directly.
- Explicit runtime-manager installation updates that line's default version/variant. An automatic game-specific JNI prerequisite preserves global defaults.
- Java 8 may require Rosetta on Apple Silicon; status checks surface this explicitly.
- Vineflower catalog source: GitHub releases (`Vineflower/vineflower`).
- Vineflower install destination: `userData/runtimes/vineflower/<version>/vineflower.jar`.

Reload replaces the selected section's version list. A failed lookup keeps the last valid versions, install metadata and selected default; an immediate retry is available. Only successful lookups are reused for the six-hour catalog cache, and reading runtime state makes no network requests.

**Extract** confirms any missing [Vineflower](https://github.com/Vineflower/vineflower) or Java download, installs it automatically, then continues. Selected tool versions remain exact; the tool's class version selects a compatible Java host. Installed tools and hosts are reused offline.

Play selects a compatible Java line from the original JAR. Ordinary games reuse an installed patch on that line when the preferred default patch is missing; an explicit per-game version remains exact. Pinned JNI consumers additionally enforce their selected version and required JVM CPU.

Positive Steam consumers use an exact [Java JNI bridge](JAVA_STEAM.md) automatically. The original wrapper classes select the matching Included JNI; Intel-only wrappers use an Intel JVM/Rosetta. The owned loader preserves the original JAR and separates game state without copying its JRE.

### Godot
The Godot module registers the `godot` runtime manager:
- Remote catalog parses `https://godotengine.org/download/archive/`.
- Reload loads the complete bounded archive list, including stable and development variants.
- Install downloads the macOS .NET zip from the archive detail page and extracts the `.app`.
- Install destination: `userData/runtimes/godot/<version>/mono/`.
- The same runtime panel includes a GDRE Tools section that downloads macOS zips from
  `https://github.com/GDRETools/gdsdecomp/releases` and installs to
  `userData/runtimes/gdsdecomp/<version>/`.

Godot extraction, version detection and script/resource tools confirm a missing [GDRE Tools](https://github.com/GDRETools/gdsdecomp) download and resume automatically after installation. The selected GDRE version is preserved; Reload only checks local status.

Per-game Godot runtime overrides default to the detected engine version (from PCK headers or project configs).
Detected base versions are resolved against the archive catalog on install (for example, `3.4.1` maps to the
latest `3.4.1-*` slug when available). If only a major version is detected, the launcher picks the latest
available version for that major. Play plans that compatible archive version before the shared
download prompt, so another major's global default is not installed first. An installed `x.y` slug
also satisfies detected `x.y.0` through the existing version-bucket rules. Missing exact release
buckets fail with the requested version instead of switching to another release. A full bounded
archive lookup runs when needed, so manual refresh is not required.

### LÖVE
The LÖVE module registers the `love` runtime manager:
- Sections: `Releases` and `Nightlies`.
- Stable catalog source: GitHub releases from `love2d/love`.
- Nightly catalog/install source: GitHub Actions artifacts from `love2d/love` main-branch workflow via `gh`.
- Stable install destination: `userData/runtimes/love/stable/<version>/`.
- Nightly install destination: `userData/runtimes/love/nightly/<buildKey>/`.
- Nightly installs require the GitHub CLI and authentication; the Runtimes view shows a notice when that section is selected.
- Per-game overrides live under `runtimeData.love.channel` and `runtimeData.love.version`.
- Imported LÖVE app bundles can switch to the module's `native` runtime; packaged `.love`, fused executables, packaged Linux builds, and extracted AppImages use the managed `love` runtime.
- Older x64-only macOS builds are marked `needsRosetta` on Apple Silicon and launch through the shared detached spawn path with Rosetta enabled.
- Installed bundle checks reject broken framework aliases; app copies keep aliases contained after temporary extraction is removed.
- Play reuses installed releases or nightlies matching the detected bundle version. Unreleased
  detected versions retain the existing nightly fallback; explicit release choices do not switch
  channels. A saved nightly build reloads its exact artifact metadata when needed, while an
  unselected latest build uses the bounded latest-artifact lookup.

### Ruffle + Flash Player
Flash games offer the included Adobe Flash Player (`projector`) and managed [Ruffle](https://github.com/ruffle-rs/ruffle) (`ruffle`). The inspector shows the player version; **Runtimes → Ruffle** manages Ruffle releases.

Flash Player:
- The included 35.0.0.60 projector runs directly from MacLauncher's app resources on Apple Silicon and Intel. Play needs no download, installation, Rosetta or per-game player copy.
- This fixed player is reported in Settings and the inspector, with no runtime-management tab. A missing or invalid player requires repairing the MacLauncher app.
- The player originated from [Adobe Animate](https://www.adobe.com/products/animate.html) and retains Adobe and its licensors' copyright notices and vendor terms.

Ruffle:
- Remote catalog uses GitHub releases from `ruffle-rs/ruffle` (nightly/prerelease builds, macOS assets only).
- Reload and the on-demand first-install lookup load bounded ordinary release history rather than
  leaving the catalog with a single release.
- Install destination: `userData/runtimes/ruffle/<version>/`.
- Per-game runtime overrides for Ruffle live under `runtimeData.ruffle.version`.
- Managed app launches track the bundle executable directly so Stop terminates the game process. The upstream app's sandbox and ordinary file-access prompts remain active.

### NW.js (Greenworks section)
The NW.js runtime manager includes a Greenworks section for Steamworks support:
- Remote catalog uses GitHub releases from `greenheartgames/greenworks`.
- Versions are keyed by the NW.js version they target.
- Install destination: `userData/runtimes/greenworks/<nwjsVersion>/`.
- Play pairs Greenworks with the exact selected NW.js version. A bridge default or a newer installed
  bridge cannot change a game's NW.js selection. Both missing packages join the same download-consent plan.
- The pinned `Greenworks 0.22.0 / NW.js 0.103.1` native contract requires its genuine SDK 1.63 encrypted-ticket library.
  Use **Import Steamworks SDK 1.63…** in this section to select an authorized SDK or its native-library folder.
  That input is registered once under `userData/runtimes/greenworks-sdk/`; the optional official API is checked when provided.
  The supported ARM64 pair automatically uses the included offline API helper. Intel requires the official native API and Steam.
  No headers or compiler are copied.
- Missing or unsupported SDK/ABI dependencies fail before Play asks to download a host or bridge.
  Direct Runtimes downloads install the bridge package independently. See [Greenworks](GREENWORKS.md).

### NW.js (Patched)
The `nwjs-patched` runtime shares the NW.js manager installs but adds a patch overlay:
- Case-insensitive asset loader and offline guards are available via runtime settings.
- MV/MZ can opt into Kawariki modules (remap/fixes/vars) and decrypted asset loaders.
- Other modules only load engine-agnostic helpers unless they explicitly opt in.
- Greenworks is injected automatically when detected in the game files.
- User scripts load from `*.maclauncher.js` and `*.maclauncher.mjs` in the game root when enabled.

NW.js installs always use the SDK variant (no runtime variant toggle); the manager defaults to `0.107.0`.
Extracted app bundles and installed framework aliases are checked before use; damaged installs remain visible and do not satisfy Play preparation.
Both launch modes verify the native game window's loaded document before reporting
success, matching the wrapper, app origin and requested index. Startup helpers and
browser injections live in the private wrapper;
browser scripts retain the game window's context, while Node guards stay in the
background context. Original game assets remain linked to their source.

### ONScripter-Yuri Web (NScripter)

Native **ONScripter-Yuri (Included)** (`0.7.7beta-macos-v3`) and **ONScripter-EN (Included)** (`2025-06-08-mac-v2`) are included players with contained dependencies. Ordinary Play needs no installation or Homebrew setup. Yuri's native profile requires Apple Silicon and macOS 13; exact versions and format limits are described in [NSCRIPTER.md](NSCRIPTER.md).

**Runtimes → NScripter → ONScripter-Yuri Web** manages web releases from [`YuriSizuku/OnscripterYuri`](https://github.com/YuriSizuku/OnscripterYuri). Reload queries upstream; opening the tab stays offline. Play prepares missing web and NW.js host downloads after consent. Downloads extract to `userData/runtimes/onsyuri/web/<version>/` and require `onsyuri.html` or `index.html` in the install root or a contained subfolder. Native-player options remain in Settings and the inspector.

### Python tooling (evbunpack)
Python and evbunpack are included internal extraction tools, without runtime choices or download prompts. Backend resolution uses an existing managed venv at `userData/runtimes/python/evbunpack/venv/` when present, then the embedded runtime at `src/resources/python/`. Source environments can also resolve `PYTHON3`, `PYTHON` or `python3` on PATH.
- Dependencies are expected to be present (`aplib`, `pefile`, `corrupy`).

### Manager interface
Opening Runtimes or changing tabs reads local state. **Reload** queries the selected upstream catalog; **All versions**, where available, explicitly requests its broader history. Successful queries replace and deduplicate available releases. A failed query keeps the last valid list and existing selections. Included and installed versions retain their exact identities independently of that list. Missing runtimes can still be acquired automatically after consent on Play or a tool action.

Each manager can export:
- `id` and `label`
- `normalizeSettings(settings)`
- `applySettingsUpdate(action, payload, settings)`
- `refreshCatalog({ logger, force, latestOnly?, sectionId? })`
- `getState({ settings, userDataDir })`
- `installRuntime({ userDataDir, version, variant?, logger, onProgress, downloads })`
- `uninstallRuntime({ userDataDir, version, platformKey, variant?, installDir? })`
- `updateSettingsAfterInstall(settings, installed)`
- `updateSettingsAfterUninstall(settings, payload, context)`

`getState` should return:
- `installed`: list of installed runtimes
- `catalog`: catalog state and versions
- `sections`: optional section list for the Runtimes view
- `notice`: optional callout data (title + lines) surfaced in the Runtimes view

### Concurrent runtime use

The shared Node coordinator serializes installs, imports, setup and installed library
actions that can mutate the same artifact. Installers waiting on another worker reuse
a ready exact version. Setup and imports with unknown targets cover their manager
during inspection. Active game leases prevent changing or removing a
runtime still in use; uninstall resolves its directory from the manager's installed
rows and protects Included resources.

Lease identity comes from the module's actual selection, not its manager's defaults.
For a private runtime context, report the shared source before staging with
`await context.useRuntime({ managerId, version, sourcePath })`; include `sectionId`
and `variant` when needed.
The checked spawn adapter also matches the actual executable and file arguments to
declared primary/prerequisite runtime artifacts. Settings commits merge changed fields
through one host writer; downloads and independent managers stay in separate lanes.
Module actions modifying shared assets use
`context.withRuntimeMutation({ managerId }, async () => { ... })`, covering all versions.
See [backend coordination](../BACKEND.md#shared-runtime-coordination) for Node injection
and process lifetime details.

## Runtime manager UI
The Runtimes view uses manager state to render:
- Manager tabs (one per manager)
- Section tabs for multiple managed groups, such as Temurin LTS + Vineflower, NW.js + Greenworks, or Ren'Py (Python 2)/Ren'Py 8; fixed native players remain in Settings.
- Remote versions (with refresh)
- Installed versions and uninstall actions
- Default version selection (and variant when supported)
- Download manager dropdown (active downloads with cancel controls; supports multiple concurrent downloads)

## Per-game runtime overrides
Per-game overrides live under `games/<gameId>/game.json` -> `runtimeData[<runtimeId>]`:
- `version` (string or null)
- `variant` (string or null, only for runtimes that support variants)
- Manager-specific extra keys (for example `runtimeData.java.line`)
  - Per-module UI exposure for section overrides is declared by `manifest.runtime.managerSectionOverrideKey`.

The UI exposes these overrides when the selected runtime maps to a manager.
LÖVE additionally uses `runtimeData.love.channel` to switch between the `Releases` and `Nightlies` manager sections.

## Runtime settings
Runtime settings are separate from runtime managers and installs.

Sources (most specific wins):
- Global defaults: `userData/runtimes/<runtimeId>/settings.json`
- Game type defaults: `settings.modules[<moduleId>].runtimeSettings[<runtimeId>]`
- Per-game overrides: `games/<gameId>/game.json` -> `runtimeSettings[<runtimeId>]`

Runtime settings are edited from:
- Settings view (per game type)
- Runtime settings button next to the per-game runtime selector

Edits are saved automatically when fields change.

The Runtimes view only exposes runtime managers and downloads.

## Pre-launch checks
Modules can define pre-launch checks per runtime:
- `manifest.runtime.preLaunch[<runtimeId>]`
- `statusAction` is invoked to inspect readiness
- `readyWhen` lists conditions that must be met
- `fixAction` is invoked when the user accepts the prompt
- `declineAction` is invoked when the user declines the prompt (optional)

This allows modules to require patching or setup before launch.

## Launch integration
- Hosted runtime uses `electron.js` in the module and `src/modules/shared/web/preload/game.js`.
- `manifest.runtime.hosted.fallback` can declare a runtime id offered when the hosted runtime fails.
- NW.js runtime uses the module's launcher helper and runtime manager settings.
- Native runtime uses `nativeAppPath` or module-specific resolution.
- Module `launchRuntime` handlers are used for custom runtimes such as Java (`java`), Ren'Py (`sdk`/`patched`), and NScripter (`onsyuri_*`).
- On macOS, hosted Electron launches set the Dock label and icon from the game's cached icon.

## DevTools access
Web runtimes install a DevTools keybinding helper:
- macOS: Cmd+Option+I (Cmd+Shift+I also works)
- Other platforms: Ctrl+Shift+I
NW.js runtimes call `nw.Window.get().showDevTools()`, while hosted Electron runtimes ask the main process to open DevTools.
Set `MACLAUNCHER_DEVTOOLS=1` to force-enable the shortcut in supported runtimes. Use
`MACLAUNCHER_DEVTOOLS_AUTO=1` to auto-open DevTools on Electron launcher and game windows.

## Offline protections
The runtime setting labeled "Enable protections" controls offline mode for supported runtimes:
- Electron uses request blocking plus Node module guards in the game preload.
- Electron allows `require("child_process")` for capability checks, but blocks actual `spawn`/`exec`/`fork` calls while protections are enabled.
- NW.js uses injected runtime guards to block browser networking and adds
  Chromium flags (background network disables plus a loopback proxy) to suppress outbound traffic.
  Node-level guards still block `http`/`https`/`net`/`tls` modules in the background script.
- NW.js also blocks `child_process` execution methods while protections are enabled, but keeps plain `require("child_process")` imports working for games that only probe for NW.js support at startup.

## Network policy
Runtime catalogs and installs are the only built-in network operations.
These actions are always user-initiated from the Runtimes view (or explicit module actions such as patch/download).
The download manager surfaces in-progress transfers and allows canceling without blocking offline actions.
