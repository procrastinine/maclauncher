# Windows Game

This game type covers Windows games with no recognized engine: an x86 or x64 Windows executable that no other game type claims. MacLauncher runs it through a Windows compatibility runtime, either [Sikarugir (Wine)](../runtimes/SIKARUGIR.md), the default, or a locally installed [CrossOver](../runtimes/CROSSOVER.md) application. Its module is `crossover`.

Both runtimes also serve games of other types that include a compatible Windows executable, as described in [Windows executables in other game types](#windows-executables-in-other-game-types).

## Accepted inputs

Import accepts a Windows `.exe` file or a game folder. Detection checks the executable's headers and does not rely on its file name: the file must have a valid PE signature, executable-image flags, an optional header and a Windows GUI or console subsystem. x86 and x64 executables can be played, while DOS programs, DLLs, Windows ARM64 executables, and installers that need a further installation step are outside playback support. The library entry is named after the executable.

A folder imports when its top level contains one valid Windows executable. Uninstallers, installers, setup programs, updaters, redistributables, crash reporters and bundled tools such as a DOSBox build never identify a Windows game; such a program becomes the game only when it is imported directly. Configuration tools, launchers and similar helpers rank below a game executable and do not compete with it. When several executables of equal rank remain, import asks for one `.exe` to be selected directly. Subfolders are not searched, and a folder with too many entries also needs its executable selected directly.

Windows Game is the last fallback in detection and applies only after every recognized format, [web content](WEB.md) and the [macOS Game](MACOS.md) check fail to match. Native macOS app imports and Linux-only exports never become Windows games, and an unrelated Windows executable next to them does not change their format.

## Windows executables in other game types

Sikarugir and CrossOver also run games of other types. A game detected as another engine keeps its detected engine, version, inspection and engine tools. When its files include a compatible x86 or x64 Windows executable, it also offers the Windows runtimes: Sikarugir always, including before its first download, and CrossOver when a usable application is detected or registered. This applies to every engine that publishes Windows builds, among them Ren'Py, the RPG Maker engines, Unity, Godot, GameMaker and Construct, however the game was imported: as a folder, through its Windows executable, or through another launcher file such as a Ren'Py `.sh` script. Known engines keep their usual default runtime.

A native build that is itself the game, such as a Linux executable, keeps its native game type, unless it was imported as part of a folder that also holds a Windows build. A game whose recorded location is a Mac app bundle, or a folder inside one, runs as that app and never offers the Windows runtimes. An app bundle that only sits next to a Windows executable makes no difference: a Ren'Py release folder with a Windows `.exe`, a `.sh` script and a Mac `.app` side by side still offers both Windows runtimes, whether the folder, the script, the executable or the app was imported.

Some detected engines have tools but no runtime that can launch the game on macOS: [BGI / Ethornell](BGI.md), [CatSystem2](CATSYSTEM2.md) and Windows [Haxe hxcpp/Lime builds](HAXE.md). For these, Play runs the original Windows executable through the first compatible Windows runtime: a registered CrossOver application if one exists, otherwise Sikarugir. Imports without a compatible Windows executable remain inspection-only.

For these game types, the Windows executable is the one the engine's detection names, when it names one. Otherwise MacLauncher searches the game's own folder and its subfolders within fixed limits. When an engine reads its content from a narrower folder, such as `data`, the search still starts at the game folder around it.

A game imported through the app package of an NW.js build, such as the `www` folder of an RPG Maker MV game or a `package.nw` folder, keeps that folder as its location, and the search starts at the release folder around it. Detection records that release folder only when the layout shows that it belongs to the game: the `package.json` one level up names a start page inside the imported folder, or the folder is a `package.nw` folder, which NW.js loads from beside its executable.

The search skips app bundles, redistributable folders and bundled Java runtimes. Uninstallers, installers, updaters, redistributables, crash handlers and reporters, and bundled interpreters and SDK tools never count as the game's executable. Configuration tools, launchers, servers and console wrappers count only when no better executable exists, and an executable named after the game or its launcher file ranks first. A game imported as a single file, such as a package or a data file, uses only executables next to that file that share its name or the game's name, so unrelated programs in a shared folder do not count.

Import records the chosen executable, or its absence, with the library entry. The inspector and runtime selectors read only that record and the recorded paths, never the game's files, so a game on a disconnected drive keeps its runtime choices. Refreshing the game's details, which happens at startup and when its drive is connected again, records the executable again if the game's files have changed, for example after an update that renamed it. A library entry saved by an earlier version without a record gets one at its next refresh. **Play** checks the game's files again and uses the recorded or chosen executable while it is still present, and searches the folder otherwise.

Windows-only auxiliary tools of some engines, such as alice-tools, WolfTL, UberWolf and hlbc, run in their own private Sikarugir or CrossOver tool environments, separate from gameplay. [Inspector tools](../tools/README.md) lists them.

## Preparation and storage

Both runtimes play from a private writable copy of the game folder. Windows games can write settings or saves next to any asset, so the whole folder is copied, using filesystem copy-on-write cloning where available. Other filesystems need space for a full copy. Later launches reuse unchanged assets and refresh private files that still match the previous original, so saves, mod edits and private deletions are kept.

Each game's Windows environment defaults to a private CrossOver bottle or Wine prefix in launcher data. Runtime Settings can select an existing bottle or Sikarugir wrapper by reference. Stop closes private programs gracefully before forcing; external environments keep other programs running unless a bottle-wide close is confirmed. Forgetting a game removes its private files and environments while preserving external references. The [Sikarugir](../runtimes/SIKARUGIR.md#private-game-files-and-prefixes) and [CrossOver](../runtimes/CROSSOVER.md#bottles-and-private-game-files) pages describe each runtime's layout.

## Saves

Saves written next to the game's files live in the private game copy, and saves written to the Windows user profile live in the selected Windows environment. There is no universal Windows save editor or cheat integration. Recognized engines keep their source and asset tools while a Windows runtime is selected, but their engine-specific save codecs are disabled.

## Settings

Both runtimes have defaults in Settings and per-game overrides in Runtime Settings. They share the graphics backend, game temporal integration, DXMT support, synchronization, language locale, Windows version, Windows executable, BepInEx winhttp override, Wine DLL overrides, environment variables, game arguments and Wine debug channels. Sikarugir adds a Vulkan driver choice and DirectDraw compatibility. The [Sikarugir settings](../runtimes/SIKARUGIR.md#runtime-settings) and [CrossOver settings](../runtimes/CROSSOVER.md#runtime-settings) describe each one.

## Inspector tools

The inspector details show the Windows CPU, the executable and, with CrossOver, the CrossOver application.

- **Open Windows files** opens the game's private Windows environment once the game has been played.
- **Inspect binary** runs the shared [native inspection](../tools/NATIVE_INSPECTION.md) on the original executable, independently of the selected runtime.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| **Sikarugir (Wine)**, default | Wine engines and support libraries from the Sikarugir publisher |
| **CrossOver** | Locally installed CrossOver applications, registered in Runtimes |

### Sikarugir (Wine)

Sikarugir runs the game with [Sikarugir Wine engines](https://github.com/Sikarugir-App/Engines) and their matching support libraries, downloaded from the publisher on first use. [Sikarugir (Wine)](../runtimes/SIKARUGIR.md) describes its requirements, versions, storage, settings and graphics.

### CrossOver

CrossOver uses a licensed [CrossOver application](https://www.codeweavers.com/crossover) that is already installed on the Mac. MacLauncher never downloads or bundles CrossOver. [CrossOver](../runtimes/CROSSOVER.md) describes application registration, bottles, settings and graphics.

Windows runtime controls are grouped into Basic settings and advanced Display, Input, Compatibility and Diagnostics settings. Both runtimes expose Retina and DPI, keyboard mapping, mouse and fullscreen capture, vertical sync, virtual desktops, Rosetta AVX advertisement, WineD3D options, engine-specific tuning and diagnostic HUDs. Existing bottles and wrappers offer their current setting as the default for each control. Per-launch CrossOver Windows versions and additional Sikarugir per-program Windows versions keep the current environment's storage.
