# Windows Game

This game type covers Windows games with no recognized engine, that is, an x86 or x64 Windows executable that no other game type claims. MacLauncher plays these games through Wine, with either of two Windows compatibility runtimes: [Sikarugir (Wine)](../runtimes/SIKARUGIR.md), the default, or a locally installed [CrossOver](../runtimes/CROSSOVER.md) application. Both runtimes also serve games of other types that include a compatible Windows executable, as [Windows executables in other game types](#windows-executables-in-other-game-types) describes. The game type's module is `crossover`.

Beyond running Wine, MacLauncher prepares a private Windows environment for each game, can use an existing CrossOver bottle or Sikarugir wrapper instead, and lets each game choose its own [graphics translators](../runtimes/TRANSLATORS.md).

## Accepted inputs

Import accepts a Windows `.exe` file or a game folder. Detection checks the executable's headers rather than its file name: the file must have a valid PE signature, executable-image flags, an optional header and a Windows GUI or console subsystem. x86 and x64 executables can be played. DOS programs, DLLs, Windows ARM64 executables and installers that need a further installation step, however, are outside playback support.

Library titles preserve a user-set name first. Automatic Windows titles use the game name from a completed Steam download receipt or a matching app manifest, then the install folder without MacLauncher's Windows download suffix. A `steam_appid.txt` can identify a title already cached in the launcher profile; naming never fetches it. In shared folders such as Downloads, the executable's `ProductName` and `FileDescription` are fallbacks, followed by its file name. Unreal shipping layouts use the install folder rather than the engine's project name. This precedence also applies to game modules that read titles from PE metadata. Other engines detected from a Windows executable, such as an RPG Maker `Game.exe` or a packed Tyrano or Godot executable, keep the title from their own game data. An existing automatic name is refreshed on the next scan; a user-set name is kept.

A folder is imported when its top level contains one valid Windows executable. Uninstallers, installers, setup programs, updaters, redistributables, crash reporters and bundled tools such as a DOSBox build never identify a Windows game, and such a program becomes the game only when it is imported directly. Configuration tools, launchers and similar helpers rank below a game executable and do not compete with it. If several executables of equal rank remain, import asks for one `.exe` to be selected directly. Subfolders are not searched, and a folder with too many entries also needs its executable selected directly.

Windows Game is the last fallback in detection. It applies only after every recognized format, [web content](WEB.md) and the [macOS Game](MACOS.md) check have failed to match. Native macOS app imports and Linux-only exports never become Windows games, and an unrelated Windows executable next to them does not change their format.

## Windows executables in other game types

Sikarugir and CrossOver also run games of other types. A game detected as another engine keeps its detected engine, version, inspection and engine tools, and when its files include a compatible x86 or x64 Windows executable, it also offers the Windows runtimes. Sikarugir is always offered, even before its first download, while CrossOver is offered when a usable application is detected or registered. This applies to every engine that publishes Windows builds, among them Ren'Py, the RPG Maker engines, Unity, Godot, GameMaker and Construct. It also applies however the game was imported: as a folder, through its Windows executable or through another launcher file, such as a Ren'Py `.sh` script. Known engines keep their usual default runtime.

A native build that is itself the game, such as a Linux executable, keeps its native game type, unless it was imported as part of a folder that also holds a Windows build. A game whose recorded location is a Mac app bundle, or a folder inside one, runs as that app and never offers the Windows runtimes. An app bundle that only sits next to a Windows executable makes no difference, though. A Ren'Py release folder with a Windows `.exe`, a `.sh` script and a Mac `.app` side by side still offers both Windows runtimes, whether the folder, the script, the executable or the app was imported.

Some detected engines have tools but no runtime that can launch the game on macOS: [BGI / Ethornell](BGI.md), [CatSystem2](CATSYSTEM2.md) and Windows [Haxe hxcpp/Lime builds](HAXE.md). For these, Play runs the original Windows executable through the first compatible Windows runtime, which is a registered CrossOver application if one exists and Sikarugir otherwise. Imports without a compatible Windows executable remain inspection-only. An [FNA / XNA 4](FNA.md#compatibility-limits) game whose inspection rules out the FNA host, such as one that uses Windows Forms or requires a 32-bit CLR, is handled the same way and keeps its inspection and decompilation tools.

To find the Windows executable for these game types, MacLauncher uses the one that the engine's detection names, if it names one. Otherwise it searches the game's own folder and its subfolders within fixed limits. When an engine reads its content from a narrower folder, such as `data`, the search still starts at the game folder around it.

A game imported through the app package of an NW.js build, such as the `www` folder of an RPG Maker MV game or a `package.nw` folder, keeps that folder as its location, and the search starts at the release folder around it. Detection records that release folder only when the layout shows that it belongs to the game: either the `package.json` one level up names a start page inside the imported folder, or the folder is a `package.nw` folder, which NW.js loads from beside its executable.

The search skips app bundles, redistributable folders and bundled Java runtimes. Uninstallers, installers, updaters, redistributables, crash handlers and reporters, and bundled interpreters and SDK tools never count as the game's executable. Configuration tools, launchers, servers and console wrappers count only when no better executable exists, and an executable named after the game or its launcher file ranks first. A game imported as a single file, such as a package or a data file, uses only executables next to that file that share its name or the game's name, so unrelated programs in a shared folder do not count.

Import records the chosen executable, or its absence, with the library entry. The inspector and runtime selectors read only that record and the recorded paths, never the game's files, so a game on a disconnected drive keeps its runtime choices. The game's details are refreshed at startup and when its drive is connected again, and a refresh records the executable again if the game's files have changed, for example after an update that renamed it. A library entry saved by an earlier version without a record gets one at its next refresh. **Play**, by contrast, checks the game's files again: it uses the recorded or chosen executable while that file is still present, and searches the folder otherwise.

Windows-only auxiliary tools of some engines, such as alice-tools, WolfTL, UberWolf and hlbc, run in their own private Sikarugir or CrossOver tool environments, separate from gameplay. [Inspector tools](../tools/README.md) lists them.

## Preparation and storage

Both runtimes play from the original game files. Play starts the original Windows executable with its own folder as the working directory, so assets, portable saves and configuration stay at their original paths, and no copy of the game folder is made. A camera, XeSS or FidelityFX adapter that has to replace a DLL beside the executable is the one exception: it runs the game from a small, separate launch folder with copies of the executable, the program an Unreal bootstrap executable declares, and the selected DLLs, while other assets are referenced from the originals.

By default, each game has its own Windows environment, a private CrossOver bottle or Wine prefix kept in launcher data. Runtime Settings can instead select an existing CrossOver bottle or Sikarugir wrapper, an external environment that MacLauncher uses by reference and never deletes, recreates or moves. Stop closes the game's programs gracefully before forcing them to end. In an external environment, other programs keep running unless a bottle-wide close is confirmed. Forgetting a game removes its private files and the environments that MacLauncher created for it, but leaves the original game files and the external environments it referenced. The [Sikarugir](../runtimes/SIKARUGIR.md#private-game-files-and-prefixes) and [CrossOver](../runtimes/CROSSOVER.md#bottles-and-private-game-files) pages describe each runtime's layout.

## Saves

Saves written next to the game's files stay in the original game folder, while saves written to the Windows user profile live in the selected Windows environment. There is no universal Windows save editor or cheat integration. Recognized engines keep their source and asset tools while a Windows runtime is selected, but their engine-specific save codecs are disabled.

## Settings

Both runtimes have defaults in Settings and per-game overrides in Runtime Settings. Their shared settings are the **Environment** choice, the translator controls (default Direct3D engine, Direct3D 8 through 12, Vulkan driver and video codecs), game temporal integration, synchronization, language locale, Windows version, Windows executable, BepInEx winhttp override, Wine DLL overrides, game arguments and Wine debug channels. Sikarugir adds DirectDraw compatibility. Environment variables for the runtime and each translator have global values in Runtimes and per-game values in Runtime Settings, as [translator environment variables](../runtimes/TRANSLATOR_ENVIRONMENT.md) describes. The [Sikarugir settings](../runtimes/SIKARUGIR.md#runtime-settings) and [CrossOver settings](../runtimes/CROSSOVER.md#runtime-settings) describe each one.

Beyond the Basic group, the controls of both runtimes are arranged in advanced Display, Input, Compatibility and Diagnostics groups. They cover Retina and DPI, keyboard mapping, mouse and fullscreen capture, vertical sync, virtual desktops with custom sizes, Rosetta AVX advertisement, WineD3D options, tuning for particular engines and diagnostic HUDs. When an existing bottle or wrapper is selected, each control offers that environment's current setting as its default. A Windows version that has no environment type of its own does not create another bottle or prefix: CrossOver's per-launch version is reported inside the current bottle, and Sikarugir's additional versions are set for the game's executable inside the Windows 10 prefix or the selected wrapper.

## Inspector tools

The inspector details show the Windows CPU, the executable and, with CrossOver, the CrossOver application. They also show the components that the game uses for Direct3D 8 through 12, the Vulkan driver and video codecs, together with the selected choice and the reason whenever a [fallback](../runtimes/TRANSLATORS.md#compatibility-and-fallback) replaced it. When the DXMT version does not match the camera adapter, a **Camera adapter** row reports it as unavailable. After a Play that used the [Steam client bridge](../runtimes/WINDOWS_STEAM.md), a **Steam** row names the bridge version while that version stays installed.

- **Open Windows files** opens the game's Windows environment: its private bottle or prefix once the game has been played, or the selected existing bottle or wrapper prefix.
- **Inspect binary** runs the shared [native inspection](../tools/NATIVE_INSPECTION.md) on the original executable, independently of the selected runtime.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| **Sikarugir (Wine)**, default | Wine engines and support libraries from the Sikarugir publisher |
| **CrossOver** | Locally installed CrossOver applications, registered in Runtimes |

### Sikarugir (Wine)

Sikarugir runs the game with [Sikarugir Wine engines](https://github.com/Sikarugir-App/Engines) and their matching support libraries, which are downloaded from the publisher on first use. [Sikarugir (Wine)](../runtimes/SIKARUGIR.md) describes its requirements, versions, storage, settings and graphics.

### CrossOver

CrossOver runs the game with a licensed [CrossOver application](https://www.codeweavers.com/crossover) that is already installed on the Mac; MacLauncher never downloads or bundles CrossOver. [CrossOver](../runtimes/CROSSOVER.md) describes application registration, bottles, settings and graphics.
