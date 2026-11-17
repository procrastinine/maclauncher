# Runtime system

A runtime is the engine, player or host that runs a game. MacLauncher handles every game type the same way: it detects the game's type, selects a compatible runtime, installs that runtime when needed and launches the game.

The documentation uses three terms:

- A game type is a game format that MacLauncher recognizes, such as Ren'Py or RPG Maker MV. Each game type is implemented by a module, which handles detection, game metadata, game-specific actions and launch preparation.
- A runtime (also called a backend) is one way to play a game type. A Ren'Py game, for example, can run in the Ren'Py SDK, through Ren'Py Patch or as the game's own Mac app.
- A runtime manager lists, downloads and installs the versions of a runtime or tool, and each manager appears as a tab in **Runtimes**.

Each [game-type page](../game-types/README.md) describes the runtimes, settings and tools of one game type. This page covers what they have in common: downloads, runtime selection, versions, runtime managers, per-game overrides, runtime settings and launch. Related references:

- [Web runtimes](WEB_RUNTIMES.md) and the [Wine runtimes](WINE.md), [Sikarugir](SIKARUGIR.md), [CrossOver](CROSSOVER.md) and [WineCX](WINECX.md): runtimes shared by several game types.
- [Graphics translators](TRANSLATORS.md): the libraries that the Wine runtimes share to translate a Windows game's Direct3D or Vulkan calls to Metal.
- [Translator environment variables](TRANSLATOR_ENVIRONMENT.md): global and per-game environment variables for every runtime with a translator choice.
- [KosmicKrisp](KOSMICKRISP.md): the Vulkan driver on Metal 4, MacLauncher's adapted build of it, which CPU build each runtime loads, and a comparison with MoltenVK.
- [Native tool setup](NATIVE_TOOL_SETUP.md): package sources, system components and decompilers.
- [Settings reference](SETTINGS_REFERENCE.md): every runtime setting and inspector action.
- [System requirements](SYSTEM_REQUIREMENTS.md): macOS versions, CPU architectures and graphics requirements for each component.
- [Processor compatibility](PROCESSOR_COMPATIBILITY.md): the processor code of each component and how it runs on Apple Silicon, natively, through Rosetta or through FEX inside an Apple Silicon Wine.

## Downloads and offline use

The same download rules apply to every runtime and tool. Runtimes, tools and their version lists are downloaded only after an explicit action: **Refresh** or **Install** in **Runtimes**, an approved download during Play or an inspector action, or a module action such as a patch download. Opening **Runtimes**, switching its tabs, detection, runtime status and runtime selection read only local state. Transfers in progress appear in the download menu, where they can be cancelled, and they never block anything that works offline.

When Play or an inspector action needs a runtime or tool version that is not installed, MacLauncher asks before downloading it. After the download is approved, the version list is fetched if needed, the version is installed and the launch or action continues. When one Play needs several downloads, such as a Wine engine, a Direct3D translator and a Vulkan driver, a single **Download what <game> needs?** dialog lists each of them on one line with its version and size, followed by their total when every size is known. A listed download that comes under a licence, such as an RPG Maker RTP under its publisher's terms, adds a line that names its licence after the list, and the dialog's first button then reads **Agree, Download and Play**. The data that the game's enabled graphics rows need is listed in the same dialog: a shader collection, a neural model, FSR 4 model data, the Apex Neural Rendering kit or the Intel XeSS runtime. **Download and Play** installs them all at the same time and continues to the game without another question, and **Cancel** stops the Play. When the graphics data is the only download, the dialog offers **Play Without Downloading** instead, and the game starts without the rows that need it; that Play does not ask about the same data again. Another optional download that is the only one a Play needs keeps its own dialog, and declining it continues Play. Once a Play has one approved download, a further download that the same Play needs is approved with it and named in the log, without another question: a version found after the dialog, the tools a runtime's install step finds, the runtime used when an offered one could not be installed, or graphics data that the launch step finds. A question that downloads nothing, such as **Play with Steam?**, a download that Play declined earlier, an optional offer, a question with a choice of companions and a download under a licence (a licence sheet, an agreement or a named licence) are still asked. A matching installed version, on the other hand, starts without any catalog refresh or download.

Play prepares the selected graphics adapters, Vulkan implementations and downloadable shader collections the same way, so none of them has to be installed from Runtimes first. Enabled video plugins that are missing are offered as optional downloads, and **Skip** continues playback without the declined plugin.

One of the Vulkan implementations, KosmicKrisp, requires Metal 4 on physical Apple Silicon hardware with macOS 26 or later. When MacLauncher or a game runs through Rosetta, this requirement is judged by the Mac's actual hardware.

On Apple Silicon, MacLauncher can also prepare Intel native libraries for Rosetta ahead of time. After it installs an Intel package of native libraries from MacLauncher Builds, it can load the libraries that the package declares, along with their package dependencies, in a small Intel helper, and Rosetta then prepares them at their installed paths before Play. This preparation runs only when Rosetta is already installed, and its result is stored with the installation. If it fails or is cancelled, the package stays installed. Runtime status and selection never start the helper.

