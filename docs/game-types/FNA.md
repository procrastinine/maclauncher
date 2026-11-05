# FNA / XNA 4

This game type covers managed .NET games written for XNA 4 or for FNA. MacLauncher's `fna` module runs them natively on Apple Silicon through .NET and [FNA](https://github.com/FNA-XNA/FNA), which provides the XNA game API, graphics, audio and input.

## Detection and versions

A PE/CLI reader with fixed limits parses ECMA-335 metadata without loading the game. It reports:

- the game assembly version;
- the reachable FNA or XNA reference;
- the bundled or embedded FNA assembly version;
- the target framework and CLR metadata;
- the original PE architecture and 32-bit requirements;
- Windows desktop API types;
- exact native P/Invoke library and symbol names, with the assembly or embedded resource they come from.

A string that only mentions `FNA.dll` is not enough to match. Detection follows at most 32 assembly sources and three dependency levels, and checks executable and runtime-config pairs first in self-contained exports.

Embedded DLLs are read as byte ranges inside their original PE, including nested resources; detection never extracts or runs them. Other game types share this reader, which normally inspects metadata only; for FNA it also reads resource descriptors and reuses the detection session's file, byte and result caches. A change to the parent PE or to the FNA detection code refreshes the stored facts once.

Inspection reads at most 32 MiB and accepts embedded DLLs up to 8 MiB each. Referenced dependencies that are compressed, malformed, mismatched or over the limit are listed in `dependencyInspection`. When their requirements cannot be inspected safely, Play stops before installing a runtime. Dependency CLR architecture flags are recorded separately from the entry point's original flags.

The game's assembly versions, FNA references, target frameworks and CLR metadata are recorded separately from the selected host. A CLR metadata string such as `v4.0.30319` does not identify an installed runtime.

## Preparation

Play uses the original game directory for content, configuration, relative file access and working data. Portable assemblies run from their original paths. The installed FNA host and the selected framework stay in the managed runtime package; preparation neither copies them into a game folder nor links game assets.

Portable x64 PE32+ assemblies need conversion only for the ARM64 host. Their CLR metadata must be IL-only, allow a 64-bit host and contain neither a native entry point nor managed native or ReadyToRun code. Only the PE machine field changes, in a converted copy under `userData/games/<gameId>/modules/fna/assemblies/`. Preparation examines the entry assembly and the managed dependencies it reaches, not the game’s assets. Intel hosts use compatible x64 assemblies directly.

When conversion is needed, the host looks among the converted assemblies first, then in the original game directory. The original directory remains the working directory and application base directory even when the entry assembly needs conversion. Selected FNA and XNA facades load from the runtime package. The host’s .NET configuration disables roll-forward.

Conversion inputs and outputs are checked before reuse. A file whose precise identity is unchanged reuses its recorded checksum, and a file with only coarse timestamps is checked byte by byte. Unchanged inputs are not copied again. When a source changes during hashing or copying, the earlier converted files stay intact, and a converted copy that was modified is kept rather than overwritten.

Files in the private overlays of earlier MacLauncher versions are recovered once into the original game directory, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. Missing files are restored; an original file that differs stays unchanged, and the private version is kept beside it as a separate copy. When recovery would be unsafe or the original folder is unavailable, the private data stays intact. Play does not read these earlier overlays.

### Steam API

When the game imports the [Steam API](../runtimes/STEAM_API.md), MacLauncher sets up a Mac Steam API library automatically; a DLL name alone does not trigger it. The game's own compatible Mac library takes priority. Otherwise, the included helper supplies the supported exports after checking the game process's CPU and the game's local App ID. Small per-game aliases handle [CLR library-name probing](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/native-library-loading), including Windows `.dll` names, without changing the game or copying the helper. Local Steam state stays under the game's module data. Each native export and encrypted-ticket library keeps its own dependency requirement.

## Settings

Graphics selection is automatic. Runtime Settings provide:

- **Use selected FNA framework**, the per-game opt-out from framework substitution.
- **Convert portable x64 assemblies**, the per-game opt-out from portable IL conversion.
- **Allow software OpenGL** and **Graphics driver** (Automatic or OpenGL).
- **Game arguments**.

## Compatibility limits

