# Runtime system

MacLauncher selects, installs and launches game runtimes through a shared module
contract. The [runtime guides](README.md) describe playback and settings by game
type; this reference covers selection, catalogs and manager APIs. [Native tool
setup](NATIVE_TOOL_SETUP.md) describes package sources, system components and
managed tools; the [settings reference](SETTINGS_REFERENCE.md) lists every runtime
setting and inspector action.

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
- `rfvp` (managed FAVORITE/FVP interpreter; [formats and versions](FVP.md))
- `vnds_love`, `fna`, `unity` (VNDS, portable managed games and exact-version Unity Mono)
- `gemrb`, `ikemen`, `hashlink` (native adapters)
- `easyrpg`, `scummvm`, `browser-woditor` (managed RPG Maker 2000/2003, adventure-game and WOLF RPG Editor players)
- `sikarugir` (managed Wine versions for compatible Windows games; [versions and graphics](SIKARUGIR.md))
- `crossover` (registered local CrossOver applications for compatible Windows games; [application management](CROSSOVER.md))
- `mac32` (managed compatibility runtime for 32-bit Intel Mac apps; [requirements and settings](MAC32.md))

## Runtime selection flow
1. Module detection populates `moduleId` and metadata.
2. `normalizeGameEntry` selects a runtime:
   - If the entry has a runtime override, use it when supported.
   - Otherwise use `settings.modules[<id>].defaultRuntime`, then the module's automatic preference or `manifest.runtime.default`.
3. If the requested runtime is not supported, fallback to the first supported runtime.
4. If a runtime is supported but unavailable (for example missing a native path), the module can reject it via `canLaunchRuntime`.
5. Runtime entries declaring `launch: false`, and every runtime of a module declaring `supports.launch: false`, never launch. When none of a module's own runtimes can launch the game, automatic selection considers the [runtime providers](../MODULES.md#runtime-providers) that apply to it, in provider order.

The CLI uses the same service but explicit `--runtime <id>` requests are strict: the requested backend retains its own input and installation requirements. The shared entry point is documented in [BACKEND.md](../BACKEND.md).

Managed catalogs list published versions. Play uses the game's explicit version, then the recommendation from the game's own data, then the runtime default. Game recommendations come from detected formats, ABIs and engine versions, such as GameMaker WAD and sequence layouts, Ren'Py SDK versions, Java bytecode lines, KiriKiri native APIs and Butterscotch launch arguments, and from known game compatibility mappings. A saved default takes precedence over the manager default. The manager default is the newest compatible stable published version, or the newest ready installed version when no compatible version is listed. Clearing a saved default restores the manager default. A missing selected version downloads after consent; an empty catalog is discovered during consented preparation. Required engine ABIs, CPU and macOS limits still apply: an explicit incompatible version reports its requirement. Installed versions remain selectable, and Refresh preserves saved choices.

RPG Maker MV and MZ automatically prefer **NW.js (Patched)** when a usable NW.js SDK is installed, and use Electron otherwise. Existing game selections and explicit module defaults remain unchanged. Other HTML game types retain their own defaults. This host preference preserves the selected NW.js version and patch options.

NW.js uses the game's exact version, then the runtime default. The saved global default takes precedence over the manager default: the newest compatible stable listed SDK, or the newest ready installed SDK when none is listed. A game using Greenworks considers only hosts with a matching listed native bridge ABI; an explicit version without one reports the mismatch. Missing catalog discovery and installation follow download consent. Normal and patched NW.js use the same version for preparation, runtime status and launch.

Compatible x86/x64 Windows executables also offer Sikarugir (Wine), including
before its first download. CrossOver is available when a usable local application
is detected or registered. Known engines retain their usual defaults; generic
Windows games default to Sikarugir. Explicit saved CrossOver selections remain
unchanged. A detected engine whose own runtimes cannot launch the game, such as
BGI / Ethornell, CatSystem2 or a Windows Haxe hxcpp/Lime build, keeps its detection,
version and tools, and automatic selection takes the first compatible Windows runtime:
a registered CrossOver application, otherwise Sikarugir. Imports without a compatible
Windows executable remain inspection-only. Recognized Mac game engines retain their preferred engine runtime.
Other Mac apps use their native runtime when a 64-bit executable is available;
32-bit Intel apps use mac32 automatically.

