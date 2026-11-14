# MacLauncher guide

This guide is the reference for MacLauncher, a macOS app that imports games made with many different engines, for several platforms, and plays each one with a matching Mac runtime. Its pages specify every feature, setting, input and limit. They assume familiarity with the engines, stores, Wine distributions and graphics translators involved, which the [MacLauncher website](https://procrastinine.github.io/maclauncher/) introduces.

MacLauncher has three roles, and the guide follows them. As a native runtime system, it detects a game's engine and runs the game with a Mac runtime for that engine. On top of every runtime, its graphics and effects layer processes the frames with shaders, upscaling, neural models and frame generation. As a patch and tinker tool, it exposes the version of every component, the settings and launch options of every runtime, and tools for game files and saves. Each section below introduces one role and links the pages that specify it, and a final section covers development.

The macOS versions, CPU architectures and graphics requirements of the app and of each runtime, tool and effect are listed in [System requirements](runtimes/SYSTEM_REQUIREMENTS.md).

## Native runtime system

### Adding and playing games

Games are added to the library by drag and drop, with **File → Open…** (Cmd-O) or with Finder's **Open With → MacLauncher**. Import accepts a game folder, a main executable or a supported package, and when an executable is chosen, the archives, scripts and assets beside it count as part of the game. [Detection](library/DETECTION.md) then assigns the game its game type, and the inspector shows the detected engine and version.

A game type is a game format that MacLauncher recognizes, such as Ren'Py, Unity or Android. To play a game of that type, MacLauncher uses a runtime, which is an engine, player or compatibility layer for the format. Each game type has a default runtime and often others, so a Ren'Py game, for example, can run in the Ren'Py SDK, through Ren'Py Patch or as the game's own Mac app. Mac apps, launcher scripts and executables without a recognized engine are imported as [macOS Game](game-types/MACOS.md) entries, and apps with an i386-only executable use the [32-bit Mac](game-types/MACOS.md#32-bit-mac) runtime. Windows executables without a recognized engine become [Windows Game](game-types/WINDOWS.md) entries.

Selecting a game opens its inspector, and selecting it again returns to the library. **Play** starts the game with the selected runtime; if the required version is not installed, Play asks before downloading it and then continues. Preparation is automatic. When the runtime supports a game's layout, Play uses the original game folder directly, and when an engine cannot use an input in place, MacLauncher prepares only the adaptation that the engine needs and keeps it apart from the original game. The engine keeps its usual save and configuration locations unless a save-folder override is chosen for the game. The layout for each game type is described in [Game preparation and storage](library/GAME_PREPARATION.md).

A game whose files are on a disconnected drive or in a moved or renamed folder shows as **Unavailable**, and everything MacLauncher stored for it is kept. Reconnecting the drive makes it available again, while [**Locate…**](library/GAME_PREPARATION.md#locating-moved-files) in the inspector points the entry to the files' new location.

### Runtimes and versions

Runtime versions are chosen in a fixed order: first the version chosen for the game, then the version that the game's detected format recommends, and then the runtime's default. A compatible installed version is used before another one is downloaded. Installed versions are shared between games and work offline, while saves, accounts and writable game data stay separate for each game. The game's own version and the generation of its archives or bytecode are recorded apart from the runtime version.

The **Runtimes** window installs, removes and refreshes runtime versions and sets their defaults. Each runtime manager, the part of MacLauncher that lists, downloads and installs the versions of one runtime or tool, has its own tab there. Runtimes that need changes to work on macOS come from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds), a companion repository that publishes compiled builds of them with MacLauncher's patches and keeps their version history. Its [package index](https://procrastinine.github.io/maclauncher-builds/) lists every package with its latest version, and each package's own page lists its published versions and what changed in each. The other runtimes come from their publishers. The app itself includes only the core graphics component and the internal helpers for importing, extracting and integrating games, as [runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md) describes.

A game of another type that includes a compatible Windows executable can also use the three [Wine runtimes](runtimes/WINE.md), [Sikarugir](runtimes/SIKARUGIR.md), [CrossOver](runtimes/CROSSOVER.md) and [WineCX](runtimes/WINECX.md), although known engines keep their native default. Sikarugir and WineCX are free Wine distributions that MacLauncher downloads itself, whereas CrossOver runs from a licensed CrossOver application that is already installed on the Mac.

**Settings**, **Runtimes**, **External** and **Credits** each open in a single nonmodal macOS window. Settings, Runtimes and Credits stay open together when opened in quick succession, and reopening a view focuses its existing window. Controls and data load asynchronously, so the library stays usable. Changes appear in every open window, and the native close controls or Cmd-W close the focused window. Every window, menu and shortcut is described in the [launcher UI guide](development/UI_GUIDE.md).

### Native runtime references

- [Game types](game-types/README.md): every game type with its default and other runtimes, and the runtimes that several game types share.
- Game-type pages, one for each game type, with its detection, runtimes, settings, saves and tools: [AI5WIN](game-types/AI5.md), [AliceSoft](game-types/ALICESOFT.md), [Android](game-types/ANDROID.md), [BGI / Ethornell](game-types/BGI.md), [Build engine (Raze)](game-types/BUILD_ENGINE.md), [CatSystem2](game-types/CATSYSTEM2.md), [Construct](game-types/CONSTRUCT.md), [DOS](game-types/DOS.md), [Doom engine (UZDoom)](game-types/DOOM_ENGINE.md), [FAVORITE / FVP](game-types/FVP.md), [Flash](game-types/FLASH.md), [FNA / XNA 4](game-types/FNA.md), [GameMaker](game-types/GAMEMAKER.md), [GameMaker HTML5](game-types/GAMEMAKER_HTML5.md), [Godot](game-types/GODOT.md), [Half-Life (Xash3D FWGS)](game-types/HALF_LIFE.md), [HashLink (Haxe bytecode)](game-types/HASHLINK.md), [Haxe native build](game-types/HAXE.md), [Infinity Engine (GemRB)](game-types/INFINITY_ENGINE.md), [iOS / iPadOS](game-types/IOS.md), [Java](game-types/JAVA.md), [KiriKiri](game-types/KIRIKIRI.md), [LÖVE](game-types/LOVE.md), [LucasArts (DREAMM)](game-types/DREAMM.md), [macOS Game](game-types/MACOS.md), [MAGES.](game-types/MAGES.md), [Minori](game-types/MINORI.md), [MUGEN / Ikemen GO](game-types/MUGEN.md), [Nintendo Switch](game-types/SWITCH.md), [Nitroplus](game-types/NITROPLUS.md), [NScripter](game-types/NSCRIPTER.md), [PlayStation 5](game-types/PS5.md), [Ren'Py](game-types/RENPY.md), [RPG Maker 2000/2003](game-types/RPGMAKER_2000_2003.md), [RPG Maker MV and MZ](game-types/RPGMAKER_MV_MZ.md), [RPG Maker XP/VX/VX Ace](game-types/RPGMAKER_XP_VX.md), [ScummVM](game-types/SCUMMVM.md), [Siglus / RealLive](game-types/SIGLUS.md), [Tyrano](game-types/TYRANO.md), [Unity](game-types/UNITY.md), [Video](game-types/VIDEO.md), [VNDS](game-types/VNDS.md), [Web](game-types/WEB.md), [Window](game-types/WINDOW.md), [Windows Game](game-types/WINDOWS.md) and [WOLF RPG Editor](game-types/WOLFRPG.md).
- [Android runtime architecture](game-types/android/ARCHITECTURE.md) and [Android native code](game-types/android/NATIVE_CODE.md): how MacLauncher Android's JVM and ART engines run applications, and how their ARM64 and ARM32 native libraries load on macOS.
- [Runtime system](runtimes/README.md): downloads and offline use, runtime selection, versions, runtime managers, the Runtimes window, per-game overrides, runtime settings and launch.
- [Web runtimes](runtimes/WEB_RUNTIMES.md): Electron and NW.js, including Greenworks.
- [Wine runtimes](runtimes/WINE.md), [Sikarugir](runtimes/SIKARUGIR.md), [CrossOver](runtimes/CROSSOVER.md) and [WineCX](runtimes/WINECX.md): the Windows runtimes, their versions, environments and settings.
- [Rosetta](runtimes/ROSETTA.md): installing Apple's Intel translation for Intel runtimes on Apple Silicon.
- [Game detection](library/DETECTION.md): how an imported file or folder is scanned, which engine it is assigned and how its version is found.
- [Game preparation and storage](library/GAME_PREPARATION.md): original game paths, private adaptations, unavailable games, locating moved files and removing games.
- [Game icons](library/GAME_ICONS.md): where each library entry's icon is read from and how it is cached.
- [App updates](UPDATES.md): **Check for Updates…**, how a new version is chosen and verified, and how it replaces the app.
- [Launcher UI guide](development/UI_GUIDE.md): the library, the inspector, the separate windows, menus and shortcuts.

## Graphics and effects layer

MacLauncher's graphics layer processes the frames of every runtime on Metal. A single graphics chain can combine shaders, spatial and temporal upscaling, neural restoration and frame generation in any order, and its steps can change while the game runs. Throughout, the game keeps its own window and fullscreen behavior. Besides the included effects, a chain accepts local ReShade `.fx`, RetroArch `.slangp` and `.slang`, and mpv or libplacebo `.glsl` and `.hook` shaders, each with editable parameters. Downloadable shader collections and neural models are installed from **Runtimes → Effects**, and **Settings → Graphics** holds the shader library and the saved presets.

The inspector's Graphics tab has two views of the same chain. **Simple** chooses a shader, a scaling method and frame generation from menus, while **Advanced** adds and reorders individual steps, each with its own settings and bypass control. Ordinary image effects work on the finished frame of any runtime. Temporal upscalers and some depth and lighting effects also need the game's depth, motion and camera data, which MacLauncher's renderer integrations supply wherever a runtime exposes them. When a Windows game in CrossOver, Sikarugir or WineCX calls DLSS, MacLauncher's temporal upscalers carry out its Super Resolution evaluations.

The same chain also applies to video playback, including processed video exports. With **File → Apply Graphics…**, it can be applied to the windows of other running apps or to a whole display on macOS 15.2 or later, and each window or display gets a chain of its own.

- [Graphics and effects](graphics/README.md): the graphics chain, the shader library, processing sizes, neural models, frame generation, output controls, the performance overlay and shortcuts.
- [Graphics providers](graphics/PROVIDERS.md): every upscaler, frame generator, neural method and image or scene effect, with its inputs.
- [Graphics pipeline](graphics/PIPELINE.md): how the shared graphics layer is built, with a map of its code.
- [Renderer integrations](graphics/SHARED_PROCESSING.md): frame adapters, scene depth and temporal inputs for Godot and the Wine runtimes.
- [Frame sources and adapters](graphics/INPUTS_AND_ADAPTERS.md), including [DLSS through Vulkan translators](graphics/INPUTS_AND_ADAPTERS.md#dlss-through-vulkan-translators): how games' frames and DLSS inputs reach the chain.
- [Neural models and packages](graphics/NEURAL_RESTORATION.md): neural restoration models and how they are imported.
- Pipeline references for developers:
  - [Effects plans](graphics/EFFECT_PLANS.md): how a game's graphics settings are saved and edited.
  - [Frame APIs](graphics/FRAME_API.md): the native interfaces through which runtimes and engine adapters hand frames to the graphics processor.
  - [Live updates](graphics/LIVE_UPDATES.md): how changed settings reach a game at launch and while it runs.
  - [Shaders and media](graphics/SHADERS_AND_MEDIA.md): how shader formats, neural model files and video files connect to the effect graph.
  - [Status and delivery](graphics/STATUS_AND_DELIVERY.md): how a running game reports its graphics processing and which processor version it loads.
- [Window](game-types/WINDOW.md): graphics on other apps' windows and on displays, with capture permissions, output placement, scaling and saved chains.
- [Video](game-types/VIDEO.md): mpv playback with playlists, subtitles and plugins, and processed video exports.

## Patch and tinker tool

### Principles

Three principles shape the controls that MacLauncher exposes.

The first is version choice. Every runtime, graphics translator and Vulkan driver has selectable versions, and so do the editions of games downloaded from stores. A version can come from a catalog or from local files. MacLauncher picks a default, and each game can keep its own exact choice, which stays in place when other versions are installed. The selection rules are given under [runtime versions](runtimes/README.md#versions) and [store versions](library/EXTERNAL.md#versions).

The second principle is that games, and the applications MacLauncher builds on, stay unchanged. Play runs original game files in place, and the few tools that write into a game folder keep track of their files and remove them again on request, as described under [original files and private files](library/GAME_PREPARATION.md#original-files-and-private-files). In the same way, translators chosen for a Windows game are stored outside CrossOver and the Sikarugir Templates, which are never modified, and the Steam client bridge leaves the Steam client unmodified.

The third is that every control a runtime or game type allows is available to the user: game-type and runtime settings, launch arguments, translator environment variables, and the decompilers, extractors and cheat tools available for each game type. Launcher data stays in local files, MacLauncher uses the network only after an explicit action, and it sends no telemetry, as [network access and files](#network-access-and-files) describes.

### Runtime patching

Windows games draw with Direct3D or Vulkan, which macOS does not provide, so the Wine runtimes (CrossOver, Sikarugir and WineCX) rely on graphics translators that carry those calls to Metal. Each Wine distribution brings its own set of translators. In MacLauncher, each game can instead choose a default Direct3D engine, a translator for each Direct3D version from 8 to 12, a Vulkan driver and video codecs. The choices include the copies in the selected Wine, upstream releases, MacLauncher Builds packages, locally registered files and the user's own copy of Apple's Game Porting Toolkit, and **Settings** holds the defaults for all games. Because the chosen versions are stored in MacLauncher's data, updating a Wine runtime leaves them and the games' choices in place. Each translator's options and environment variables can also be set per game, and the inspector names the translator, version and CPU build that a game used.

One of the Vulkan drivers is KosmicKrisp, a driver from the Mesa project that implements Vulkan 1.4 on Metal 4 on Apple Silicon. MacLauncher also offers an adapted build, MacLauncher KosmicKrisp, which adds the Vulkan features that DXVK, vkd3d-proton and ANGLE use. On this build, vkd3d-proton runs Direct3D 12 games in CrossOver, Sikarugir and WineCX at feature level 12_1 and shader model 6.8 in the default performance mode, and at feature level 12_2 and shader model 6.9 in conformance mode. When a game uses a DXVK or vkd3d-proton version from **Runtimes** and its Vulkan driver stays on **Automatic**, the game runs on MacLauncher KosmicKrisp.

MacLauncher KosmicKrisp detects the Mac's Apple GPU family and uses native Metal features wherever the family has them, emulating the rest in one of two modes. Performance, the default, turns off each emulation that no Direct3D shader model, feature level or translator startup depends on, while Conformance turns every emulation on. The mode, individual switches and chip presets are selected with the `KK_EMULATION` environment variable, globally or for one game.

- [Graphics translators](runtimes/TRANSLATORS.md): translators and drivers, versions and sources, per-game selection, loading, options, fallback and the inspector rows.
- [KosmicKrisp](runtimes/KOSMICKRISP.md): the driver and its MoltenVK comparison, MacLauncher KosmicKrisp's features, [Apple GPU families](runtimes/KOSMICKRISP.md#apple-gpu-families), [Performance and Conformance](runtimes/KOSMICKRISP.md#performance-and-conformance) and the `KK_EMULATION` syntax and chip presets.
- [CrossOver translators](runtimes/CROSSOVER.md#translators) and [Sikarugir translators](runtimes/SIKARUGIR.md#translators): how each Windows runtime loads the selected translators.
- [Release catalogs](runtimes/RUNTIME_CATALOGS.md): where version lists come from, including the [MacLauncher Builds catalogs](runtimes/RUNTIME_CATALOGS.md#maclauncher-builds-catalogs), and how they are refreshed and cached.
- [Runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md): downloaded and included components, the MacLauncher Builds package format and app assembly.
- [Custom runtime layouts](runtimes/CUSTOM_RUNTIME_LAYOUTS.md): the forms accepted for locally registered runtimes.
- [Native runtime and tool setup](runtimes/NATIVE_TOOL_SETUP.md): package sources, system components and decompilers.
- [GitHub metadata transport](runtimes/GITHUB_TRANSPORT.md): shared requests for GitHub release metadata, with caching and limits.

### Storefront integration

**External** is a separate window for store libraries. Its **Installed** tab lists Steam, Epic Games, GOG and itch.io games installed in common macOS and CrossOver locations, without network access, and imports them in batches. The store tabs browse account libraries for Steam, Epic, GOG, itch.io and Android, where Android covers Google Play, F-Droid and IzzyOnDroid. Games download into MacLauncher's download folder or a chosen folder, with the version or build, platform and language that the store supplies. A Steam download can be for any platform the publisher released, including Windows, Linux, Android and 32-bit Mac depots, and it can request an older build by its manifest ID. Several manual Steam sign-ins can be used alongside the account of the running Steam app for Mac, and Google accounts are shared with **Settings → Android**.

For Windows games in CrossOver, Sikarugir and WineCX, the Steam client bridge connects the game's own Steam API to the Steam client for Mac. Because the Mac client then answers account, ownership and ticket requests, the Windows Steam client does not need to run inside Wine. The bridge modifies neither the Steam client nor the Wine runtime nor the game.

- [External game libraries](library/EXTERNAL.md): importing games that stores already installed, and downloading games from Steam, Epic, GOG and itch.io, with their versions, platforms, duplicates and accounts.
- [Android app downloads](library/GOOGLE_PLAY.md): Google Play, [F-Droid and IzzyOnDroid](library/GOOGLE_PLAY.md#f-droid-and-izzyondroid), shared accounts, device profiles and exact APK versions.
- [Windows Steam games](runtimes/WINDOWS_STEAM.md): the Steam client bridge for the Wine runtimes.
- [Steam API support](runtimes/STEAM_API.md): starting the Steam client for native Steam games, and the offline Steam API helper.

### Saves, cheats and source tools

The game inspector holds the tools for a game's files: decompilation, extraction, inspection, patches and exports. Every game type with a known save location also has save tools, which **Saves** opens; for game types with save editing, the button reads **Edit saves**. With them, the save locations can be viewed, recovery snapshots taken and restored, and saves edited. RPG Maker and Ren'Py games also get cheats that work across games of their engine, and a cheat patch that places files in a game folder can be removed again with one action. Exports and backups are kept apart from the original files, and notes in the inspector belong to the selected game.

Each game-type page describes the tools and save formats of its game type, and the [module inventory](development/MODULES.md#modules-and-backends) lists them for every game type.

- [Inspector tools](tools/README.md): every inspector tool, output and limit by game type.
- [Save tools and snapshots](tools/SAVE_SNAPSHOTS.md): save files, recovery snapshots and how saves are protected while they are written.
- [Cheats](tools/CHEATS.md): the cheats window, the in-game Tools overlay and the engine-specific cheat menus and add-ons.
- [Native binary inspection](tools/NATIVE_INSPECTION.md): Rizin and Ghidra reports for native programs.
- [Installer reader](tools/INSTALLERS.md): importing games from Inno Setup installers without running them.

### Settings, launch flags and environment variables

**Settings** holds the defaults for each game type and runtime, and **Runtime Settings** in the inspector holds the overrides for one game. These runtime settings are the options that each runtime has, such as the display, input, compatibility and diagnostics controls of the Wine runtimes.

**Launch arguments** in the inspector stores extra startup arguments for a game and its saved `.command` launcher. Quotes keep spaces inside one argument, as in `--windowed --name "Example name"`, although shell commands, environment variables and wildcard patterns are not expanded. The arguments stay with the game when its runtime changes, and the adjacent `?` button explains the syntax.

Translators and their runtimes also read environment variables. Global values for them are kept in **Settings → Environment variables** and serve as the defaults of every game, while a game's Runtime Settings can change, add or remove variables for that game alone. Variables can be set for Wine and its graphics translators, for the Android execution engines with ANGLE and the Vulkan driver, and for the PlayStation 5 runtimes.

- [Settings reference](runtimes/SETTINGS_REFERENCE.md): every runtime, runtime setting and inspector action by game type.
- [Translator environment variables](runtimes/TRANSLATOR_ENVIRONMENT.md): global and per-game values, the editor, locked variables and the variables of each translator.

### Network access and files

MacLauncher reaches the network only after an explicit action: **Refresh** or **Install** in Runtimes, a download approved during Play or an inspector action, a sign-in or store action in External or Settings, or **Check for Updates…**, which also runs at launch once **Check for updates at launch** is turned on. Opening a window, detection, runtime status and runtime selection read only local state, and installed runtimes keep working offline. MacLauncher sends no telemetry. Its diagnostics go to log files on the Mac, and **Help → Show Log in Finder** reveals the launcher's own log.

Each game's inspector also has a **Network access** checkbox that controls the game's Internet and local-network access in every runtime. Newly imported games take the default from **Settings → Launcher**, which is off.

By default, launcher data is stored in `~/Library/Application Support/maclauncher/`. Its `runtimes/` folder holds the installed runtime and tool versions shared by all games, and `games/<game-id>/` holds each game's library metadata, notes, private runtime files, logs, exports and any private saves. Other saves stay in the engine's usual locations, such as the `~/Library/RenPy/` save directory that a Ren'Py game configures. Forgetting a game removes the launcher data that belongs to it and leaves the original files and external save locations untouched.

- [Downloads and offline use](runtimes/README.md#downloads-and-offline-use): when MacLauncher downloads runtimes, tools and version lists.
- [Network access and isolation](runtimes/NETWORK_ISOLATION.md): MacLauncher's own network use and logs, and per-game network isolation.
- [Game preparation and storage](library/GAME_PREPARATION.md): storage locations, original and private files, installer extraction and removing games.
- [Data model](development/DATA_MODEL.md): settings, runtime installations, per-game files, logs and the cleanup of data the launcher can rebuild.

## Development

The backend that detects, prepares and launches games also runs without the launcher window, from the command line:

```sh
pnpm launch --game /path/to/game --inspect
pnpm launch --game /path/to/game --wait
pnpm launch --game /path/to/game --action <action-id>
```

- [Repository guide](development/REPO_GUIDE.md): the starting point for contributors, with the architecture and the page that documents each part.
- [Module system](development/MODULES.md): how a module adds a game type, with its manifest fields, hooks and runtime managers.
- [Shared backend and CLI](development/BACKEND.md): the `pnpm launch` command line, the Node API and the services shared by every caller.
- [Data model](development/DATA_MODEL.md): the layout of `userData`, `settings.json`, per-game records and runtime settings.
- [Launcher UI guide](development/UI_GUIDE.md): every window and control and the module metadata each one follows.
- [UI styles](development/UI_STYLES.md): where the launcher's styles, components and module-defined controls live in the source.
- [Development](development/DEVELOPMENT.md): source setup, tests and packaging.
- [macOS app builds](development/CI.md): the GitHub Actions workflow that builds the Apple Silicon and Intel apps.
- [Releases](development/RELEASING.md): the three repositories, the version model and what a release contains.
- [Build verification](development/VERIFYING.md): checking where a release archive came from and rebuilding it.
- [App, game and engine icons](development/ICON_ASSETS.md): the icon artwork that ships with MacLauncher and its sources.
- [Upstream sources and adaptations](runtimes/UPSTREAMS.md): the exact upstream commits, MacLauncher's changes to them and update checks.

## Credits and release notes

[Attributions](ATTRIBUTIONS.md) links the upstream projects and their licenses. In the app, **Credits → Game port resources** also links [Awesome Decomp Games](https://github.com/SubmitGame/awesome-decomp-games), a community index of source ports, decompilations and engine remakes.

The release notes list the features and fixes of each version: [0.3.0](releases/0.3.0.md), [0.3.1](releases/0.3.1.md), [0.6.0](releases/0.6.0.md), [0.7.0](releases/0.7.0.md) and [0.7.1](releases/0.7.1.md).
