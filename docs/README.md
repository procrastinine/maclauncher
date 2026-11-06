# MacLauncher guide

MacLauncher plays games on macOS through native Mac engines and compatibility runtimes. It runs browser games, macOS applications, Android and iOS packages, and Windows and Linux game data with native engines, and Windows executables with Sikarugir (Wine) or CrossOver. Besides playing games, MacLauncher manages runtime versions, graphics effects, store downloads, and tools for game files and saves.

This page is an overview. The [reference index](#reference-index) at the end lists every documentation page.

[System requirements](runtimes/SYSTEM_REQUIREMENTS.md) lists macOS, CPU and graphics requirements for the launcher, runtimes, tools and effects.

## Add and play

Games are added to the library by drag and drop, with **File → Open…** (Cmd-O) or with Finder's **Open With → MacLauncher**. Import accepts a game folder, a main executable or a supported package; when an executable is chosen, the archives, scripts and assets beside it are part of the game. [Detection](library/DETECTION.md) then assigns the game its [game type](game-types/README.md), and the inspector shows the detected engine and version.

Selecting a game opens its inspector, and selecting it again returns to the library. **Play** starts the game with the selected runtime. If the required version is not installed, Play asks before downloading it and then continues.

Preparation is automatic. When the runtime supports a game's layout, Play uses the original game folder directly; for input that an engine cannot use in place, MacLauncher prepares only the adaptation that the engine needs and keeps it apart from the original game. The engine keeps its usual save and configuration locations unless a save-folder override is chosen for the game. [Game preparation and storage](library/GAME_PREPARATION.md) describes the layout for each game type.

Mac apps, launcher scripts and executables without a recognized engine import as [macOS Game](game-types/MACOS.md) entries, and apps with an i386-only executable use the [32-bit Mac](game-types/MACOS.md#32-bit-mac) runtime. Windows executables without a recognized engine import as [Windows Game](game-types/WINDOWS.md) entries.

## Game types and runtimes

A game type is a game format that MacLauncher recognizes, such as Ren'Py, Unity or Android. A runtime is one way to play a game type: an engine, player or host. Each game type has a default runtime and often others. Ren'Py games, for example, can run in the Ren'Py SDK, through Ren'Py Patch or as the game's own Mac app. The [game types](game-types/README.md) page lists every game type with its runtimes, and each game-type page describes its formats, settings, tools and runtimes.

To pick a runtime version, MacLauncher uses the version chosen for the game, then the version that its detected format recommends, and then the default. Runtime versions, the game's own version and archive or bytecode generations are recorded separately. Games of other types that include a compatible Windows executable also offer [Sikarugir (Wine)](runtimes/SIKARUGIR.md) and [CrossOver](runtimes/CROSSOVER.md), while known engines keep their usual default. The [runtime system](runtimes/README.md) describes selection, versions and runtime managers.

## Runtimes and settings

**Settings**, **Runtimes**, **External** and **Credits** open in separate macOS windows, and reopening a view focuses its existing window. The library stays usable, changes appear in every window, and the native close controls or Cmd-W close the focused window.

**Runtimes** manages runtime and tool downloads, local registrations, versions and removal. Runtimes that need changes to work on macOS come from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds), a companion repository that provides compiled builds of them with their version history and MacLauncher's patches; the others come from their publishers. Each source has its own version list and refresh control, and every installed version that the Mac can run is available in the game inspector. MacLauncher downloads only when asked, and installed versions work offline; [Downloads and offline use](runtimes/README.md#downloads-and-offline-use) gives the rules.

The app itself includes the core graphics component and internal helpers for importing, extracting and integrating games. For every package, the release catalogs that list its versions also record its CPU architecture and minimum macOS version. [Runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md) describes where each runtime comes from.

**Settings** holds the defaults for each game type, and **Runtime Settings** in the inspector holds the overrides for one game. The [settings reference](runtimes/SETTINGS_REFERENCE.md) lists every runtime, runtime setting and inspector action by game type.

**Launch arguments** in the inspector stores extra startup arguments for a game and its saved `.command` launcher. Quotes keep spaces inside one argument, as in `--windowed --name "Example name"`. Shell commands, environment variables and wildcard patterns are not expanded. The arguments stay with the game when its runtime changes, and the adjacent `?` button explains the syntax.

**Network access** in the inspector controls whether a game can reach the Internet and the local network, for every runtime. A change applies on the game's next launch. [Network isolation](runtimes/NETWORK_ISOLATION.md) describes the restrictions.

## Store libraries and downloads

[External](library/EXTERNAL.md) collects locally installed Steam, Epic, GOG and itch.io games for offline discovery and batch import. Its store tabs browse account libraries and download games into MacLauncher's download folder or a custom folder, with a choice of game version, platform and language. Importing after a download is optional and on by default.

[Android app downloads](library/GOOGLE_PLAY.md) covers Google Play, F-Droid and IzzyOnDroid, shared account selection, device profiles and APK versions.

## Graphics and effects

Shared graphics controls add shaders, upscaling, neural reconstruction and frame generation to game runtimes and video playback. Custom effects can come from local ReShade `.fx`, RetroArch `.slangp`/`.slang` and mpv/libplacebo `.glsl`/`.hook` shaders, with editable parameters. Downloadable shader collections are available from **Runtimes → Effects → Shaders**.

The **Simple** controls choose a shader, a scaling method and frame generation. **Advanced…** combines effects in any order, each with its own settings and bypass control, and saves reusable presets. Effects can change while the game runs, and the game keeps its window and fullscreen behavior. The [graphics guide](graphics/README.md) describes the methods and the extra frame inputs that temporal effects and video-plane shaders use.

## Saves, cheats and source tools

The game inspector holds the tools for a game's files: decompilation, extraction, inspection, patches and exports. **Saves**, labelled **Edit saves** for game types with save editing, opens the save tools: save locations, recovery snapshots and the save editor. Exports and backups are kept apart from the original files. Notes in the inspector belong to the selected game.

Each game-type page describes the tools and save formats of its game type, and [game inspection and source tools](tools/README.md) lists every tool, output and limit by game type. [Save snapshots](tools/SAVE_SNAPSHOTS.md) and [cheats](tools/CHEATS.md) describe the shared save recovery and cheat systems.

## Files and headless use

Launcher data is stored in `~/Library/Application Support/maclauncher/` by default:

- `runtimes/` holds the installed runtime and tool versions, shared by all games.
- `games/<game-id>/` holds each game's library metadata, notes, private runtime files, exports and any private saves.

Other saves stay in the engine's usual locations, such as the `~/Library/RenPy/` save directory that a Ren'Py game configures, and explicit save-directory overrides are available. Forgetting a game removes the launcher data that belongs to it; original files and external save locations are not touched.

The same backend runs without the launcher window:

```sh
pnpm launch --game /path/to/game --inspect
pnpm launch --game /path/to/game --wait
pnpm launch --game /path/to/game --action <action-id>
```

[Backend and CLI](development/BACKEND.md) describes host requirements and module actions, [development](development/DEVELOPMENT.md) covers source setup, tests and packaging, and the [repository guide](development/REPO_GUIDE.md) indexes the architecture and technical contracts.

## Updates

**Check for Updates…** in the app menu and in **Settings → Launcher** looks for a newer MacLauncher release on GitHub. The new version built for the running app's CPU is downloaded, checked against its published SHA-256 and code signature, and installed when MacLauncher restarts; the previous version moves to the Trash. **Check for updates at launch**, off by default, runs the same check at each start. [App updates](UPDATES.md) describes the checks and the cases in which the release page is offered instead.

## Credits and attributions

[Attributions](ATTRIBUTIONS.md) links the upstream projects and their licenses. **Credits → Game port resources** in the app also links [Awesome Decomp Games](https://github.com/SubmitGame/awesome-decomp-games), a community index of source ports, decompilations and engine remakes.

## Reference index

### Game types

- [Game types](game-types/README.md): every game type with its default and other runtimes, and the runtimes that several game types share.
- Game-type pages: [AI5WIN](game-types/AI5.md), [AliceSoft](game-types/ALICESOFT.md), [Android](game-types/ANDROID.md) (with its [runtime architecture](game-types/android/ARCHITECTURE.md)), [BGI / Ethornell](game-types/BGI.md), [CatSystem2](game-types/CATSYSTEM2.md), [Construct](game-types/CONSTRUCT.md), [DOS](game-types/DOS.md), [FAVORITE / FVP](game-types/FVP.md), [Flash](game-types/FLASH.md), [FNA / XNA 4](game-types/FNA.md), [GameMaker](game-types/GAMEMAKER.md), [GameMaker HTML5](game-types/GAMEMAKER_HTML5.md), [Godot](game-types/GODOT.md), [Half-Life (Xash3D FWGS)](game-types/HALF_LIFE.md), [HashLink (Haxe bytecode)](game-types/HASHLINK.md), [Haxe native build](game-types/HAXE.md), [Infinity Engine (GemRB)](game-types/INFINITY_ENGINE.md), [iOS / iPadOS](game-types/IOS.md), [Java](game-types/JAVA.md), [KiriKiri](game-types/KIRIKIRI.md), [LÖVE](game-types/LOVE.md), [macOS Game](game-types/MACOS.md), [MAGES.](game-types/MAGES.md), [Minori](game-types/MINORI.md), [MUGEN / Ikemen GO](game-types/MUGEN.md), [Nintendo Switch](game-types/SWITCH.md), [Nitroplus](game-types/NITROPLUS.md), [NScripter](game-types/NSCRIPTER.md), [PlayStation 5](game-types/PS5.md), [Ren'Py](game-types/RENPY.md), [RPG Maker 2000/2003](game-types/RPGMAKER_2000_2003.md), [RPG Maker MV and MZ](game-types/RPGMAKER_MV_MZ.md), [RPG Maker XP/VX/VX Ace](game-types/RPGMAKER_XP_VX.md), [ScummVM](game-types/SCUMMVM.md), [Siglus / RealLive](game-types/SIGLUS.md), [Tyrano](game-types/TYRANO.md), [Unity](game-types/UNITY.md), [Video](game-types/VIDEO.md), [VNDS](game-types/VNDS.md), [Web](game-types/WEB.md), [Windows Game](game-types/WINDOWS.md) and [WOLF RPG Editor](game-types/WOLFRPG.md).

### Runtimes

- [Runtime system](runtimes/README.md): downloads and offline use, runtime selection, versions, runtime managers, per-game overrides, runtime settings and launch.
- [Settings reference](runtimes/SETTINGS_REFERENCE.md): every runtime, runtime setting and inspector action by game type.
- [Web runtimes](runtimes/WEB_RUNTIMES.md): Electron and NW.js, including Greenworks.
- [Sikarugir (Wine)](runtimes/SIKARUGIR.md) and [CrossOver](runtimes/CROSSOVER.md): the Windows runtimes.
- [Graphics translators](runtimes/TRANSLATORS.md): the libraries, shared by CrossOver and Sikarugir, that carry a Windows game's Direct3D and Vulkan calls to Metal.
- [Translator environment variables](runtimes/TRANSLATOR_ENVIRONMENT.md): global and per-game environment variables for every runtime with a translator choice.
- [Release catalogs](runtimes/RUNTIME_CATALOGS.md): where version lists come from, and how refresh and caching work.
- [Runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md): downloaded and included components, the MacLauncher Builds catalog format and app assembly.
- [Native runtime and tool setup](runtimes/NATIVE_TOOL_SETUP.md): package sources, system components and decompilers.
- [Custom runtime layouts](runtimes/CUSTOM_RUNTIME_LAYOUTS.md): the forms accepted for locally registered runtimes.
- [GitHub metadata transport](runtimes/GITHUB_TRANSPORT.md): shared requests for GitHub release metadata, with caching and limits.
- [Rosetta](runtimes/ROSETTA.md): installing Apple's Intel translation for Intel runtimes on Apple silicon.
- [Network isolation](runtimes/NETWORK_ISOLATION.md): per-game Internet and local-network blocking.
- [Steam API support](runtimes/STEAM_API.md): Steam client startup, the offline Steam API helper and consumer profiles.
- [Upstream sources and adaptations](runtimes/UPSTREAMS.md): the exact upstream commits, MacLauncher's changes to them and update checks.

### Tools

- [Game inspection and source tools](tools/README.md): every inspector tool, output and limit by game type.
- [Save snapshots](tools/SAVE_SNAPSHOTS.md): recovery snapshots and save write transactions.
- [Cheats](tools/CHEATS.md): the module-driven cheat system.
- [Native binary inspection](tools/NATIVE_INSPECTION.md): Rizin and Ghidra exports for native programs.
- [Installer reader](tools/INSTALLERS.md): offline imports from Inno Setup installers.

### Library

- [Game detection](library/DETECTION.md): import scanning, engine detection and version evidence.
- [Game preparation and storage](library/GAME_PREPARATION.md): original-file handling and private per-game layouts.
- [Game icons](library/GAME_ICONS.md): artwork extraction for library entries.
- [External game libraries](library/EXTERNAL.md): installed Steam, Epic, GOG and itch.io games, store tabs and downloads.
- [Android app downloads](library/GOOGLE_PLAY.md): Google Play, F-Droid and IzzyOnDroid accounts, device profiles and APK versions.

### Graphics

- [Graphics and effects](graphics/README.md): the graphics guide.
- [Graphics pipeline](graphics/PIPELINE.md): architecture overview and code map.
- [Renderer integrations](graphics/SHARED_PROCESSING.md): frame adapters, scene depth and temporal inputs for Godot, CrossOver and Sikarugir.
- [Neural models and packages](graphics/NEURAL_RESTORATION.md): neural restoration models and how they are imported.
- Pipeline references: [effects plans](graphics/EFFECT_PLANS.md), [frame APIs](graphics/FRAME_API.md), [frame sources and adapters](graphics/INPUTS_AND_ADAPTERS.md), [live updates](graphics/LIVE_UPDATES.md), [providers](graphics/PROVIDERS.md), [shaders and media](graphics/SHADERS_AND_MEDIA.md) and [status and delivery](graphics/STATUS_AND_DELIVERY.md).

### Development

- [Repository guide](development/REPO_GUIDE.md), [module system](development/MODULES.md), [shared backend](development/BACKEND.md) and [data model](development/DATA_MODEL.md).
- [Launcher UI guide](development/UI_GUIDE.md) and [UI styles](development/UI_STYLES.md).
- [Development](development/DEVELOPMENT.md), [macOS app builds](development/CI.md), [releases](development/RELEASING.md) and [app, game and engine icons](development/ICON_ASSETS.md).

### Project

- [App updates](UPDATES.md): Check for Updates, how a new version is chosen and verified, and how it replaces the app.
- [Attributions](ATTRIBUTIONS.md): upstream projects and their licenses.
- [Release notes](releases/): changes in each MacLauncher version.