On Apple Silicon with macOS 26 or later, Automatic can also prefer KosmicKrisp for an Intel program. Such a program needs the Intel (x86-64) build of MacLauncher KosmicKrisp, MacLauncher's adapted build of KosmicKrisp, which Wine games can use as well. When no compatible Vulkan implementation is installed yet and that build can be downloaded, the first Vulkan download offers it. **Use MoltenVK** declines the offer and continues with MoltenVK, which is also used when the download fails or no Intel build is available. In that case a line under the Play progress gives the reason and the runtime in use, and the same line stays in the game's details after the game starts. If the cached catalog from a completed **Refresh** already shows no Intel build of MacLauncher KosmicKrisp, Play offers MoltenVK alone. When the catalog was never fetched, or its fetch failed, the download that Play asks for settles the question. Once a compatible Vulkan implementation is installed, it starts without another offer.

Installed versions work offline and are shared between games, while saves, accounts and writable game data stay separate for each game. A version also remains selectable after it is no longer offered for download. Ordinary use needs no compiler, Homebrew, source checkout or developer tools, and MacLauncher does not install developer tools on the system.

MacLauncher's own [update check](../UPDATES.md) is separate from these downloads. It contacts GitHub only when **Check for Updates…** is chosen, or at launch when **Check for updates at launch** is on in **Settings → Launcher**, a setting that is off by default.

