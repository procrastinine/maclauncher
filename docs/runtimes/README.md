# Runtime system

A runtime is the engine, player or host that runs a game. MacLauncher detects each game's type, selects a compatible runtime, installs it when needed and launches the game, in the same way for every game type.

The documentation uses three terms:

- A game type is a game format that MacLauncher recognizes, such as Ren'Py or RPG Maker MV. Each game type is implemented by a module, which handles detection, game metadata, game-specific actions and launch preparation.
- A runtime (also called a backend) is one way to play a game type. A Ren'Py game, for example, can run in the Ren'Py SDK, through Ren'Py Patch or as the game's own Mac app.
- A runtime manager lists, downloads and installs the versions of a runtime or tool. Each manager appears as a tab in **Runtimes**.

Each [game-type page](../game-types/README.md) describes the runtimes, settings and tools of one game type. This page covers what they share: downloads, runtime selection, versions, runtime managers, per-game overrides, runtime settings and launch. Related references:

- [Web runtimes](WEB_RUNTIMES.md), [Sikarugir (Wine)](SIKARUGIR.md) and [CrossOver](CROSSOVER.md): runtimes shared by several game types.
- [Native tool setup](NATIVE_TOOL_SETUP.md): package sources, system components and decompilers.
- [Settings reference](SETTINGS_REFERENCE.md): every runtime setting and inspector action.
- [System requirements](SYSTEM_REQUIREMENTS.md): macOS versions, CPU architectures and graphics requirements for each component.

## Downloads and offline use

These rules apply to every runtime and tool.

Runtimes, tools and their version lists are downloaded only after an explicit action: **Refresh** or **Install** in **Runtimes**, an approved download during Play or an inspector action, or a module action such as a patch download. Opening **Runtimes**, switching its tabs, detection, runtime status and runtime selection read only local state. Transfers in progress appear in the download menu, where they can be cancelled without blocking anything that works offline.

When Play or an inspector action needs a runtime or tool version that is not installed, MacLauncher asks before downloading it. Once the download is approved, the version list is fetched if needed and the version is installed, and then the launch or action continues; a matching installed version starts without any catalog refresh or download.

This preparation includes selected graphics adapters, Vulkan implementations and downloadable shader collections. A manual visit to Runtimes is unnecessary. Missing enabled video plugins are optional downloads: **Skip** continues playback without the declined plugin.

When Automatic prefers KosmicKrisp for an Intel program on Apple Silicon with macOS 26 or later, the first Vulkan download offers the Intel GLES 3.2 build; **Use MoltenVK** continues with MoltenVK if the offer is declined, and acquisition failures use the same fallback. An installed compatible Vulkan implementation starts without another offer.

Installed versions work offline and are shared between games, while saves, accounts and writable game data stay separate for each game. A version stays selectable after it is no longer offered for download. Ordinary use needs no compiler, Homebrew, source checkout or developer tools, and MacLauncher does not install developer tools on the system.

MacLauncher's own [update check](../UPDATES.md) contacts GitHub only when **Check for Updates…** is chosen, or at launch when **Check for updates at launch** is on in **Settings → Launcher**; that setting is off by default.

[Release catalogs](RUNTIME_CATALOGS.md) describes how version lists are fetched and cached. [Game preparation and storage](../library/GAME_PREPARATION.md) describes how game files are handled.

## Runtime ids

Modules list their runtime ids in `manifest.runtime.supported`. Four ids are shared by several game types:

- `electron`: the game runs in the standalone Electron game host.
- `nwjs`: the game runs in an installed NW.js version through a small wrapper.
- `nwjs-patched`: NW.js with MacLauncher's compatibility patches (case-insensitive assets, user scripts and engine patches that a game type enables).
- `native`: a native app bundle or executable supplied with the game is launched directly.

The [web runtimes](WEB_RUNTIMES.md) page describes the first three. A game type whose files can be inspected but not played uses an `inspection` runtime, which keeps its tools and disables Play. Other ids belong to one game type:

