# Unity

This game type covers games built with the Unity engine. When a Windows or Linux export uses Unity's Mono scripting backend, MacLauncher runs it with the Mac player of exactly the same Unity version. The game keeps its original scripts and assets, and MacLauncher prepares the native application automatically. Windows builds that the Mac player cannot run, because of IL2CPP code, Windows desktop APIs or shaders without a Metal or OpenGL version, use the [Windows runtimes](#crossover-sikarugir-and-winecx) instead. The asset and source tools work for Mono and IL2CPP games with any runtime.

## Detection and versions

Detection reads the UnityFS and SerializedFile headers, within fixed size limits, to get the complete editor version including its patch suffix. Managed assembly metadata identifies:

- the Mono scripting backend;
- the exact native P/Invoke libraries and symbols, with the assemblies that import them;
- Windows desktop APIs;
- native plugin files.

For Unity 5.3–2020.3 layouts, a UnityFS/LZ4 parser also reads `BuildSettings.m_GraphicsAPIs`, and the inspector shows the detected graphics APIs alongside the editor and scripting versions.

Native playback needs game assets that contain Metal or OpenGL shaders, plus matching Mac native plugins. Because the Mac Mono player cannot run IL2CPP code, Mono code that uses Windows desktop APIs, or a build whose shaders exist only for other graphics APIs, such a game is not offered the Unity Mono player. If it has a Windows executable, it runs in the Windows runtimes on its own Windows engine, where the selected graphics backend (D3DMetal, DXMT or DXVK) translates its Direct3D calls to Metal or Vulkan. The Mac player cannot use that translation, since it issues no Direct3D calls and Unity compiles shader data separately for each graphics API. A build with neither Mac shaders nor a Windows executable, such as a Linux export with only Vulkan shaders, therefore has no runtime, and the inspector's compatibility field names the shader APIs it contains. Asset inspection and source export work in every case.

## Preparation and launch

Launch preparation creates a small private `.app` skeleton under `userData/games/<gameId>/modules/unity/`. The skeleton links to the shared matching player and Mono runtime and to the original assets and copies only small platform bootstrap files, so the game is never copied in full. Windows and Linux native plugins are not run as Mac libraries, and any plugin the game requires needs a compatible Mac implementation.

Legacy players embed the native engine in their executable. MacLauncher copies that executable with the filesystem's clone option before it signs the private bundle, which leaves the shared player unchanged and saves space on native APFS volumes, while the original game assets stay linked. Framework-style players need only their small entry executable copied.

When the private bundle is verified, its native code is checked strictly, but the code signature's resource check is skipped because the bundle links to external assets on purpose. The shared player and Mono installation is still checked against its complete file list, and no linked framework or original game asset is re-signed.

### Steam API