Runtimes and tools that MacLauncher adapts for macOS are published as packages in [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds), a companion repository. Its [package index](https://procrastinine.github.io/maclauncher-builds/) lists every package with its latest version, and each package's own page lists its published versions and what changed in each. [Runtime distribution](RUNTIME_DISTRIBUTION.md) describes the package format. [Release catalogs](RUNTIME_CATALOGS.md) describes how version lists are fetched and cached, and [Game preparation and storage](../library/GAME_PREPARATION.md) describes how game files are handled.

## Runtime ids

Every runtime has an id, and each module lists the ids it supports in `manifest.runtime.supported`. Four ids are shared by several game types:

- `electron`: the game runs in the standalone Electron game host.
- `nwjs`: the game runs in an installed NW.js version through a small wrapper.
- `nwjs-patched`: NW.js with MacLauncher's compatibility patches (case-insensitive assets, user scripts and engine patches that a game type enables).
- `native`: a native app bundle or executable supplied with the game is launched directly.

The [web runtimes](WEB_RUNTIMES.md) page describes the first three. A game type whose files can be inspected but not played uses an `inspection` runtime instead, which keeps its tools and disables Play. The other ids each belong to one game type:

| Game type | Runtime ids |
| --- | --- |
| [32-bit Mac](../game-types/MACOS.md#32-bit-mac) | `mac32` (compatibility runtime for 32-bit Intel Mac apps) |
| [AI5WIN](../game-types/AI5.md) | `ai5` |
| [AliceSoft](../game-types/ALICESOFT.md) | `system3`, `xsystem35`, `xsystem4` |
| [Android](../game-types/ANDROID.md) | `klepton` (MacLauncher Android), `macapk`, `aim` |
| [BGI / Ethornell](../game-types/BGI.md) | `bgi-tools` (inspection only) |
| [Build engine (Raze)](../game-types/BUILD_ENGINE.md) | `raze` |
| [CatSystem2](../game-types/CATSYSTEM2.md) | `catsystem2-tools` (inspection only) |
| [DOS](../game-types/DOS.md) | `dosbox-staging` |
| [Doom engine (UZDoom)](../game-types/DOOM_ENGINE.md) | `uzdoom` |
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
| [LucasArts (DREAMM)](../game-types/DREAMM.md) | `dreamm` |
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
| [Windows Game](../game-types/WINDOWS.md) | `sikarugir` ([downloaded Wine versions](SIKARUGIR.md)), `crossover` ([registered CrossOver applications](CROSSOVER.md)), `winecx` ([downloaded WineCX versions](WINECX.md)), `metalsharp-wine` and `highball-wine` ([downloaded from their data files](WINE.md#sources-declared-by-their-data-file)) |
| [WOLF RPG Editor](../game-types/WOLFRPG.md) | `browser-woditor` |

Game types not listed here, such as [macOS Game](../game-types/MACOS.md) and the web game types, use only the shared ids.

## Runtime selection

Once detection has set the game's type and metadata, MacLauncher selects a runtime in this order:

1. The game's own runtime choice, when its game type supports that runtime.
2. The game type's default runtime from **Settings**.
3. The game type's automatic preference, then the default declared by the module.

If the requested runtime is not supported, the first supported runtime is used. Even a supported runtime can be unavailable for a particular game, for example when a native app path is missing. When none of a game type's own runtimes can launch the game, automatic selection turns to the runtimes that serve several game types and apply to this game, such as the Wine runtimes CrossOver, Sikarugir and WineCX, in their declared order.

A runtime chosen in the inspector is saved and takes effect in the library and inspector at once. For games whose save locations depend on the runtime, MacLauncher then reads the locations for the new runtime from the game's files, keeping the earlier locations until that read returns. If the read fails, the locations stay unchanged and the inspector shows a notice, and if another runtime is chosen before the read finishes, its result is discarded.

The command-line launcher selects runtimes through the same service. An explicit `--runtime <id>` is strict there, so the requested runtime keeps its own input and installation requirements. [Backend and CLI](../development/BACKEND.md) describes the shared entry point.

### Versions

Each downloadable runtime lists its published versions in a catalog. Play picks one of them in this order:

1. The version chosen for the game.
2. The version recommended by the game's own data. Recommendations come from detected formats, ABIs and engine versions, such as GameMaker WAD and sequence layouts, Ren'Py SDK versions, Java bytecode lines, KiriKiri native APIs and Butterscotch launch arguments, and from known compatibility mappings for particular games.
3. The runtime default. A saved default takes precedence over the manager default, which prefers a ready, compatible installed version and otherwise selects a compatible stable version from the catalog. Clearing a saved default restores the manager default.

A version chosen by hand for one game is always used exactly. Recommended versions and saved runtime defaults, however, are preferences: Play uses that exact version when it is ready locally, and otherwise the newest ready installed version in the same compatibility class, which the table below defines for each runtime. A compatible installed copy needs no download consent or catalog refresh. Only when no compatible local copy exists does Play request the preferred version, with consent. A runtime without a local compatibility class behaves differently: a saved default that is not installed gives way to the ready installed version that the manager default selects, such as an installed Sikarugir or WineCX version. **Install** in Runtimes installs the saved default itself.

| Runtime | Local compatibility class |
| --- | --- |
| Ren'Py SDK | Same major version, such as Ren'Py 8.2.x for an 8.3.4 game |
| Godot and Unity | Exact engine release |
| LÖVE | Same major API family; 0.x releases also keep the minor line |
| NW.js | Compatible web host; Greenworks keeps its exact host/bridge ABI |
| Java | Same JVM major line and required CPU variant |
| MKXP-Z, EasyRPG, DOSBox and ScummVM | Ready interpreter with the game's existing format and edition checks |
| HashLink | Compatible bytecode and native primitive profile |
| GameMaker | Compatible WAD/resource layout or Classic interpreter; required runner capabilities remain checked |
| FNA and KiriKiri | Verified runtime profile and required game APIs/resources |
| Vulkan drivers | Any ready installed version of the same driver; recorded capability requirements remain checked |
| Graphics translators | Same variant and major component version; Template folder preferences keep their variant without guessing a component version from the Template release |

A version chosen by hand for a game is never replaced with a different one. When it cannot be installed or is incompatible, Play reports the specific reason instead, such as a required engine ABI, CPU architecture or macOS version.

The inspector lists only the versions and runtime libraries installed on the Mac, so versions that a catalog merely offers for download do not appear there. When both Intel and Apple Silicon copies of a version are installed, its entries carry **(Intel)** and **(Apple Silicon)**, and selecting one saves that CPU for the game. A version with a single installed copy keeps its plain label. Sometimes Play matches a saved choice to an installed build whose name is spelled differently, such as a Godot choice of 3.5.2 for the installed 3.5.2-stable; the inspector then shows that build and leaves the saved choice unchanged. A saved choice that is no longer installed still appears in the list, once, and is marked **(not installed)** after Play has looked up its version. Play then asks for the usual download consent if it is needed. Damaged copies also stay visible, marked **Needs repair**.

The inspector also records the game's engine and bytecode versions with their source and confidence, and runtime selection applies the game type's format and version requirements. Each [game-type page](../game-types/README.md) describes its formats and architectures.

### Windows games and Mac apps

Any game with a compatible x86 or x64 Windows executable is also offered [Sikarugir](SIKARUGIR.md), even before Sikarugir's first download. [WineCX](WINECX.md) is offered the same way, and [CrossOver](CROSSOVER.md) joins them when a usable local CrossOver application is detected or registered. Known engines keep their usual default runtime, generic Windows games default to Sikarugir, and a saved CrossOver choice stays unchanged.

Some detected engines, such as BGI / Ethornell, CatSystem2 and Windows Haxe hxcpp/Lime builds, have no runtime of their own that can launch the game. Their games keep their detection, version and tools, while automatic selection takes the first compatible Windows runtime: a registered CrossOver application, otherwise Sikarugir. An import without a compatible Windows executable can only be inspected.

Mac apps follow a similar pattern. Recognized Mac game engines keep their preferred engine runtime. Other Mac apps use their native runtime when a 64-bit executable is available, and 32-bit Intel apps use [mac32](../game-types/MACOS.md#32-bit-mac) automatically.

## Runtime managers

Each runtime manager provides:

- installed versions and an exact per-game version choice
- a remote catalog of downloads
- default runtime settings
- install and uninstall actions
- an entry in the shared download manager, which tracks concurrent downloads and cancellations

Before launching, Play finds a compatible runtime and installs it if needed, as described in [Downloads and offline use](#downloads-and-offline-use). Preparation then runs through the same Node backend as the command-line launcher, so the inspector needs no extra setup steps.

Ordinary launches, including installations made during Play, leave the global runtime defaults unchanged. Installations from **Runtimes**, however, follow the [default rules](#default-versions).

Where a runtime runs from depends on its kind. Helpers included in the app run from the app's resources and have no Install or Remove controls. Game engines run from their selected installation, and hosts that need to be writable get a private copy automatically. Each download installs exactly the selected version and shows its progress.

On macOS, installing a downloaded runtime removes the quarantine attribute from the installed files, while other attributes and links to external dependencies are left unchanged. Read-only files without quarantine keep their permissions and do not prevent installation. For imported game apps, a separate **Remove quarantine** action is available.

### Versioned native managers

Most native engines share one version manager. It lists two sources separately, each with its own controls: the packages that MacLauncher publishes in MacLauncher Builds, and the upstream project's own releases. A Builds download is checked against the archive's SHA-256 in the catalog. Each installation then records its source metadata, architecture and origin, together with a checksum measured from the installed executable. A runtime registered from a local path records its origin, executable path and checksum instead.

Refresh reads the selected MacLauncher Builds or upstream catalog and saves that source's current list in the manager's runtime directory. For MacLauncher Builds, the list covers every release in the project's catalog that the Mac can run, regardless of which versions the app itself includes, so releases published after the installed app appear too. Any of these versions can be installed in **Runtimes** and selected for a game, and installing one leaves the other installations and the games' saved choices in place. A release whose catalog entry cannot be used stays listed with the reason. Upstream catalogs have their own release and page limits, which [release catalogs](RUNTIME_CATALOGS.md) gives for each source. Before a download starts, the build is chosen from the CPU requirements in the catalog to match the host architecture. Once its checksum is verified, the release is installed into `userData/runtimes/<managerId>/<architecture>/<version>/` by way of a temporary directory. Compatible installations from the earlier layout, which had no architecture folder, remain usable, and a manager that replaced earlier managers also uses their installations from the earlier folders, in place.

For upstream releases, the publisher's SHA-256 is checked when one is published. Some historical GitHub assets have no publisher checksum, and for those the downloaded archive's hash is recorded instead. After extraction, installation checks the actual Mach-O contents, including their slices and deployment versions. Each installation's `runtime.json` records source metadata, the measured executable checksum, the install source and the date. A downloaded package is not compared with saved per-file checksums or source labels; native compatibility and required APIs are checked where they are used instead. Installed versions are also found from their local records, without a current catalog entry.

**Uninstall** removes only the selected installation of a version. Copies of that version for the other architecture, in the earlier layout or in a replaced manager's folder stay in place, and uninstalling a local registration leaves the external executable in place.

A runtime can also be registered from a local path. Such a registration accepts an explicit version even when the download catalog does not list it, checks the executable's format, CPU and macOS requirements, and records its hash. A version whose source revision is unknown is recorded as local, with its origin marked as unverified. The registration stays available offline and adds no download option. Its row in Runtimes reads **Custom** and shows the registered folder under its name. A registered Wine is named like an installed one, by the release its files state and its Wine version (for example **WineCX 4.8.1 · Wine 11.19**); the folder name is used only when its files state no version.

A damaged or incomplete installation stays visible with **Needs repair** and **Uninstall**, although it is excluded from launch and from the default-version fallback. An installed version that this MacLauncher cannot use, such as a package built for other loader paths, reads **Incompatible** instead. When the catalog lists the same package as the installed copy, that version is neither preselected in the version menu nor offered for installation again; a newer listed version is the offer. Removing that copy, or a download whose package fails the same checks, records the reason with the listed package. The version then reads **Unavailable** in the menu, Install states the reason, and neither Play nor Install downloads that package again, including after Refresh. A different package published later for the version is offered as usual. Installing the same version again replaces it, whether that happens from Play after download consent, from **Reinstall** in Runtimes or from **Repair** in the inspector. In each case, the download task first removes the damaged copy of that version and build and then continues as usual. This never removes a usable copy of the same build, a copy included with the app, a build the Mac cannot run or an external registration.

Installed packages run from their version directory, without a per-game copy of the runtime, and existing compatible local registrations keep their priority. [Runtime distribution](RUNTIME_DISTRIBUTION.md) lists where each runtime comes from.

Some installed versions are removed automatically once a newer default replaces them. Play marks a version for this when it installs that version only because it is the runtime's own default, with no game choice, game recommendation or saved default naming a version. A version that a module chooses from a game's data, such as the Ren'Py SDK that rebuilt a game, is never marked. After each launcher start, a background cleanup pass, the [upkeep pass](../development/DATA_MODEL.md#derived-data-upkeep), removes a marked version in the same way as **Uninstall** in Runtimes once all of these hold:

- the section's current default is a newer, usable version of the same runtime and build, and it is installed;
- no game record, game choice, saved default or other saved setting names the version, and no game resolves to it;
- no game is running or being prepared, and nothing is downloading.

The mark is cleared when a game uses the version through its own choice or a saved default, and also by **Install**, a choice in the **Default** menu and **Uninstall**. Unmarked versions stay until they are removed in Runtimes, and a removed version that a game needs again is downloaded after the usual consent.

For some runtimes, such as the downloaded engine, Java, NW.js and native player versions, removal deletes only the version folder. That folder is first renamed to a hidden name under `runtimes/`, so an interrupted removal never leaves a partly deleted version behind. The runtime manager then removes the version's records, and the folder is deleted; if the manager refuses the removal, the folder is restored instead. When the app quits during a removal, the next upkeep pass restores the folder if the manager still lists the version and deletes it otherwise. Removing a custom registration, or an added application such as a CrossOver application, only unregisters it and never deletes the files it points to.

### Tools

Inspector actions that need a decompiler or another tool install it in the same way. For example, shared versions of the .NET decompiler [ILSpy](https://github.com/icsharpcode/ILSpy) appear under **Runtimes → Tools → ILSpy** and are used for FNA and Unity exports without changing the games' runtimes. Refresh, or an approved decompile action, reads ILSpy's framework and checksum metadata from NuGet. The .NET hosts that ILSpy needs are shared between its versions and installed automatically when needed. Tools that belong to one game type are described on its page.

### Included internal tools

Extraction relies on two tools that are included in the app, Python and [evbunpack](https://github.com/mos9527/evbunpack), so neither has a version choice or a download prompt. During extraction for RPG Maker XP/VX/VX Ace, NScripter and Tyrano games, evbunpack unpacks packed executables. The embedded Python runtime includes the `aplib`, `pefile` and `corrupy` modules.

To run evbunpack, the backend uses an existing virtual environment at `userData/runtimes/python/evbunpack/venv/` when one is present, and otherwise the embedded runtime at `src/resources/python/`. When MacLauncher runs from source, the backend can also use `PYTHON3`, `PYTHON` or `python3` on the `PATH`.

## The Runtimes window

The **Runtimes** window is where runtimes are downloaded, refreshed and removed and where their default versions are chosen. Every runtime manager has a tab of its own there, even for small packages that other runtimes load: DXVK-NVAPI and the NGX core of Vulkan DLSS forwarding sit beside DXVK and vkd3d-proton, CrossOver graphics integration is in the CrossOver entry, MoltenVK scene support is among the Vulkan drivers, and the FidelityFX API adapter is in **Effects**. Settings that change how a runtime behaves, such as translator environment variables and plugin switches, are in **Settings** instead. A manager's tab shows:

- section tabs when the manager has several groups, such as Temurin LTS and Vineflower, NW.js and Greenworks, or Ren'Py (Python 2) and Ren'Py 8 (fixed native players remain in **Settings**)
- the available versions, with a refresh control
- installed versions with their size on disk and uninstall actions; sizes are measured for folders inside the MacLauncher data folder while the tab is shown, and registered applications elsewhere show none
- the default version and, where supported, the variant

Active downloads appear in the download menu, which supports several concurrent downloads and offers a cancel control for each.

Each download source's version list has an icon-only refresh control above it, with the tooltip **Reload versions**, or **Reload <source> versions** when the source is named. The GitHub Actions histories of MKXP-Z upstream builds, LÖVE nightlies and Butterscotch span many pages, so for these sources the refresh control runs a short scan that lists only the newest successful build. A separate **All versions** button loads the longer history; its tooltip is **All versions**, or **Reload all <source> versions** for a named source.

A successful query replaces that source's list of available releases, without duplicates. A failed query keeps the last valid list and the existing selections. Changes to the download lists never alter installed versions.

### Processor builds

By default, each MacLauncher app lists and installs runtime builds for its own architecture, and the Intel app keeps choosing Intel builds even when it runs through Rosetta on Apple Silicon. When a runtime publishes no build for the app's architecture, the automatic choice falls to another architecture the Mac can run. On Apple Silicon, a runtime published only for Intel therefore lists its Intel builds, which run through Rosetta, and the Intel app lists the Apple Silicon builds of a runtime published only for Apple Silicon. Play, **Install**, the **Runtimes** lists and the inspector's default all follow this one automatic choice, so no game needs a build chosen by hand.

Some catalogs also publish builds for a second architecture that the Mac can run. For these, a **Build** menu above the version lists switches between architectures, for example from **Automatic (Apple Silicon)** to **Intel (Rosetta)**. Choosing that build in the **Default** menu saves the architecture as well, and a saved architecture can mean that the copy for that CPU has to be installed. Universal builds, and downloads published once for every Mac without naming a processor, appear in every list and need no menu. On Apple Silicon, an installed Intel copy of such a download runs through Rosetta and appears once in the **Installed** list, so the version is not downloaded again.

An Intel Mac lists only Intel and Universal builds, and a runtime with no build it can run lists no version at all. Builds for both architectures can be installed side by side, and an installed version built for an architecture other than the automatic one carries an **Intel** or **Apple Silicon** label. When a source has been loaded but lists no build for the selected architecture, it shows a note and the small reload button; **Load versions** appears only for a source that has not been loaded yet. [System requirements](SYSTEM_REQUIREMENTS.md) lists the architectures of each runtime, and [Processor compatibility](PROCESSOR_COMPATIBILITY.md) lists the processor code of every component and its Apple Silicon alternative.

Every label that names the CPU of a build uses the same terms:

| Code | Label |
| --- | --- |
| Mac code for Apple Silicon | **Apple Silicon** |
| Mac code for Intel | **Intel**; **Intel (Rosetta)** where the label states that the build runs on an Apple Silicon Mac, as in the **Build** menu and the inspector |
| Mac code for both | **Universal** |
| Windows code | its Windows architecture: **x64**, **x86** or **ARM64** |
| Windows hybrid code | **ARM64EC** for ARM64 code that runs inside an x64 program translated by FEX; **ARM64X** for a library that holds both ARM64 and ARM64EC code and loads into either kind of program |

The graphics translator entries, **DirectX → Vulkan**, **DirectX → Metal** and **Vulkan drivers**, show the CPU build of every installed version as a badge. The badge comes from the CPU slices of the installed library when possible, then from the build that its release list declares, and finally from the CPU its installation was made for. A library with both slices reads **Universal**, and so do Windows libraries published once for every Mac, as their list declares. When both builds of one version are installed, the version appears as two rows, one labeled **Intel** and one **Apple Silicon**. In these entries the **Build** menu sits under **Additional sources**, because Play chooses the build that a game's Wine needs. A version in a download menu names its build only when it differs from the chosen build, such as an Intel-only version listed as **1.2 · Intel** for Apple Silicon. A Universal build includes the chosen CPU and is therefore not named, and a version from a release list that declares no CPU, such as MoltenVK's release page, stays unnamed until it is installed. A menu whose entries all share one CPU, such as a game's Vulkan driver choices, does not repeat it. [KosmicKrisp](KOSMICKRISP.md#cpu-builds-and-consumers) lists which build each game runtime loads, and [CPU build labels](TRANSLATORS.md#cpu-build-labels) describes the labels.

For a selected version, a verified installed copy is used before another CPU build is downloaded. Among installed copies, the launcher's own CPU comes first, followed by any other CPU the Mac can run, including Intel through Rosetta on Apple Silicon. An explicit CPU choice is always followed. When a component that the runtime cannot run without is missing, a repair can be required, but a missing optional companion never causes the base runtime to be downloaded again.

### Default versions

Installing from **Runtimes** leaves a saved default unchanged, with these exceptions:

- Ren'Py SDKs, NW.js and the Java lines run older games on newer versions, so installing a version newer than the section's default makes it the default, as choosing it in the **Default** menu does.
- Most native package managers, CrossOver and the Python tools save the first installed version as the default when no default is saved.
- Tool sections, such as Vineflower and GDRE Tools, make a newer installed version their default.

The **Default** menu in the **Installed** header chooses the default version. Its first choice, **Automatic**, names the version it currently resolves to while no default is saved, such as **Automatic (WineCX 4.8.1)**, and choosing it removes a saved default. The other choices are the usable installed versions, each variant and processor build separately. A saved default that is not installed stays selected and is marked **not installed**. Managers that declare `supportsDefault: false` have no **Default** menu, and Included references are never a choice in it.

An installed build is marked with a processor when its package is built for a processor other than the automatic one, for example **Intel** for an Intel build installed with the **Build** menu in the Apple Silicon app. Builds for the automatic processor and Universal builds carry no mark. Because the mark follows the Macs that the package declares it runs on rather than the processor of the files inside it, a package for Apple Silicon that contains Intel Wine libraries is not marked **Intel**, and such a build can be the default. When one version is installed with both **Build** choices, only the installation made with the non-automatic choice is marked. The graphics translator entries name every build instead, as described under [Processor builds](#processor-builds). When the default version is not installed, the **Installed** list says so, and MacLauncher asks before downloading it when a game needs it.

In the inspector, the **Version** menu's first entry reads **Automatic**. It changes to **Automatic (vX)** once vX, the version Play uses without a per-game choice, has been looked up; that is a compatible installed version when one exists, and otherwise the version Play would install. When the game's data recommends a version that is not installed, **Install** beside the menu installs that exact version. The menu itself lists installed versions and the game's saved choice, while downloadable versions stay in **Runtimes**. Installed builds that the Mac cannot run are left out of the menu unless one of them is the game's saved choice.

Each game keeps a separate version choice for each runtime, so switching runtimes preserves the earlier runtime's choice. A saved explicit version takes precedence over the game's recommendation. Without an explicit choice, native package managers use the recommendation, then a saved default, then the manager's automatic selection.

A damaged or incomplete installation stays in the menu as **Needs repair**. When it is the version the game uses, **Repair** beside the menu removes the damaged copy and installs that version again, through the same installation, consent and download task as **Reinstall** in **Runtimes**.

The installation controls in **Runtimes** download the selected version. When no default is saved, installing the first version from **Runtimes** saves it as the default, although merely choosing a version in a download list saves no preference. Translator copies and exact-version Unity players keep their preferences unchanged during installation and removal; a choice in the **Default** menu saves their default explicitly.

Runtime status reads the same saved preferences as Play, including the versions of separately selected dependencies, so changing a default refreshes the status of every runtime that depends on it.

### Downloaded files

Some downloads belong to no runtime manager. **Runtimes → Tools → Downloaded files**, the last subtab of the Tools entry, manages all of them. Play and the inspector never open this tab, because each file downloads by itself, after consent, when something needs it. The tab opens with the list it last read and then reads the files again in a backend worker; deleting waits until that read finishes. It covers:

- shared assets, such as the fallback font of NScripter games and the MIDI soundfont and RPG Maker run-time packages that MKXP-Z uses
- the GOG and Epic Games Store download helpers
- the Android system image that AIM attaches and the microG packages of the shared Google account service
- the shared libraries that installed runtime packages declare
- caches that MacLauncher fills, such as the Steam game version lists, the F-Droid and IzzyOnDroid indexes, translator descriptions and neural model source archives

The Steam client bridge and Valve's Steam client files are not part of this tab; they are handled in the bridge's own **Runtimes** entry. Games downloaded through the store windows are handled in the library.

The tab lists installed files only, largest first. A download whose versions come from a catalog, such as the store download helpers and microG, has an icon-only **Refresh** control on its first row. Refresh reads the catalog and names the newest release, which the next store download or Google sign-in installs, and downloads nothing else. Each row names the file and its version, the CPU architecture in the terms of [Processor builds](#processor-builds), the size on disk, the source (the host it was downloaded from, **Added manually**, or **Created by MacLauncher** for a cache) and the runtimes or games that use it, by their names in **Runtimes**. The tooltip of the name shows the file's content checksum. With nothing installed, the tab reads **No downloaded files.** The list reads only local files, and the reload button reads them again.

**Delete** asks for confirmation in a native dialog. The dialog names the runtimes or games that use the file and notes that a running game keeps the files it already loaded until it quits. It also states that MacLauncher asks before downloading the file again the next time something needs it, or, for a cache, that MacLauncher fills it again when needed. A shared library that installed runtimes still load cannot be deleted, and its row gives that reason; it is removed together with the last runtime that uses it. **Delete unused** deletes every file that no installed runtime or game uses, after one confirmation that lists them. To remove a file, MacLauncher renames it to a trash name in its own folder and then deletes it without following links. Each such folder is registered with the upkeep pass, which finishes any removal that was interrupted.

**Add from file…** reads a chosen file first and then, without network access, adds it to the download whose recorded checksum it matches:

- A shared asset must have the recorded size and SHA-256.
- A runtime package archive must match the SHA-256 of a release in that runtime's cached version list. A match installs that release, for the CPU its list names, through the ordinary installation. A package that declares a shared library that is not on this Mac is rejected with that library's name; installing the runtime from **Runtimes** downloads it after consent.
- An RPG Maker run-time package installer must match the publisher installer's recorded SHA-256. When the installer reader that extracts it is not installed, MacLauncher asks before downloading the reader.

A folder, an empty file or a file that matches no recorded download is rejected with a plain reason, and nothing is installed; for an unknown file, the reason names its SHA-256. The same check applies when the matching download is already installed. An added file reads **Added manually** as its source.

**Show in Finder** reveals the file or its folder.

## Per-game runtime overrides

A game can override its runtime's version, variant and some manager-specific choices. These overrides are stored in `games/<gameId>/game.json` under `runtimeData[<runtimeId>]`:

- `version` (string or null)
- `variant` (string or null, only for runtimes with variants)
- manager-specific keys, for example `runtimeData.java.line`, or `runtimeData.love.channel` to keep a LÖVE game on the LÖVE 11 line or on nightly builds

The inspector shows these overrides when the selected runtime has a manager, and every installed version that the Mac can run can be selected there. Play applies the [selection order](#versions) described above.

Version lists are sorted newest first by the release version that each source uses, such as a GitHub release tag. Numeric parts compare as numbers, so 1.0.10 is newer than 1.0.9. A letter revision such as 3.0a or 3.0b is newer than its base release 3.0 and older than the next numeric release, 3.0.1. A stable release sorts before a prerelease of the same version, while versions that differ only by a build hash keep their catalog order. A prerelease whose name does not already say so is labeled **(pre-release)**.

Each source's version menu keeps an explicit choice for as long as the source lists it. Without one, the menu preselects the source's recommended version, unless that version is a prerelease and a stable version is listed. In that case, and when no version is recommended, the menu preselects the newest stable version, or the first listed version when every version is a prerelease.

## Runtime settings

Runtime settings are kept apart from runtime managers and installations. They can be set at three levels, and the most specific level wins:

1. Per-game overrides: `games/<gameId>/game.json` under `runtimeSettings[<runtimeId>]`.
2. Game type defaults: `settings.modules[<moduleId>].runtimeSettings[<runtimeId>]`.
3. Global defaults: `userData/runtimes/<runtimeId>/settings.json`.

Game type defaults are edited in **Settings**. Per-game overrides are edited in the runtime settings window, which opens from the gear beside the runtime selector in the inspector. Each game has one such window per runtime, so opening it again focuses the window that is already open. Every change is saved as soon as a field changes.

Translator environment variables have two levels of their own: global values in **Settings → Environment variables** and a game's own values in its **Runtime Settings**. [Translator environment variables](TRANSLATOR_ENVIRONMENT.md) describes them.

## Network access

Each game's inspector has one **Network access** checkbox, which applies to every runtime, and newly imported games take its initial value from **Settings → Launcher**. Turning access off applies macOS network restrictions to the next game process and its child processes. Local Unix-socket communication and the local web assets that the game needs remain available. Services that run separately, including Steam, keep their own network policy. In Electron and NW.js, the same choice covers both browser and Node networking. [Network isolation](NETWORK_ISOLATION.md) describes the restrictions. The setting does not apply to MacLauncher's own [downloads](#downloads-and-offline-use).

## Implementation

### Selection

1. Module detection sets `moduleId` and metadata.
2. `normalizeGameEntry` selects a runtime: the entry's runtime override when supported, otherwise `settings.modules[<id>].defaultRuntime`, then the module's automatic preference or `manifest.runtime.default`.
3. An unsupported runtime falls back to the first supported runtime.
4. A module rejects a supported but unavailable runtime through `canLaunchRuntime`.
5. Runtime entries declaring `launch: false`, and every runtime of a module declaring `supports.launch: false`, never launch. Automatic selection then considers the [runtime providers](../development/MODULES.md#runtime-providers) that apply.

Modules can provide `ensureRuntime(entry, context)` so that their existing version selectors are reused. It returns `null` when the selected runtime is included or installed, and otherwise an exact `{ managerId, version, installOptions }` plan for the shared installer. Each module resolves the version in its own way: Godot uses the detected version or major version and the per-game override, and Java uses the selected line or detected default, with its existing architecture fallback. LÖVE uses its stable and nightly selector, Flash uses Ruffle's override, default and installed-version precedence, and Flash Player uses the selected universal projector package. A catalog lookup happens only during an explicit Play, and only when it is needed to identify the version; native-app choices stay local.

### Manager interface

Modules declare runtime managers in `runtimeManagers`, and only one manager is kept for each id. Shared submodules can also provide managers by exporting manager objects from `src/modules/shared/<submodule>/runtime/*.js`.

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

`runtime.managerUi[managerId].management` declares which download or automated build flows a manager supports. The Runtimes entries and the inspector's management links follow this metadata, and engine settings, per-game options, exact versions and backend actions remain available regardless. A manager with several backends can also declare `sectionManagement`; ONScripter-Yuri, for example, has native `mac` and `web` sections. Internal helpers that have no UI are kept apart from game-runtime choices.

`manifest.runtime.managerSectionOverrideKey` declares which manager section a module's per-game override selects in the inspector.

### Component declarations

The entries in **Runtimes → Tools → Downloaded files** come from component declarations. These are read from `src/core/components.js` and from an optional `components.js` in each module folder or shared submodule folder, which `registry.listComponents()` finds. Each file exports an array of declarations, and when two declarations share an id, the first one wins. A declaration has:

- `id`, `label` and `description`
- `list(context)`: the installed items, read from local files only
- `remove(item, context)`, optional: deletes one item
- `import`, optional: `{ matches(file, context), run(path, context) }`. **Add from file…** reads the chosen file once and passes `{ path, size, sha256 }` to each `matches`; the first declaration whose `matches` recognizes the file's recorded size and checksum runs `run`, which checks the file again while installing it and throws a plain reason when it differs
- `cache`, optional: `true` for data the launcher recreates
- `refresh(context)`: required when the component's versions come from a catalog. Refresh calls it on an explicit click; it reads the catalog, downloads nothing and returns a plain message, which the tab shows

An item is `{ id, version, identity, architecture, windows, path, source, users, status, removable, removeReason }`. `windows: true` marks Windows code, whose CPU is named as Windows names it. `source` is `{ url }`, `{ label }` or `"manual"`, `users` names the runtimes or games that load the item, and `removable: false` with `removeReason` keeps an item that is still required. The context holds `userDataDir`, `settings`, `logger`, `signal`, `runtimeAction(managerId, action, payload)`, `runtimeLabel(id)`, which names a runtime as **Runtimes** does, `confirmRuntimeInstall` and `downloads`. The launcher itself provides the sizes on disk, **Show in Finder** and the file chooser. When a component's `remove` puts trash outside an existing store, the component declares that folder with `match: TRASH` in its module's `derived-stores.js`.

`src/modules/shared/runtime/runtime-components.js` provides the common forms: `fromRuntimeManager(manager, { windows })` lists a manager's installed versions with their CPU builds, deletes one through the manager's uninstall action and installs a matching local archive through the manager's install action; `cacheComponent` describes one cache folder; `removeOwned` deletes one item inside its store. The `installRuntime` of a versioned native manager (`pinned-native-manager.js`) accepts `archiveFile`, a local copy of the release archive that is used in place of the download and must match the release's recorded SHA-256. No runtime manager is declared as a component, because every registry runtime manager already has a tab of its own in **Runtimes**, with Refresh and removal.

### Pre-launch checks

Modules can define readiness checks for each runtime in `manifest.runtime.preLaunch[<runtimeId>]`, for example to require patching or setup before the game launches:

- `statusAction` is called to check readiness.
- `readyWhen` lists the conditions that must be met.
- `fixAction` is called when the user accepts the prompt.
- `declineAction` (optional) is called when the user declines the prompt.

### Launch integration

- The hosted Electron runtime and the NW.js runtimes are described under [web runtimes](WEB_RUNTIMES.md#implementation).
- The native runtime uses `nativeAppPath` or module-specific resolution.
- Module `launchRuntime` handlers launch custom runtimes, such as Java (`java`), Ren'Py (`sdk` and `patched`) and NScripter (`onsyuri_*`).

### Concurrent runtime use

Installations, imports, setup and installed-library actions can all change the same files, so the shared Node coordinator runs them one at a time. An installer that has waited for another worker reuses a ready installation of the exact version. While the target of a setup or import is still unknown during inspection, it locks the whole manager. Uninstall finds its directory from the manager's installed rows and never touches included resources.

Running games are protected by leases. Each active game holds a lease on the runtimes it uses, and a leased runtime cannot be changed or removed. The lease names the version that the module actually selected rather than its manager's defaults. For this reason, a module that prepares a private runtime context reports the shared source before preparing it, with `await context.useRuntime({ managerId, version, sourcePath })`, adding `sectionId` and `variant` when needed. The checked spawn adapter also compares the actual executable and file arguments with the declared primary and prerequisite runtime files.

Settings changes are merged field by field through one host writer. Downloads and independent managers each have their own queues. Module actions that modify shared assets use `context.withRuntimeMutation({ managerId }, async () => { ... })`, which covers every version of that manager. [Backend coordination](../development/BACKEND.md#shared-runtime-coordination) describes Node injection and process lifetime.

Installed versions remain in the version menu even when the catalog no longer lists them. Windows Steam client files select a usable local copy before offering a download. Their labels use Valve’s recorded version, or the DLL build for legacy copies; these version schemes are not compared. The source card uses the Versions heading and names Valve CDN once. Windows PE components carry no Mac CPU badge. Opening Runtimes at a manager reveals its sidebar entry. The Apex Neural Rendering provider lists installed model releases when the installed graphics package includes its generation runtime; otherwise its description states that the runtime is absent.

Graphics editor input discovery waits for an overlapping Forget operation. If Forget removes the game, pending discovery and template reads return no result.