| Game type | Runtime ids |
| --- | --- |
| [32-bit Mac](../game-types/MACOS.md#32-bit-mac) | `mac32` (compatibility runtime for 32-bit Intel Mac apps) |
| [AI5WIN](../game-types/AI5.md) | `ai5` |
| [AliceSoft](../game-types/ALICESOFT.md) | `system3`, `xsystem35`, `xsystem4` |
| [Android](../game-types/ANDROID.md) | `klepton` (MacLauncher Android), `macapk`, `aim` |
| [BGI / Ethornell](../game-types/BGI.md) | `bgi-tools` (inspection only) |
| [CatSystem2](../game-types/CATSYSTEM2.md) | `catsystem2-tools` (inspection only) |
| [DOS](../game-types/DOS.md) | `dosbox-staging` |
| [FAVORITE / FVP](../game-types/FVP.md) | `rfvp` |
| [Flash](../game-types/FLASH.md) | `projector` (Adobe Flash Player), `ruffle` |
| [FNA / XNA 4](../game-types/FNA.md) | `fna` |
| [GameMaker](../game-types/GAMEMAKER.md) | `official-studio`, `butterscotch`, `opengmk`, `inspection` |
| [Godot](../game-types/GODOT.md) | `godot` |
| [Half-Life (Xash3D FWGS)](../game-types/HALF_LIFE.md) | `xash3d-fwgs` |
| [HashLink (Haxe bytecode)](../game-types/HASHLINK.md) | `hashlink` |
| [Haxe native build](../game-types/HAXE.md) | `inspection` |
| [Infinity Engine (GemRB)](../game-types/INFINITY_ENGINE.md) | `gemrb` |
| [iOS / iPadOS](../game-types/IOS.md) | `playcover` |
| [Java](../game-types/JAVA.md) | `java` |
| [KiriKiri](../game-types/KIRIKIRI.md) | `krkrsdl2` |
| [LÖVE](../game-types/LOVE.md) | `love` |
| [MAGES.](../game-types/MAGES.md) | `impacto` |
| [Minori](../game-types/MINORI.md) | `reminori` |
| [MUGEN / Ikemen GO](../game-types/MUGEN.md) | `ikemen` |
| [Nintendo Switch](../game-types/SWITCH.md) | `nxnative`, `inspection` |
| [Nitroplus](../game-types/NITROPLUS.md) | `npengine` |
| [NScripter](../game-types/NSCRIPTER.md) | `onsyuri_mac`, `onscripter_en`, `onsyuri_web`, `external` |
| [PlayStation 5](../game-types/PS5.md) | `anyps5`, `inspection`, `prosper` |
| [Ren'Py](../game-types/RENPY.md) | `sdk`, `patched` |
| [RPG Maker 2000/2003](../game-types/RPGMAKER_2000_2003.md) | `easyrpg` |
| [RPG Maker XP/VX/VX Ace](../game-types/RPGMAKER_XP_VX.md) | `mkxpz` |
| [ScummVM](../game-types/SCUMMVM.md) | `scummvm` |
| [Siglus / RealLive](../game-types/SIGLUS.md) | `siglus`, `rlvm` |
| [Unity](../game-types/UNITY.md) | `unity` (exact-version Unity Mono) |
| [Video](../game-types/VIDEO.md) | `mpv` |
| [VNDS](../game-types/VNDS.md) | `vnds_love` |
| [Windows Game](../game-types/WINDOWS.md) | `sikarugir` ([downloaded Wine versions](SIKARUGIR.md)), `crossover` ([registered CrossOver applications](CROSSOVER.md)) |
| [WOLF RPG Editor](../game-types/WOLFRPG.md) | `browser-woditor` |

Game types not listed here, such as [macOS Game](../game-types/MACOS.md) and the web game types, use only the shared ids.

## Runtime selection

Detection sets the game's type and metadata. MacLauncher then selects a runtime in this order:

1. The game's own runtime choice, when its game type supports that runtime.
2. The game type's default runtime from **Settings**.
3. The game type's automatic preference, then the default declared by the module.

If the requested runtime is not supported, the first supported runtime is used. A supported runtime can still be unavailable for a particular game, for example when a native app path is missing. When none of a game type's own runtimes can launch the game, automatic selection considers the runtimes that serve several game types and apply to this game, such as Sikarugir and CrossOver, in their declared order.

The command-line launcher uses the same service. An explicit `--runtime <id>` is strict, so the requested runtime keeps its own input and installation requirements. [Backend and CLI](../development/BACKEND.md) describes the shared entry point.

### Versions

Each downloadable runtime lists its published versions in a catalog. Play picks a version in this order:

1. The version chosen for the game.
2. The version recommended by the game's own data. Recommendations come from detected formats, ABIs and engine versions, such as GameMaker WAD and sequence layouts, Ren'Py SDK versions, Java bytecode lines, KiriKiri native APIs and Butterscotch launch arguments, and from known compatibility mappings for particular games.
3. The runtime default. A saved default takes precedence over the manager default, which is the newest compatible stable version in the catalog, or the newest ready installed version when the catalog lists no compatible version. Clearing a saved default restores the manager default.

An explicitly chosen version is never replaced with a different build. When it cannot be installed or is incompatible, Play reports the specific reason instead, such as a required engine ABI, CPU architecture or macOS version.

The inspector records the game's engine and bytecode versions with their source and confidence, and runtime selection applies the game type's format and version requirements. Each [game-type page](../game-types/README.md) describes its formats and architectures.

### Windows games and Mac apps

Compatible x86 and x64 Windows executables also offer [Sikarugir (Wine)](SIKARUGIR.md), even before its first download. [CrossOver](CROSSOVER.md) is offered when a usable local CrossOver application is detected or registered. Known engines keep their usual default runtime, and generic Windows games default to Sikarugir. A saved CrossOver choice stays unchanged.

Some detected engines have no runtime of their own that can launch the game, such as BGI / Ethornell, CatSystem2 and Windows Haxe hxcpp/Lime builds. These games keep their detection, version and tools, and automatic selection takes the first compatible Windows runtime: a registered CrossOver application, otherwise Sikarugir. Imports without a compatible Windows executable can only be inspected.

Recognized Mac game engines keep their preferred engine runtime. Other Mac apps use their native runtime when a 64-bit executable is available, and 32-bit Intel apps use [mac32](../game-types/MACOS.md#32-bit-mac) automatically.

## Runtime managers

A runtime manager provides:

- installed versions and an exact per-game version choice
- a remote catalog of downloads
- default runtime settings
- install and uninstall actions
- an entry in the shared download manager, which tracks concurrent downloads and cancellations

Play resolves a compatible runtime before launching and installs it if needed, as described in [Downloads and offline use](#downloads-and-offline-use). Preparation then runs through the same Node backend as the command-line launcher, with no extra setup steps in the inspector.

Ordinary launches, including installations made during Play, leave the global runtime defaults unchanged. Installations from **Runtimes** follow the [default rules](#default-versions).

Helpers included in the app run from the app's resources and have no Install or Remove controls. Game engines run from their selected installation, and hosts that need to be writable get a private copy automatically. Each download installs exactly the selected version and shows its progress.

On macOS, installing a downloaded runtime removes the quarantine attribute from the installed runtime. Other attributes and links to external dependencies are unchanged. Read-only files without quarantine keep their permissions and do not prevent installation. Imported game apps have a separate **Remove quarantine** action.

### Versioned native managers

Most native engines share one version manager. Its MacLauncher Builds packages and the upstream project's own releases are listed separately, each with its own controls. Each download has a known SHA-256 hash, and each installation records the executable's SHA-256, the upstream commit it was built from, its architecture and where it came from. Build actions check that the source checkout is unmodified, copy its tracked files to a separate directory, apply the module's patches and record the hashes of the source tree and the patches. A runtime registered from a local path records the origin, executable path and executable checksum supplied with it.

Refresh reads the selected MacLauncher Builds or upstream catalog and saves that source's current list in the manager's runtime directory. An ordinary refresh lists every release, up to 500. Host architecture is matched before a download starts. A release is installed into `userData/runtimes/<managerId>/<architecture>/<version>/` through a temporary directory once its checksum is verified, and compatible installations from the earlier layout without an architecture folder remain usable. A release's declared build CPU, or its single declared host CPU, decides which Macs use such an installation; the file's Mach-O slices decide only when neither is declared. A manager that replaced earlier managers also uses their installations from the earlier folders, in place. The publisher's SHA-256 is checked when one is published; for historical GitHub assets without a publisher checksum, the downloaded archive's hash is recorded instead. The actual Mach-O contents are checked after extraction. Each installation's `runtime.json` records the commit, executable checksum, install source and date, and launch verifies the recorded executable. Replacing the executable requires removing that version and installing or registering it again. Uninstalling a local registration leaves the external executable in place. **Uninstall** removes only the selected installation of a version, so copies of that version for the other architecture, in the earlier layout or in a replaced manager's folder stay in place.

Local registration accepts an explicit version even when that version is absent from the download catalog. Registration checks the executable's format, CPU and macOS requirements and records its hash. A version with no known source revision is recorded as local, with unverified provenance. Its registration stays available offline and does not add a download option.

A damaged or incomplete installation stays visible with **Needs repair** and **Uninstall**, and it is excluded from launch and from the default-version fallback. Installing that version again replaces it, whether Play installs it after download consent, **Reinstall** in Runtimes or **Repair** in the inspector: the first step of the installation's download task removes the damaged copy of that version and build, and the installation continues as usual. A usable copy of the same build, a copy included with the app, a build the Mac cannot run and an external registration are never removed this way. Installed packages run from their version directory, with no per-game copy of the runtime. Existing compatible local registrations keep their priority. [Runtime distribution](RUNTIME_DISTRIBUTION.md) lists where each runtime comes from.

When Play installs a version only because it is the runtime's own default, with no game choice, game recommendation or saved default naming a version, Play records that version. Versions that a module chooses from a game's data, such as the Ren'Py SDK that rebuilt a game, are never recorded. The [upkeep pass](../development/DATA_MODEL.md#derived-data-upkeep) that follows each launcher start removes a recorded version through the same removal as **Uninstall** in Runtimes, once all of these hold:

- the section's current default is a newer, usable version of the same runtime and build, and it is installed;
- no game record, game choice, saved default or other saved setting names the version, and no game resolves to it;
- no game is running or being prepared, and nothing is downloading.

A game that uses a recorded version through its own choice or a saved default, **Install**, **Set default** and **Uninstall** clear the version's record. Versions without a record stay until they are removed in Runtimes. A removed version that a game needs again is downloaded after the usual consent.

For runtimes whose removal deletes only the version folder, such as the downloaded engine, Java, NW.js and native player versions, removing a version first moves that folder under `runtimes/` to a hidden name, so an interrupted removal never leaves a partly deleted version. The runtime manager then removes the version's records, and the folder is deleted. If the manager refuses the removal, the folder is restored. If the app quits during a removal, the next upkeep pass returns the folder when the manager still lists the version and deletes it otherwise. Removing a custom registration, or an added application such as a CrossOver application, only unregisters it and never deletes the files it points to.

### Tools

Inspector actions that need a decompiler or another tool install it in the same way. Shared [ILSpy](https://github.com/icsharpcode/ILSpy) versions appear under **Runtimes → Tools → ILSpy**. Refresh, or an approved decompile action, reads NuGet framework and checksum metadata. ILSpy versions apply to FNA and Unity exports without changing the games' runtimes. Compatible .NET hosts are shared between ILSpy versions and installed automatically when needed. Tools that belong to one game type are described on its page.

### Included internal tools

Python and [evbunpack](https://github.com/mos9527/evbunpack) are included in the app for extraction, so they have no version choice and no download prompt. evbunpack unpacks packed executables during extraction for RPG Maker XP/VX/VX Ace, NScripter and Tyrano games. The embedded Python runtime includes `aplib`, `pefile` and `corrupy`.

The backend uses an existing virtual environment at `userData/runtimes/python/evbunpack/venv/` when one is present, and otherwise the embedded runtime at `src/resources/python/`. When running from source, it can also use `PYTHON3`, `PYTHON` or `python3` on the `PATH`.

## The Runtimes window

**Runtimes** shows runtime managers, downloads and local application registrations, with one tab per manager. A manager's tab shows:

- section tabs when the manager has several groups, such as Temurin LTS and Vineflower, NW.js and Greenworks, or Ren'Py (Python 2) and Ren'Py 8 (fixed native players remain in **Settings**)
- the available versions, with a refresh control
- installed versions with uninstall actions
- the default version and, where supported, the variant

The download menu lists active downloads with cancel controls and supports several concurrent downloads.

Each download source has an icon-only refresh control above its version list, with the tooltip **Reload versions**, or **Reload <source> versions** when the source is named. Some GitHub Actions histories span many pages: MKXP-Z upstream builds, LÖVE nightlies and Butterscotch. Their refresh control runs a short scan that lists only the newest successful build, and a separate **All versions** button loads the longer history. Its tooltip is **All versions**, or **Reload all <source> versions** for a named source.

A successful query replaces that source's list of available releases, without duplicates. A failed query keeps the last valid list and existing selections. Changes to the download lists never alter installed versions.

### Processor builds

Each MacLauncher app lists and installs runtime builds for its own architecture by default, and the Intel app keeps choosing Intel builds when it runs through Rosetta on Apple Silicon. When a runtime publishes no build for the app's architecture, the automatic choice is another architecture the Mac can run: on Apple Silicon, a runtime published only for Intel lists its Intel builds, which run through Rosetta, and the Intel app lists the Apple Silicon builds of a runtime published only for Apple Silicon. Play, **Install**, the **Runtimes** lists and the inspector's default all follow this one automatic choice, so a game never needs a build chosen by hand. When a catalog also publishes builds for another architecture that the Mac can run, a **Build** menu above the version lists switches to them, for example from **Automatic (Apple Silicon)** to **Intel (Rosetta)**. Choosing a version from that list with **Set default** saves the architecture as well; a saved architecture without a build gives way to the automatic choice. Universal builds, and downloads published once for every Mac without naming a processor, appear in every list and need no menu. On Apple Silicon, an Intel copy of such a download that is already installed runs through Rosetta and appears once in the **Installed** list, so that version is not downloaded again. An Intel Mac lists only Intel and Universal builds, and a runtime with no build it can run lists no version. Builds for both architectures can be installed at the same time, and an installed version built for an architecture other than the automatic one carries an **Intel** or **Apple Silicon** label. A source that has been loaded and lists no build for the selected architecture shows a note and the small reload button; **Load versions** appears only for a source that has not been loaded. [System requirements](SYSTEM_REQUIREMENTS.md) lists the architectures of each runtime.

### Default versions

Installing from **Runtimes** leaves a saved default unchanged, with these exceptions:

- Ren'Py SDKs, NW.js and the Java lines run older games on newer versions. Installing a version newer than the section's default makes it the default, as **Set default** does.
- Most native package managers, CrossOver and the Python tools save the first installed version as the default when no default is saved.
- Tool sections, such as Vineflower and GDRE Tools, make a newer installed version their default.

Managers that declare `supportsDefault: false`, such as Unity Mono and the mpv plugins, offer no **Set default**. **Use automatic default** removes a saved default.

An installed build is marked with a processor when its package is built for a processor other than the automatic one, for example **Intel** for an Intel build installed with the **Build** menu in the Apple Silicon app. Builds for the automatic processor and Universal builds carry no mark. The mark follows the Macs that the package declares it runs on, not the processor of the files inside it, so a package for Apple Silicon that contains Intel Wine libraries is not marked **Intel**. Such a build can be the default. When one version is installed with both **Build** choices, only the installation made with the other processor's choice is marked. When the default version is not installed, the **Installed** list says so, and MacLauncher asks before downloading it when a game needs it.

The inspector's **Version** menu names the version recommended by the game's data as **Recommended (vX)**. **Install** beside the menu installs that exact version when it is missing. The menu lists installed versions and the game's saved choice, and downloadable versions stay in **Runtimes**. A damaged or incomplete installation stays in the menu as **Needs repair**. When it is the version the game uses, **Repair** beside the menu removes the damaged copy and installs that version again through the same installation, consent and download task as **Reinstall** in **Runtimes**. Installed builds that the Mac cannot run are left out of the menu unless one is the game's saved choice. The installation controls in **Runtimes** download the selected version. Installing the first version from **Runtimes** saves it as the default when no default is saved, and choosing a download version alone does not save a preference.

Runtime status uses the same saved preferences as Play, including versions of dependencies that are selected separately. Changing a default refreshes the status of the runtimes that depend on it.

## Per-game runtime overrides

Per-game overrides are stored in `games/<gameId>/game.json` under `runtimeData[<runtimeId>]`:

- `version` (string or null)
- `variant` (string or null, only for runtimes with variants)
- manager-specific keys, for example `runtimeData.java.line`, or `runtimeData.love.channel` to keep a LÖVE game on the LÖVE 11 line or on nightly builds

The inspector shows these overrides when the selected runtime has a manager, and every installed version that the Mac can run stays selectable. Play applies the [selection order](#versions) described above.

Versions are sorted by comparing numeric parts as numbers. A stable release sorts before a prerelease of the same version, and versions that differ only by a build hash keep their catalog order. A prerelease whose name does not already say so is labeled **(pre-release)**, and the installation controls preselect a stable version when the source lists one.

## Runtime settings

Runtime settings are separate from runtime managers and installations. The most specific source wins:

1. Per-game overrides: `games/<gameId>/game.json` under `runtimeSettings[<runtimeId>]`.
2. Game type defaults: `settings.modules[<moduleId>].runtimeSettings[<runtimeId>]`.
3. Global defaults: `userData/runtimes/<runtimeId>/settings.json`.

Game type defaults are edited in **Settings**. Per-game overrides are edited with the **Runtime Settings** button next to the runtime selector in the inspector. Changes are saved as soon as a field changes.

## Network access

**Settings → Launcher** supplies the initial **Network access** choice for newly imported games. Each game's inspector has one **Network access** checkbox that applies to every runtime. Turning access off applies macOS network restrictions to the next game process and its child processes, while keeping local Unix-socket communication and the local web assets the game needs. Services that run separately, including Steam, keep their own network policy. Electron and NW.js apply the same choice to both browser and Node networking. [Network isolation](NETWORK_ISOLATION.md) describes the restrictions. The setting does not apply to MacLauncher's own [downloads](#downloads-and-offline-use).

## Implementation

### Selection

1. Module detection sets `moduleId` and metadata.
2. `normalizeGameEntry` selects a runtime: the entry's runtime override when supported, otherwise `settings.modules[<id>].defaultRuntime`, then the module's automatic preference or `manifest.runtime.default`.
3. An unsupported runtime falls back to the first supported runtime.
4. A module rejects a supported but unavailable runtime through `canLaunchRuntime`.
5. Runtime entries declaring `launch: false`, and every runtime of a module declaring `supports.launch: false`, never launch. Automatic selection then considers the [runtime providers](../development/MODULES.md#runtime-providers) that apply.

Modules can provide `ensureRuntime(entry, context)` to reuse their existing version selectors. It returns `null` when the selected runtime is included or installed, or an exact `{ managerId, version, installOptions }` plan for the shared installer. Godot uses the detected version or major version and the per-game override. Java uses the selected line or detected default, with its existing architecture fallback. LÖVE uses its stable and nightly selector, and Flash uses Ruffle's override, default and installed-version precedence. A catalog lookup happens only during an explicit Play, and only when it is needed to identify the version; native-app choices stay local. Flash Player uses the selected universal projector package.

### Manager contract

Modules declare runtime managers in `runtimeManagers`, and managers are deduplicated by id. Shared submodules can also expose managers by exporting manager objects from `src/modules/shared/<submodule>/runtime/*.js`.

A manager can export:

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

- `installed`: the installed runtimes
- `catalog`: the catalog state and versions
- `sections`: an optional section list for the Runtimes view
- `notice`: optional callout data (a title and lines) shown in the Runtimes view

Catalogs declare `installable` and, optionally, `installableVersions`, `installLabel` and `installReason`.

`runtime.managerUi[managerId].management` declares which download or automated build flows a manager supports. The Runtimes entries and the inspector's management links follow this metadata; engine settings, per-game options, exact versions and backend actions remain available. A manager with several backends can declare `sectionManagement`. ONScripter-Yuri, for example, exposes native `mac` and `web` sections. Internal helpers that have no UI are kept apart from game-runtime choices.

`manifest.runtime.managerSectionOverrideKey` declares which manager section a module's per-game override selects in the inspector.

### Pre-launch checks

Modules can define readiness checks for each runtime in `manifest.runtime.preLaunch[<runtimeId>]`, for example to require patching or setup before launch:

- `statusAction` is called to check readiness.
- `readyWhen` lists the conditions that must be met.
- `fixAction` is called when the user accepts the prompt.
- `declineAction` (optional) is called when the user declines the prompt.

### Launch integration

- The hosted Electron runtime and the NW.js runtimes are described under [web runtimes](WEB_RUNTIMES.md#implementation).
- The native runtime uses `nativeAppPath` or module-specific resolution.
- Module `launchRuntime` handlers launch custom runtimes, such as Java (`java`), Ren'Py (`sdk` and `patched`) and NScripter (`onsyuri_*`).

### Concurrent runtime use

The shared Node coordinator serializes installations, imports, setup and installed-library actions that can change the same artifact. An installer that waits for another worker reuses a ready installation of the exact version. During inspection, setup and imports with unknown targets lock their whole manager. Active games hold leases that prevent changing or removing a runtime they use. Uninstall resolves its directory from the manager's installed rows and protects included resources.

A lease identifies the version the module actually selected, not its manager's defaults. A module that stages a private runtime context reports the shared source before staging with `await context.useRuntime({ managerId, version, sourcePath })`, adding `sectionId` and `variant` when needed. The checked spawn adapter also matches the actual executable and file arguments against the declared primary and prerequisite runtime artifacts.

Settings changes merge their changed fields through one host writer. Downloads and independent managers run in separate lanes. Module actions that modify shared assets use `context.withRuntimeMutation({ managerId }, async () => { ... })`, which covers every version of that manager. [Backend coordination](../development/BACKEND.md#shared-runtime-coordination) describes Node injection and process lifetime.
