# Unity Mono

MacLauncher runs Windows and Linux Unity **Mono** exports with the exact matching Mac player. The game retains its original scripts and assets; MacLauncher prepares the native application automatically. IL2CPP Windows builds use Sikarugir or CrossOver.

## Game detection

Bounded UnityFS and SerializedFile headers provide the complete editor version, including patch suffix. Managed assembly metadata identifies Mono, exact native P/Invoke libraries/symbols and their source assemblies, Windows desktop APIs and native plugin files. A UnityFS/LZ4 parser reads `BuildSettings.m_GraphicsAPIs` for Unity 5.3–2020.3 layouts. Detected graphics APIs appear alongside the editor and scripting versions.

Native playback uses game assets containing Metal or OpenGL shaders and matching Mac native plugins. Direct3D-only data uses the Windows backends below. Asset inspection and Mono source export work with either route.

Compatible x86/x64 Windows exports, including IL2CPP and Direct3D-only builds,
can instead select [Sikarugir (Wine)](SIKARUGIR.md) or an available
[CrossOver](CROSSOVER.md) application. Asset and source tools remain available;
these Windows runtimes use separate private writable files and environments.

## Player catalog and installation

The catalog starts empty, or shows cached releases and installed players. Startup, status checks and version selection make no release requests. **Reload** uses the [official Unity Releases API](https://docs.unity.com/en-us/oas-release/1.0.0) through the shared catalog manager, with pages of 25 and a bound of 500 recent releases. Refresh replaces the release list without appending older results; the cache remains available offline.

Play uses the exact detected editor version, including its patch suffix. If its component metadata is missing, Play resolves that exact release and requests consent before downloading the player. Older releases outside the recent catalog remain available through this exact lookup. A newer editor/player is never silently substituted. Runtime Settings expose Automatic, Metal and OpenGL renderers plus windowed launch.

Separate **Mac Mono playback components** provide the native player and Mono libraries without installing the IDE. Import and online installation share the same verification and extraction path; Runtimes accepts matching official component PKGs. Unity's editor/CLI is not needed.

Unity **2020.1.17f1**, revision `9957aee8edc2`, uses a 142,522,361-byte official PKG. Its exact package identity and the legacy identity below support component verification; they do not populate the initial release list.

The pinned legacy component is **5.3.2p3**, revision `b6c1a63227dc`, a 101,800,098-byte official `UnitySetup-Mac-Support-for-Editor-5.3.2p3.pkg`. Its verified installer SHA-256 is `afdcedba4167a920e94f0cbb6118ee819aa51bcf969c8e269ab52bc2ab992bcd`; its publisher MD5 is `90d81f8230257409b3ddbd8e347cc312`. The actual Apple-trusted legacy installer identity is **Unity Technologies ApS**, certificate SHA-256 `b5b1c5b631c1d95d089ac28b8a8a899fdeacf730c562c10d54954680f7c2369e`, trusted timestamp 2016-02-09. The older certificate is matched explicitly instead of assuming the modern Team ID.

Unity's old publisher metadata uses MD5. The shared installer permits that legacy digest only together with a verified trusted Apple installer signature and exact publisher identity; it records the actual SHA-256 and signer before extraction. The pinned package is signed by **Unity Technologies ApS (BVPN9UFA9B)**, has actual SHA-256 `c9db8f02fdd314682f369b31054771add02313b8e40872bf53870861845319c7`, and installer leaf certificate SHA-256 `b053f10f567280be90b9b28469e178eb6d4049d10665dbd7e535f58cb1da0714`.

`pkgutil --expand-full` extracts payloads without running installer scripts. The installation keeps the non-development player and Mono runtime, verifies the embedded exact editor version/revision and records the complete payload inventory. The native library's original signature status is recorded; unsigned official templates are ad-hoc signed only inside the owned installation and then strictly verified. Runtimes install under `~/Library/Application Support/maclauncher/runtimes/unity/<exact-version>/`.

Both framework-style players and legacy fused players are handled. The verified 5.3.2p3 profile occupies 34.4 MB, uses the Intel 64-bit non-development player and supplies native `Contents/Data/Managed/etc/mono` configuration. Apple Silicon uses the shared Rosetta prerequisite. The inspector never substitutes the original game's Windows or Linux Mono libraries.

Shared graphics uses the selected Mac player's CPU architecture, including its Rosetta requirement. Native Mac app selection reads the bundle's own executable. Universal players retain the native host slice, so graphics provider requirements follow the running player.

## Launch, tools and saves

Launch preparation creates a small private `.app` skeleton under `userData/games/<gameId>/modules/unity/`, links the global matching player/Mono runtime and original assets, and copies only small platform bootstrap files. There is no complete game copy. Windows/Linux native plugins are not executed as Mac libraries; required plugins still need compatible Mac implementations.

Managed Steam API imports use the shared native dependency automatically. A matching original Mac library takes priority; otherwise the included helper supplies the supported API for the selected player's CPU and game-local App ID. The private [Mac plugin directories](https://docs.unity3d.com/530/Documentation/Manual/PluginsForDesktop.html) link to that library, with local Steam state under the game's module data. Original plugins and shared player files remain unchanged. [Steam support](STEAM_API.md) describes the API profiles and native-library selection.

Legacy players embed the native engine in their executable. That executable is copied with the filesystem's clone option before private bundle signing, which avoids changing shared runtime bytes and minimizes storage on native APFS volumes. Original game assets remain linked. Framework-style players need only their small entry executable copied.

Private bundle verification checks strict native code while explicitly ignoring the resource seal: intentional external asset links are not a distributable application's sealed resource tree. The global player/Mono installation still has its full payload inventory checked. No linked framework or original game asset is re-signed.

The inspector's **Decompile** action uses the shared [ILSpy](https://github.com/icsharpcode/ILSpy) service. Missing tool or compatible .NET host downloads prompt for consent, install automatically and resume the export. **Runtimes → Tools → ILSpy** selects versions for both Unity and FNA. A saved tool default takes precedence over the manager default: the newest compatible stable published tool, or the newest ready installed tool when none is listed. Each tool uses a compatible shared .NET host without changing the game player. Decompiling `Assembly-CSharp.dll` does not require a CLI entry point. Outputs live under the game's own Unity module data, and scripts remain inspectable when shaders prevent native launch.

For IL2CPP games, **Decompile** runs managed [Cpp2IL](https://github.com/SamboyCoding/Cpp2IL) against the native game binary and metadata, then ILSpy exports C# from the recovered DLLs. Recovered DLLs and source remain under the game's Unity module data. Cpp2IL's self-contained Apple Silicon build downloads from upstream Actions after consent and needs no separate .NET host. **Runtimes → Unity → Cpp2IL** manages versions. Recovery can produce missing or invalid method bodies; incomplete C# exports are identified by assembly, with logs and recovered DLLs retained. The export supports inspection and does not convert the game for native playback.

**Inspect assets** opens [AssetRipper](https://github.com/AssetRipper/AssetRipper) with the game's data already loaded. Its browser interface listens only on `127.0.0.1` and serves its interface files locally. **Close inspector** stops that tool session. **Export assets** exports textures, audio and other supported content into the game's private Unity data directory; **Show assets** opens the result in Finder. These actions remain available for Mono and IL2CPP data independently of native playback.

AssetRipper uses the publisher's Apple Silicon application without a separate .NET installation. The first asset action requests download consent, installs the tool and resumes automatically. **Runtimes → Unity → AssetRipper** lists stable native releases from **1.3.10** onward and supports installing multiple versions. The game's explicit version takes precedence over the runtime default. A saved default takes precedence over the newest compatible stable listed release; when none is listed, the manager default is the newest ready installed release. The first installation from Runtimes saves its version as the default when none is saved. Clearing a saved default restores the manager default. Refresh retrieves release history after an explicit action and preserves saved choices; installed tools and cached version lists remain usable offline. Preferences, logs and temporary files stay under each game's Unity data directory, and a new export replaces the previous export only after completing successfully. AssetRipper's IL2CPP asset export does not recover script bodies.

Company/product metadata discovers Unity's normal Mac save locations in Application Support and Caches. No generic global Preferences folder is included in save backups. Save-state editing and cheats are unavailable.
