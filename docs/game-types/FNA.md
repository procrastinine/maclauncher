# FNA / XNA 4

This game type covers managed .NET games written for XNA 4 or for FNA. MacLauncher's `fna` module runs them natively on Apple Silicon through .NET and [FNA](https://github.com/FNA-XNA/FNA), which provides the XNA game API, graphics, audio and input.

## Detection and versions

To identify an FNA or XNA game without loading it, MacLauncher parses the game's ECMA-335 metadata with a PE/CLI reader that has fixed limits. The reader reports:

- the game assembly version;
- the reachable FNA or XNA reference;
- the bundled or embedded FNA assembly version;
- the target framework and CLR metadata;
- the original PE architecture and 32-bit requirements;
- Windows desktop API types;
- exact native P/Invoke library and symbol names, with the assembly or embedded resource they come from.

A string that only mentions `FNA.dll` is not enough to match. Detection follows at most 32 assembly sources and three dependency levels, and in self-contained exports it checks executable and runtime-config pairs first.

Embedded DLLs, including those in nested resources, are read as byte ranges inside their original PE, and detection never extracts or runs them. The same reader is shared with other game types, where it normally inspects metadata only. For FNA, it also reads resource descriptors and reuses the detection session's file, byte and result caches. The stored facts are refreshed once when the parent PE or the FNA detection code changes.

Inspection reads at most 32 MiB and accepts embedded DLLs of up to 8 MiB each. Referenced dependencies that are compressed, malformed, mismatched or over the limit are listed in `dependencyInspection`, and when their requirements cannot be inspected safely, Play stops before it installs a runtime. The CLR architecture flags of dependencies are recorded separately from the entry point's original flags.

The game's assembly versions, FNA references, target frameworks and CLR metadata are recorded separately from the selected host. A CLR metadata string such as `v4.0.30319`, for example, does not identify an installed runtime.

## Preparation

Play runs FNA games from the original game directory, which supplies content, configuration, relative file access and working data. Portable assemblies also run from their original paths. The FNA host and the selected framework, on the other hand, stay in the installed runtime package: preparation does not copy them into a game folder, and it does not link game assets either.

The exception is the ARM64 host, on which portable x64 PE32+ assemblies need conversion. An assembly can be converted only when its CLR metadata is IL-only, allows a 64-bit host and contains neither a native entry point nor managed native or ReadyToRun code. Conversion changes nothing but the PE machine field, and the converted copy is written under `userData/games/<gameId>/modules/fna/assemblies/`. For this step, preparation examines the entry assembly and the managed dependencies it reaches, not the game's assets. Intel hosts need no conversion and use compatible x64 assemblies directly.

When conversion is needed, the host looks for assemblies among the converted copies first and then in the original game directory. Even when the entry assembly itself is converted, the original directory remains the working directory and the application base directory. The selected FNA and XNA facades are loaded from the runtime package, and the host's .NET configuration disables roll-forward.

Conversion inputs and outputs are checked before they are reused. A recorded checksum is reused for a file whose precise identity has not changed, while a file with only coarse timestamps is checked byte by byte. Unchanged inputs are not copied again. If a source changes while it is being hashed or copied, the earlier converted files stay intact. A converted copy that was modified is likewise kept instead of being overwritten.

Earlier MacLauncher versions placed a private overlay in front of each game. Files in those overlays are recovered once into the original game directory, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored; an original file that differs stays unchanged, and the private version is kept beside it as a separate copy. When recovery would be unsafe or the original folder is unavailable, the private data stays intact. Play does not read these earlier overlays.

### Steam API

A game that imports the [Steam API](../runtimes/STEAM_API.md) needs a Mac Steam API library, and MacLauncher sets one up automatically; a DLL name alone does not trigger this. A compatible Mac library that ships with the game takes priority. Otherwise, MacLauncher uses its included Steam API helper, which provides the supported exports after it has checked the game process's CPU and the game's local App ID. The CLR looks for a native library under several names, including Windows `.dll` names, and small per-game aliases answer this [CLR library-name probing](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/native-library-loading) without changing the game or copying the helper. Local Steam state stays under the game's module data, and each native export and encrypted-ticket library keeps its own dependency requirement.