Portable managed games run with automatic framework substitution and IL conversion. Windows Forms, WPF, native Windows DLLs and 32-bit CLR execution need the [Windows runtimes](#crossover-and-sikarugir-wine), and the native FNA runtime has no XNA video decoder. C# decompilation is available for every inspected managed assembly.

The checks for Windows desktop APIs cover Windows Forms, WPF dispatchers and System.Drawing graphics; the portable drawing structs remain usable. The `32BITREQUIRED` header flag is kept as recorded; it declares the CLR process architecture a game requires but does not, on its own, prove a native pointer layout. Games that convert callback pointers to 32-bit integers or import x86 Windows DLLs need compatible API implementations and calling conventions, which portable IL conversion does not supply.

## Decompilation

The inspector's **Decompile** action runs [ILSpy](https://github.com/icsharpcode/ILSpy) on a .NET host. **Runtimes → Tools → ILSpy**, shared with [Unity](UNITY.md#source-export), lists the ILSpy versions. Reload checks ILSpy's NuGet history, within fixed limits, together with each package's target framework and publisher digest. When no version is listed or installed yet, the first decompilation checks that history after download consent and installs the newest compatible release. Each listed version records its host requirements, and changing the decompiler does not change the FNA runtime.

| ILSpy target framework | .NET host | macOS |
| --- | --- | --- |
| .NET **8** | Reuses an installed FNA runtime with a matching .NET **8** host | The installed FNA runtime's minimum |
| .NET **8** or later, without a matching FNA host | Separate Apple Silicon or Intel host for the same .NET major version, using the newest runtime that Microsoft lists for that version | The minimum that the host's own binaries declare, read at installation |

A package that contains builds for several frameworks uses the newest supported framework. When NuGet's metadata omits the package's file list, the framework is read from the downloaded package. A version published as separate runtime-specific packages, where `ilspycmd` itself holds only a pointer to them, installs from its framework-dependent `ilspycmd.any` package. Versions that target only a framework older than .NET 8 are listed with the reason they cannot be installed.

Tools install under `userData/runtimes/fna-tools/ilspy/<version>/`, and the separate shared hosts under `userData/runtimes/dotnet-tools/<version>/<architecture>/`, where the architecture is `arm64` or `x64`, so hosts for both architectures can be installed side by side. No .NET SDK is required, and tool update checks are disabled.

C# project exports go to `userData/games/<gameId>/modules/fna/decompiled/<toolVersion>/`. Each export records the original assembly, its version and hash, and the exact tool and runtime used. An existing export that has been edited is preserved before a new export replaces it. Decompilation never runs the game, so it also works for managed games the native host cannot launch, including assemblies flagged for a 32-bit CLR. **Reveal source** opens the export.

The same action is available through the core API and as `pnpm launch --game <path> --action decompile`. The optional JSON payload `{"version":"9.1.0.7988"}` chooses an explicitly listed tool version.

## Runtimes

### FNA

FNA is the default runtime. MacLauncher Builds supplies complete runtime packages, and **Runtimes → FNA** lists them separately from the upstream FNA source releases, which appear for reference.

Each package contains .NET, FNA, the managed host, the supported XNA type-forwarding facades and the native graphics and audio libraries. It also includes the stock shader resources declared by upstream `FNA.Core.csproj`, and the host resolves native libraries by their canonical ABI names. Runtime packages contain no game assets, and Runtimes lists each package's architectures and minimum macOS.

The selected host must declare support for original game paths in its runtime profile. When the installed host lacks it, Play offers a compatible package and installs it after download consent. The host uses the game's entry assembly identity for FNA storage and content discovery.

Packages install under `~/Library/Application Support/maclauncher/runtimes/fna/<architecture>/<version>/`. Downloaded packages use their catalog archive digest, safe declared paths and actual native requirements; their recorded file lists do not pin installation or Play. Each installation records its FNA, .NET, host, package and native versions, the upstream source and MacLauncher changes it was built from, and the hashes of critical dependencies.

Game launches set the [SDL foreground hint](https://wiki.libsdl.org/SDL3/SDL_HINT_MAC_BACKGROUND_APP) for the game process only and use the shared native activation helper. The helper waits for a window owned by the game, makes at most one [AppKit activation request](https://developer.apple.com/documentation/appkit/nsapplication/activationoptions) and checks the actual foreground order. It gives up after eight seconds or when the game exits, never holds up the launcher, and neither requests Accessibility access nor changes system preferences.

### Game's macOS app

An imported macOS app that ships its own executable, including one started by a shell launcher, runs that executable by default. A containing folder with one recognized app can be imported directly. The FNA runtime remains available for compatible game data. ReShade effects apply through the shared launch controls without replacing the supplied runtime.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows exports can use [Sikarugir (Wine)](../runtimes/SIKARUGIR.md) or an available [CrossOver](../runtimes/CROSSOVER.md) application instead, including games whose Windows-only dependencies prevent native FNA playback. These runtimes keep their own private writable files and Windows environments, and C# decompilation stays available. [Windows Game](WINDOWS.md#windows-executables-in-other-game-types) describes how they are offered.

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