Games that import the .NET Steam API get the shared native Steam API library automatically. A matching original Mac library takes priority, and otherwise the included helper supplies the supported API for the selected player's CPU and the game's local App ID. The private [Mac plugin directories](https://docs.unity3d.com/530/Documentation/Manual/PluginsForDesktop.html) link to that library, and local Steam state is kept under the game's module data. Shared player files stay unchanged. [Steam support](../runtimes/STEAM_API.md) describes the compatibility profiles and how the native library is chosen.

## Saves

MacLauncher finds Unity's normal Mac save locations in Application Support and Caches from the game's company and product metadata. Save backups leave out the generic global Preferences folder. Save editing and cheats are not available.

## Settings

Runtime Settings offer the **Renderer** (Automatic, Metal or OpenGL) and **Start in a window**.

## Inspector tools

### Source export

For Mono games, **Decompile** uses the shared [ILSpy](https://github.com/icsharpcode/ILSpy) tool, which can decompile `Assembly-CSharp.dll` without a command-line entry point. The output is stored in the game's Unity module data, so scripts remain inspectable even when the shaders prevent native launch. **Reveal source** opens the latest export.

**Runtimes → Tools → ILSpy** selects ILSpy versions for both Unity and [FNA](FNA.md#decompilation). Each tool version runs on a compatible shared .NET host and does not change the game player.

For IL2CPP games, **Decompile** runs [Cpp2IL](https://github.com/SamboyCoding/Cpp2IL) against the native game binary and metadata, and ILSpy then exports C# from the recovered DLLs. The recovered DLLs and source stay in the game's Unity module data. Cpp2IL's self-contained Apple Silicon and Intel builds come from upstream GitHub Actions and need no separate .NET host, and **Runtimes → Unity → Cpp2IL** lists its versions.

Because Cpp2IL recovery can produce missing or invalid method bodies, an incomplete C# export is identified by assembly, and its logs and recovered DLLs are kept. The export is for inspection and does not convert the game for native playback.

### Assets

**Inspect assets** opens [AssetRipper](https://github.com/AssetRipper/AssetRipper) with the game's data already loaded. Its browser interface listens only on `127.0.0.1` and serves its interface files locally, and **Close inspector** stops that session. **Export assets** exports textures, audio and other supported content into the game's private Unity data directory, and **Reveal assets** opens the result in Finder. These actions work for Mono and IL2CPP data whether or not the game can play natively, although AssetRipper's IL2CPP asset export does not recover script bodies.

AssetRipper runs as the publisher's Apple Silicon or Intel application and needs no separate .NET installation. **Runtimes → Unity → AssetRipper** lists stable native releases from **1.3.10** onward and can install several versions side by side. When no version is listed or installed yet, the first asset action reads the release list after download consent and installs the newest release.

AssetRipper's preferences, logs and temporary files stay under each game's Unity data directory, and a new export replaces the previous one only after it completes successfully.

## Runtimes

### Unity Mono player

The Unity Mono player is the default runtime.

#### Player catalog

**Reload** queries the [official Unity Releases API](https://docs.unity.com/en-us/oas-release/1.0.0) in pages of 25, up to 500 recent releases, and reads four pages at a time when the API states its total. Each listed release names its Mac Mono component, the component's installer and the installer's published integrity digest, which the download is verified against. A renamed installer of the same component and release is accepted, although the usual `UnitySetup-Mac-Mono-Support-for-Editor-<version>.pkg` name is preferred. Releases whose metadata cannot be read are skipped. A page without a total, with a smaller page size or with extra results is read as published, whereas a page for another offset, or an empty page while releases remain, leaves the cached list unchanged.

Play uses the exact detected editor version, including its patch suffix, and never substitutes a newer editor or player. When the catalog has no component metadata for that version, the installation that Play asks consent for first looks up that exact release, so releases older than the recent catalog remain available.

**Set default** in Runtimes saves a player preference that applies when it matches the game's exact detected version. Each game continues to require its matching player component.

#### Playback components

Unity's separate **Mac Mono playback components** provide the native player and the Mono libraries, so neither the Unity editor nor its command-line tools need to be installed. Runtimes also accepts matching official component PKGs, which go through the same verification and extraction steps as an online installation.

`pkgutil --expand-full` extracts the payloads without running installer scripts. The installation keeps the non-development player and the Mono runtime, verifies the embedded exact editor version and revision, and records the complete file list. It also records the native library's original signature status, and unsigned official templates are signed ad hoc, only inside MacLauncher's own installation, and then strictly verified. New players install under `userData/runtimes/unity/<architecture>/<exact-version>/`, and compatible players from the earlier layout without an architecture folder remain usable.

Both framework-style players and legacy fused players are supported. The game's own Windows or Linux Mono libraries are never used in place of the player's.

Unity 2020.2 changed the folder names of the Mono player template inside the playback components. Installation therefore tries the newer names first from 2020.2 onward and the older names first for earlier versions. If neither matches, a search with fixed limits identifies a non-development Mono player by its contents, and installation records the layout it found for later launches.

Unity 6000.6 provides separate Apple Silicon and Intel players with a macOS 12 minimum, while older Intel-only players use [Rosetta](../runtimes/ROSETTA.md) on Apple Silicon.

#### Installer signature

Every component installer, downloaded or imported, must carry a trusted Apple Developer ID Installer signature from **Unity Technologies ApS** (team identifier `BVPN9UFA9B`) or **Unity Technologies SF** (team identifier `9QW8UQUTAA`). The signer name is accepted with or without the team identifier, because older installers such as 5.3.2p3 are signed without it. A download is also checked against the integrity digest the Releases API lists for it, which is MD5 for older releases. Before extraction, the installation records the installer's actual SHA-256, the signer, the signing certificate's SHA-256 and any trusted timestamp.

The 5.3.2p3 player supplies native `Contents/Data/Managed/etc/mono` configuration. It uses Intel 64-bit code, so on Apple Silicon it needs [Rosetta](../runtimes/ROSETTA.md).

#### Graphics

Shared graphics uses the selected Mac player's CPU architecture, including its Rosetta requirement, and for a native Mac app the architecture comes from the bundle's own executable. Universal players keep the native host slice, so the requirements of the [graphics providers](../graphics/PROVIDERS.md) follow the running player.

### Game's macOS app

When the game ships its own Mac build, **Game's macOS app** runs that build.

### CrossOver, Sikarugir and WineCX

Compatible x86 and x64 Windows exports, including IL2CPP and Direct3D-only builds, can use [Sikarugir](../runtimes/SIKARUGIR.md), [WineCX](../runtimes/WINECX.md) or an available [CrossOver](../runtimes/CROSSOVER.md) application instead, and the asset and source tools stay available. These runtimes keep their own private writable files and Windows environments. [Windows Game](WINDOWS.md#windows-executables-in-other-game-types) describes how they are offered.