On macOS, managed runtime installation removes the quarantine attribute from the
installed runtime automatically. Other attributes and external dependency links
remain unchanged. Read-only files without quarantine retain their permissions and
do not prevent installation. Imported game apps retain the separate **Remove quarantine** action.

## Hosted runtime boundary
The Electron UI and command-line runner both delegate launch dispatch to `src/core/launcher.js`.
Native module hooks receive an injected process launcher and work under ordinary Node.
Web games use `src/modules/shared/web/runtime/electron-host.js` with injected Electron APIs;
`src/runtime/electron-game.js` initializes only that host. MV/MZ manifests opt into save-directory
injection with `runtime.hosted.saveDirectory: true`, keeping engine names out of launcher branches.
Construct and Tyrano reuse the shared legacy NW.js window facade in their Electron adapters;
browser scripts retain their global libraries instead of taking unintended CommonJS paths.
Legacy enter, leave and toggle fullscreen calls control the owning game window through host IPC.
Initial canvas fitting applies only to a single visible canvas without visible text, media or
controls beyond its bounds. Pages with multiple visible canvases keep the host window size.
Explicit `package.json` window dimensions take precedence over automatic fitting.
Tyrano's Electron file-save API writes its original escaped JSON format to per-game storage,
so the runner executable directory is not used for saves.
The loopback static server handles media byte ranges, HEAD, stream failures and safe asset paths.
Failed window setup closes its server and removes session permissions.
Detached hosts retain their runtime diagnostics in the profile log after startup capture ends.

Construct Windows exports may keep the game in a separate `package.nw` beside a renamed
NW.js executable. Direct executable imports verify bounded PE version metadata identifying
the NW.js carrier and independently verify the Construct package before preparing it for Play.
Unrelated executables do not inherit neighboring game files.
Construct WebView2 browser bundles use a Node-disabled content frame inside the same native
NW.js window. The trusted wrapper retains native controls and startup reporting; readiness
requires the original game document to load, and its startup errors remain visible. Original
assets stay linked, browser workers retain browser APIs, and Node worker integration is not enabled.
Generic Web executable imports also require NW.js or Electron PE identity and a contained,
unpacked app package with a real entry and HTML export. An adjacent HTML file by itself
does not identify an arbitrary executable as a web game.
MV/MZ labels use the contained `data/System.json` game title when available. Author titles
and useful folder names are preserved when the bundled executable has a generic name such as
`Game.exe`; metadata changes participate in the normal source-cache refresh.

## Runtime managers
Runtime managers provide:

- Installed versions and exact per-game selection
- A remote catalog for downloads
- Default runtime settings
- Install/uninstall actions
- A shared download manager entry for tracking concurrent downloads and cancellations