## Settings

Graphics selection is automatic. Runtime Settings provide:

- **Use selected FNA framework**, the per-game opt-out from framework substitution.
- **Convert portable x64 assemblies**, the per-game opt-out from portable IL conversion.
- **Allow software OpenGL** and **Graphics driver** (Automatic or OpenGL).
- **Game arguments**.

## Compatibility limits

Portable managed games run with automatic framework substitution and IL conversion. Windows Forms, WPF, native Windows DLLs and 32-bit CLR execution, however, need the [Windows runtimes](#crossover-and-sikarugir-wine), and the native FNA runtime has no XNA video decoder. C# decompilation is available for every inspected managed assembly either way.

The FNA runtime is listed only for a game whose recorded inspection allows the FNA host. A game that uses Windows Forms, WPF or System.Drawing graphics, requires a 32-bit CLR, contains mixed-mode code, reaches a dependency with native or architecture-specific code, uses an XNA service that FNA lacks, or has a dependency that could not be inspected, offers the Windows runtimes instead, and the first compatible one is its default. A record without an inspection result keeps the FNA runtime.

The checks for Windows desktop APIs cover Windows Forms, WPF dispatchers and System.Drawing graphics, while the portable drawing structs remain usable. The `32BITREQUIRED` header flag is kept as recorded: it declares the CLR process architecture that a game requires, but on its own it does not prove a native pointer layout. Games that convert callback pointers to 32-bit integers or import x86 Windows DLLs need compatible API implementations and calling conventions, and portable IL conversion does not provide these.

## Decompilation

The inspector's **Decompile** action recovers C# source by running [ILSpy](https://github.com/icsharpcode/ILSpy) on a .NET host. ILSpy versions are listed in **Runtimes → Tools → ILSpy**, which [Unity](UNITY.md#source-export) shares. Reload reads ILSpy's NuGet history within fixed limits, together with each package's target framework and publisher digest. If no version is listed or installed yet, the first decompilation reads that history after download consent and installs the newest compatible release. Each listed version records its host requirements, and changing the decompiler does not change the FNA runtime.

| ILSpy target framework | .NET host | macOS |
| --- | --- | --- |
| .NET **8** | Reuses an installed FNA runtime with a matching .NET **8** host | The installed FNA runtime's minimum |
| .NET **8** or later, without a matching FNA host | Separate Apple Silicon or Intel host for the same .NET major version, using the newest runtime that Microsoft lists for that version | The minimum that the host's own binaries declare, read at installation |

When a package contains builds for several frameworks, the newest supported framework is used, and when NuGet's metadata omits the package's file list, the framework is read from the downloaded package. Some versions are published as separate runtime-specific packages, with `ilspycmd` itself holding only a pointer to them; such a version installs from its framework-dependent `ilspycmd.any` package. Versions that target only a framework older than .NET 8 are listed with the reason they cannot be installed.

ILSpy versions are installed under `userData/runtimes/fna-tools/ilspy/<version>/`, and the separate shared hosts under `userData/runtimes/dotnet-tools/<version>/<architecture>/`, where the architecture is `arm64` or `x64`, so hosts for both architectures can be installed side by side. No .NET SDK is required, and tool update checks are disabled.

Each decompilation produces a C# project in `userData/games/<gameId>/modules/fna/decompiled/<toolVersion>/`, which records the original assembly, its version and hash, and the exact tool and runtime used. If an existing export has been edited, it is preserved before a new export replaces it. Because decompilation never runs the game, it also works for managed games that the native host cannot launch, including assemblies flagged for a 32-bit CLR. **Reveal source** opens the export.

The same action is available through the core API and as `pnpm launch --game <path> --action decompile`. Its optional JSON payload, such as `{"version":"9.1.0.7988"}`, selects an explicitly listed tool version.

## Runtimes

### FNA

FNA is the default runtime, and MacLauncher Builds publishes complete runtime packages for it. **Runtimes → FNA** lists these packages separately from the upstream FNA source releases, which appear for reference.

Each package contains .NET, FNA, MacLauncher's .NET host for FNA games, the supported XNA type-forwarding facades and the native graphics and audio libraries. It also includes the stock shader resources declared by upstream `FNA.Core.csproj`, and the host resolves native libraries by their canonical ABI names. Runtime packages contain no game assets, and Runtimes lists each package's architectures and minimum macOS.

Running games from their original paths needs host support, which the selected host must declare in its runtime profile. If the installed host does not declare it, Play offers a compatible package and installs it after download consent. For FNA storage and content discovery, the host uses the identity of the game's entry assembly.

Packages are installed under `~/Library/Application Support/maclauncher/runtimes/fna/<architecture>/<version>/`. Installation and Play rely on a downloaded package's catalog archive digest, safe declared paths and actual native requirements, while the package's recorded file list restricts neither of them. Each installation records its FNA, .NET, host, package and native versions, the upstream source and MacLauncher changes it was built from, and the hashes of critical dependencies.

To bring the game to the front, each launch sets the [SDL foreground hint](https://wiki.libsdl.org/SDL3/SDL_HINT_MAC_BACKGROUND_APP) for the game process only and uses the shared native activation helper. This helper waits for a window owned by the game, makes at most one [AppKit activation request](https://developer.apple.com/documentation/appkit/nsapplication/activationoptions) and checks the actual foreground order. It gives up after eight seconds or when the game exits, never holds up the launcher, and neither requests Accessibility access nor changes system preferences.

### Game's macOS app

Some FNA games are published as macOS apps that ship their own executable, which may be started by a shell launcher. Such an app runs its own executable by default, and a containing folder with one recognized app can be imported directly. The FNA runtime remains available for compatible game data, and ReShade effects apply through the shared launch controls without replacing the runtime that the app ships.

### CrossOver and Sikarugir

Compatible x86 and x64 Windows exports can use [Sikarugir](../runtimes/SIKARUGIR.md) or an available [CrossOver](../runtimes/CROSSOVER.md) application instead. These runtimes also cover games whose Windows-only dependencies prevent native FNA playback, as [compatibility limits](#compatibility-limits) describes. Both run .NET Framework programs on the [Wine Mono](https://gitlab.winehq.org/mono/wine-mono) runtime that their Wine installation provides to each new Windows environment. Wine Mono resolves XNA 4.0 references to its own XNA assemblies, which are built on FNA, so Play installs no Microsoft XNA or .NET Framework redistributable and does not run the installers that some games ship for them. They keep their own private writable files and Windows environments, and C# decompilation stays available with them. [Windows Game](WINDOWS.md#windows-executables-in-other-game-types) describes how they are offered.

## Module source

The FNA module's engine behavior and tools are plain Node services under `src/modules/fna/`.

## Primary sources

- [FNA 26.10 source](https://github.com/FNA-XNA/FNA/tree/26.10)
- [Official monthly source archives](https://fna.flibitijibibo.com/archive/)
- [FNA on Apple platforms](https://fna-xna.github.io/docs/appendix/Appendix-C%3A-FNA-on-Apple-Platforms/)
- [FNA and Windows APIs](https://fna-xna.github.io/docs/4%3A-FNA-and-Windows-API/)
- [Distributing FNA games](https://github.com/FNA-XNA/docs/blob/main/docs/3%3A-Distributing-FNA-Games.md)
- [Microsoft .NET 8 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json)
- [Microsoft CLR architecture flags](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.portableexecutable.corflags)
- [ILSpy command-line package on NuGet](https://www.nuget.org/packages/ilspycmd)
- [Microsoft .NET macOS support](https://learn.microsoft.com/en-us/dotnet/core/install/macos)
- [Official SDL 3.4.18 release](https://github.com/libsdl-org/SDL/releases/tag/release-3.4.18)