Play resolves the compatible runtime before launching. When it is missing, the UI asks whether
to download it, installs the selected version, and continues launching. A matching installation
does not trigger a catalog refresh or another download. Preparation then runs through the same
Node backend used by the command-line launcher, without extra setup steps in the inspector.
Ordinary game launches, including installations during Play, leave the global runtime defaults
unchanged. Installations from Runtimes follow the default rules under
[Per-game runtime overrides](#per-game-runtime-overrides).

Optional decompilation actions use the same download-and-continue flow. Shared
[ILSpy](https://github.com/icsharpcode/ILSpy) versions appear under **Runtimes → Tools → ILSpy**;
Refresh, or a consented decompile action, reads NuGet framework and checksum metadata. Tool choices apply
to FNA and Unity exports without changing their game runtimes. Compatible .NET hosts
are shared between tool versions and acquired automatically when needed.

Included internal helpers run directly from app resources without Install or
Remove controls. Game engines use their selected managed installation. Writable
hosts prepare a private runtime copy automatically; downloads retain their exact
manager/version and show progress.
Preparation and process startup show Starting; Stop is available
once the native process exists.

Modules can provide `ensureRuntime(entry, context)` to reuse their existing version selectors.
It returns `null` when the selected runtime is included or installed, or an exact
`{ managerId, version, installOptions }` plan for the shared installer. Godot uses the detected
version/major and per-game override, Java uses the selected line or detected default and its existing architecture
fallback, LÖVE uses its stable/nightly selector, and Flash uses Ruffle's override/default/installed
precedence. Catalog lookup happens only during explicit Play when required to identify the version;
native-app choices remain local. Flash Player uses the selected managed universal projector.

Runtime managers are declared by modules via `runtimeManagers` and are deduped by id.
Shared submodules can also expose runtime managers by exporting manager objects from
`src/modules/shared/<submodule>/runtime/*.js`.

`runtime.managerUi[managerId].management` declares usable managed download or
automated build flows. Runtimes entries and inspector management links honor this
metadata; engine Settings, per-game options, exact versions and backend actions
remain available. A manager with several backends can declare `sectionManagement`;
ONScripter-Yuri exposes managed native `mac` and `web` sections. Invisible internal
helpers are separate from game-runtime choices.

### Versioned native managers

The shared pinned-native manager discovers downloads on explicit Refresh, Install or consented Play and reads cached or installed versions offline. MacLauncher Builds and upstream each have their own source controls. Downloads have pinned hashes; records include executable SHA-256, revision, architecture and source identity. Build actions verify clean revisions, stage tracked source separately, apply module overlays, and record tree/overlay hashes. Manual registration records the supplied source identity and executable checksum.

Explicit versions never silently switch to unrelated builds. Missing or incompatible choices fail with concrete status. Corrupt or incomplete owned records remain visible with **Needs repair** and Uninstall. Catalogs declare `installable`, optional `installableVersions`, `installLabel` and `installReason`. Managed binary packages execute from their versioned installation without compilers or per-game runtime copies. Existing compatible registrations retain priority. [Distribution](RUNTIME_DISTRIBUTION.md) lists the delivery policy of each backend.

The inspector records game engine and bytecode versions with their source and confidence. Runtime selection uses the module’s format and version requirements. The [engine guide](../README.md#engine-guides) and runtime references describe formats and architectures.

### MKXP-Z (RGSS)
The RGSS module registers the `mkxpz` runtime manager:
- Compatible exact packages download from MacLauncher Builds after consent.
- Refresh lists available versions; installed packages remain selectable offline.
- Ordinary Play needs no GitHub authentication, compiler or source checkout.
- Install destination: `userData/runtimes/mkxpz/<version>/`.
- Every Play uses the shared executable/frameworks and a tiny private session config. The included configuration helper redirects only the config-directory lookup. Original games and runtime apps are not copied per game. [MKXP-Z config isolation](MKXPZ.md) contains the corresponding reference.

### Ren'Py
The Ren'Py module registers the `sdk` runtime manager:
- Two sections: Ren'Py (Python 2) for Ren'Py 7 and earlier, and Ren'Py 8 (selected by `entry.moduleData.major`).
- Remote catalog uses `https://www.renpy.org/dl/` plus latest-stable hints from `https://renpy.org/latest.html` and `https://renpy.org/latest-7.html`.
- Install downloads the SDK DMG and mounts it via `hdiutil`, then copies with `ditto`.
- On macOS, new SDK installs also launch the copied `Ren'Py.app` once in the background and quit it after a short delay so the SDK is ready for later `renpy.sh` launches.
- Install destination: `userData/runtimes/sdk/<major>/<version>/`.
- Play uses the game's exact SDK version, then the SDK that rebuilt the game or the detected Ren'Py version, then the default for the game's Ren'Py major. A saved default takes precedence over that section's manager default: the newest compatible stable listed SDK, or the newest ready installed SDK when none is listed. Missing SDKs install after download consent.
- Installing an SDK newer than its section's default from Runtimes makes it that section's default.
- Per-game overrides live under `runtimeData.sdk.version` for the SDK runtime and remain exact. A packaged project retains its SDK version. Automatic selection does not save a per-game version override.

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
- Installing a Java release newer than its line's default from Runtimes makes it that line's default. Game version and CPU choices are unchanged. Vineflower retains its independent tool version selection, and a newer installed Vineflower becomes its default.
- Intel-only Java 8 packages use Rosetta on Apple Silicon.
- Vineflower catalog source: GitHub releases (`Vineflower/vineflower`).
- Vineflower install destination: `userData/runtimes/vineflower/<version>/vineflower.jar`.

Reload replaces the selected section's version list. A failed lookup keeps the last valid versions, install metadata and selected default; an immediate retry is available. Only successful lookups are reused for the six-hour catalog cache, and reading runtime state makes no network requests.

**Decompile Java** confirms any missing [Vineflower](https://github.com/Vineflower/vineflower) or Java download, installs it automatically, then continues. Selected tool versions remain exact; the tool's class version selects a compatible Java host. Installed tools and hosts are reused offline.

Without an explicit game line, Play uses the line the JAR recommends, then the saved default line, otherwise Java 21. Within that line, Play uses the game's exact version, then the line's default. A saved patch default takes precedence over the manager default: the newest compatible stable listed patch, or the newest ready installed patch when none is listed. Missing patches download after consent. Bytecode that needs Java 9 or later recommends the lowest compatible LTS line. Java 8 or older bytecode recommends Java 21, because the managed Java 8 builds are Intel-only on Apple silicon and JDK 8 double-encodes escaped characters, such as a space in the game folder, in ZIP file system URIs. It recommends Java 8 when the JAR depends on the Java 8 platform:

- Its classes use a Java 8 API that Java 21 does not provide, and the JAR does not bundle it. These APIs include JAXB, JAX-WS, SOAP and activation, CORBA, Nashorn, Pack200, RMI activation, `com.apple.eawt`/`com.apple.eio`, `com.sun.awt` and `sun.misc.BASE64Encoder`/`Decoder`.
- Its classes look up a `javax.script` engine and no engine is bundled.
- One of its classes references both `ClassLoader.getSystemClassLoader` and `java.net.URLClassLoader`, the pattern that treats the system class loader as a `URLClassLoader`. From Java 9 that cast fails.
- It ships macOS native libraries and none has an arm64 slice.

Detection reads the JAR, the JARs named by its manifest `Class-Path` and native libraries up to three folders below the JAR. Versioned classes under `META-INF/versions` are not evidence. JavaFX is not part of either managed line. Exact game versions retain their selected line, including Java 8 when detection recommends Java 21. Explicit game lines take precedence, including older lines for games that require older Java APIs. Automatic CPU selection prefers the Mac's native architecture; JNI consumers additionally enforce their required JVM CPU. Missing runtimes install after download consent using the chosen version or the game's compatible-line recommendation.

The game's Line control offers Java 8, 11, 17, 21 and 25 independently of the detected version. Its Version control lists installed versions from the selected line; Reload in Runtimes loads that line's available downloads. A saved patch from another line is ignored when the selected line changes, including when Auto follows a changed JAR requirement, so an installed JVM on the selected line can be reused without a download. The selected JVM determines whether the JAR's bytecode can run.

Positive Steam consumers use an exact [Java JNI bridge](JAVA_STEAM.md) automatically. The original wrapper classes select the matching Included JNI; Intel-only wrappers use an Intel JVM/Rosetta. The owned loader preserves the original JAR and separates game state without copying its JRE.

### Godot
The Godot module registers the `godot` runtime manager:
- Remote catalog parses `https://godotengine.org/download/archive/`.
- Reload loads the complete bounded archive list, including stable and development variants.
- Install downloads the selected macOS Standard or .NET zip from the archive detail page and extracts the `.app`.
- Install destination: `userData/runtimes/godot/<version>/<variant>/`.
- The same runtime panel includes a GDRE Tools section that downloads macOS zips from
  `https://github.com/GDRETools/gdsdecomp/releases` and installs to
  `userData/runtimes/gdsdecomp/<version>/`.

Godot extraction, version detection and script/resource tools confirm a missing [GDRE Tools](https://github.com/GDRETools/gdsdecomp) download and resume automatically after installation. The selected GDRE version is preserved; Reload only checks local status.

Godot 4 source projects without an existing resource cache are imported with the
selected engine before Play. Preparation uses a writable copy in per-game
storage and leaves the original project unchanged. Completed imports are reused
until source resources or the selected engine version change. Resource links
must stay within the project and contain no directory cycles. Packed games and
projects with an existing resource cache retain their normal launch path.

Exported packs supply their declared application title and supported icon resources
during import and metadata refresh. Windows exports prefer a declared native ICO
icon, with the general project icon as a fallback. PNG, WebP and bounded
self-contained SVG artwork use the same icon validation and cache as source
projects. Custom library titles and icons are preserved. Embedded packs with a
standard trailer are opened directly from the original executable; section-only
packs are copied to per-game storage with resource offsets adjusted for standalone
loading. Publisher files remain unchanged.

Godot 3 .NET launches prepare the selected runtime's API assemblies and the
game's managed assemblies in a private writable cache. Packed assets remain in
the original pack; stale packed API entries use a private copy so they cannot
override the selected runtime's assemblies. Source and recovered projects use a
private writable projection with their imported resources. Completed preparation
is reused until its inputs change. Publisher files remain unchanged, and this
preparation adds no process-wide hook or extra runtime download.
Unchanged preparations reuse API and asset files through recorded file
identities. Optional cleanup runs after the game process retires, retaining the
current preparation, one fallback and any active, modified or unproven working
data. Cleanup failure does not prevent Play.

The .NET runtime remains the default. C# content selects .NET automatically;
Standard remains available for GDScript games. Explicit per-game variants take
precedence. Installing or removing a runtime does not change game version choices. Managed assemblies must match the selected Godot API, with compatible
macOS native dependencies where required.

Per-game Godot runtime overrides default to the detected engine version (from PCK headers or project configs).
Detected base versions are resolved against the archive catalog on install (for example, `3.4.1` maps to the
latest `3.4.1-*` slug when available). If only a major version is detected, the launcher picks the latest
compatible installed version for that major and variant before consulting the archive. Exact game and global choices take precedence over detection. With no detected version or exact choice, one compatible installed runtime remains usable; otherwise Runtimes requires a version choice. Catalog discovery follows consent before preparation resumes. An installed `x.y` slug
also satisfies detected `x.y.0` through the existing version-bucket rules. Missing exact release
buckets fail with the requested version instead of switching to another release. A full bounded
archive lookup runs when needed, so manual refresh is not required.

Godot 4.4 and later 4.x releases include automatic camera integration for shared
temporal graphics on the Metal Forward+ renderer. Managed launches and recognized
native Mac apps preserve their original game files, autoloads and save settings.
Perspective single-view scenes supply the actual frame projection, depth and
motion inputs; Game default restores the game's original viewport scaler.
The [camera integration reference](../../src/modules/godot/graphics/README.md)
describes rendering requirements and the included helper.

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
- Play uses the game's exact choice, including version-only game choices, then the detected bundle version, then the selected channel's default. A saved default takes precedence over the channel's newest compatible listed version; when none is listed, the manager default is its newest ready installed version. LuaSteam retains its independent bridge selection.

### Ruffle + Flash Player
Flash games offer managed Adobe Flash Player (`projector`) and [Ruffle](https://github.com/ruffle-rs/ruffle) (`ruffle`). **Runtimes → Flash** groups their separate version controls; the inspector shows the selected player version.

Flash Player:
- MacLauncher Builds supplies the preserved universal 35.0.0.60 projector as a versioned package. Play downloads a missing package after consent; installed versions run offline without Rosetta or per-game player copies.
- Refresh, Install and exact version selection use the ordinary runtime manager. Missing or damaged installations can be repaired in Runtimes.
- The player originated from [Adobe Animate](https://www.adobe.com/products/animate.html) and retains Adobe and its licensors' copyright notices and vendor terms.

Ruffle:
- The catalog uses GitHub releases from `ruffle-rs/ruffle` (nightly/prerelease builds, macOS assets only).
- Reload and the on-demand first-install lookup load bounded ordinary release history.
- Install destination: `userData/runtimes/ruffle/<version>/`.
- Per-game overrides live under `runtimeData.ruffle.version`.
- Play uses the game's version, then the runtime default. A saved default takes precedence over the newest compatible stable listed release; when none is listed, the manager default is the newest ready installed release. Missing releases download after consent.
- Managed app launches track the bundle executable so Stop terminates the game process. The upstream app's sandbox and file-access prompts remain active.

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
- SDK and ABI matching precedes host or bridge download consent.
  Direct Runtimes downloads install the bridge package independently. [Greenworks](GREENWORKS.md) contains the corresponding reference.

### NW.js (Patched)
The `nwjs-patched` runtime shares the NW.js manager installs but adds a patch overlay:
- Case-insensitive asset loader and offline guards are available via runtime settings.
- MV/MZ can opt into Kawariki modules (remap/fixes/vars) and decrypted asset loaders.
- Other modules only load engine-agnostic helpers unless they explicitly opt in.
- Greenworks is injected automatically when detected in the game files.
- User scripts load from `*.maclauncher.js` and `*.maclauncher.mjs` in the game root when enabled.

NW.js installs use the SDK variant. Both launch modes share exact game and global choices, newest installed-host reuse and Greenworks ABI requirements.
The effective game network policy controls browser and Node network restrictions independently
of child-process protection. Online access does not enable game-launched child processes.
Extracted app bundles and installed framework aliases are checked before use; damaged installs remain visible and do not satisfy Play preparation.
Both launch modes verify the native game window's loaded document before reporting
success, matching the wrapper, app origin and requested index. Startup helpers and
browser injections live in the private wrapper;
browser scripts retain the game window's context, while Node guards stay in the
background context. Original game assets remain linked to their source.

### NScripter players
Native **ONScripter-Yuri** and **ONScripter-EN** use versioned MacLauncher Builds packages with their native dependencies. Play requests consent for a missing compatible package, installs it and resumes. Ordinary Play needs no Homebrew or source checkout. Native profile versions, platform requirements and format limits are described in [NSCRIPTER.md](NSCRIPTER.md).

**Runtimes → NScripter** exposes ONScripter-Yuri native/web sections and ONScripter-EN version controls. Yuri web releases come from [`YuriSizuku/OnscripterYuri`](https://github.com/YuriSizuku/OnscripterYuri); Refresh queries upstream explicitly while opening the tab stays offline. Missing web and NW.js host packages follow download consent. Web packages install under `userData/runtimes/onsyuri/web/<version>/` and require `onsyuri.html` or `index.html` in the install root or a contained subfolder. Player settings and exact versions remain available in the inspector.

### Python tooling (evbunpack)
Python and evbunpack are included internal extraction tools, without runtime choices or download prompts. Backend resolution uses an existing managed venv at `userData/runtimes/python/evbunpack/venv/` when present, then the embedded runtime at `src/resources/python/`. Source environments can also resolve `PYTHON3`, `PYTHON` or `python3` on PATH.
- The embedded runtime includes `aplib`, `pefile` and `corrupy`.

### Manager interface
Opening Runtimes or changing tabs reads local state. Each download source has an icon-only refresh control above its version selector, with the tooltip **Reload versions**, or **Reload <source> versions** for a named download source. GitHub Actions histories that span many pages (MKXP-Z upstream builds, LÖVE nightlies and Butterscotch) refresh with a bounded scan that lists the newest successful build; their separate **All versions** button requests the broader history; its tooltip is **All versions**, or **Reload all <source> versions** for a named download source. Successful queries replace and deduplicate that source's available releases. A failed query keeps its last valid list and existing selections. Installed versions retain their exact identities independently of download lists. Missing runtimes are acquired automatically after consent on Play or a tool action.

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

`getState` returns:
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
[Backend coordination](../BACKEND.md#shared-runtime-coordination) describes Node
injection and process lifetime.

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

The UI exposes these overrides when the selected runtime maps to a manager, and every installed
version remains selectable. Play applies the selection layers described above. Version order
compares numeric parts as numbers and places a stable release before a prerelease of the same
release; versions that differ only by a build hash keep their catalog order.

Installing from Runtimes leaves a saved default unchanged, with these exceptions:
- Ren'Py SDK, NW.js and the Java lines run older games on newer versions. Installing a version newer than the section's default makes it the default, as **Set default** does.
- Most native package managers, CrossOver and the Python tools save the first installed version as the default when no default is saved.
- Tool sections such as Vineflower and GDRE Tools make a newer installed version their default.

The inspector's Version menu names the version recommended by the game's data as **Recommended (vX)**; **Install** beside the menu installs that exact version when it is missing. Runtimes installation controls download the selected version. Installing the first version from Runtimes saves it as the default when no default is saved. Choosing a download version alone does not save a preference.

Runtime status uses the same saved preferences as Play, including independently selected dependency versions. Changing a default refreshes the status of runtimes that depend on it.
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

The Runtimes view exposes runtime managers, downloads and local application registrations.

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
`MACLAUNCHER_DEVTOOLS=1` enables the shortcut in hosts that supply DevTools.
`MACLAUNCHER_DEVTOOLS_AUTO=1` opens DevTools automatically on Electron launcher and game windows.

## Child processes
Electron and NW.js provide **Block child processes** in their runtime settings.
This allows `require("child_process")` for capability checks while blocking actual
`spawn`/`exec`/`fork` calls. Network access follows the shared game policy independently.

## Network policy
Settings → Launcher supplies the initial **Network access** choice for newly
imported games. Each game's inspector has one On/Off checkbox across runtimes.
Disabling access applies macOS network restrictions to the next game process and its
children, while retaining local Unix-socket communication and required local web
assets. Separately running services, including Steam, retain their own network policy.
Electron and NW.js apply the same choice to browser and Node networking.

Runtime catalogs and installs are the only built-in network operations.
These actions are always user-initiated from the Runtimes view (or explicit module actions such as patch/download).
The download manager surfaces in-progress transfers and allows canceling without blocking offline actions.
