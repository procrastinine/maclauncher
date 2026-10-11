# FNA / XNA 4 managed games

The `fna` module supplies a native .NET/FNA host for compatible managed games on Apple Silicon. Import and inspection stay offline. Play checks compatibility before requesting a missing runtime download, then performs the required preparation automatically. Included profiles need no installation, compiler, SDK or network request. Engine behavior and tools are pure Node services under `src/modules/fna/`; no Electron or renderer dependency is required.

Game launches set the child-only [SDL foreground hint](https://wiki.libsdl.org/SDL3/SDL_HINT_MAC_BACKGROUND_APP) and use the shared native activation helper. The helper waits for an owned window, makes at most one [AppKit activation request](https://developer.apple.com/documentation/appkit/nsapplication/activationoptions), and checks actual foreground ordering. Its eight-second bound and exit cancellation run outside the launcher response; it does not request Accessibility or change system preferences.

## Detection and versions

The bounded PE/CLI reader parses ECMA-335 metadata without loading the game. It reports the game assembly version, reachable FNA/XNA reference, bundled or embedded FNA assembly version, target framework, CLR metadata, original PE architecture and 32-bit requirements. It also records Windows desktop API types and exact native P/Invoke library/symbol names with their assembly or embedded-resource source. A string mentioning `FNA.dll` is insufficient. Detection follows at most 32 assembly sources and three dependency levels, prioritizing executable/runtime-config pairs in self-contained exports.

Embedded DLLs are byte ranges in their original PE, including nested resources. Detection does not extract or execute them. The shared reader defaults to ordinary metadata-only inspection; FNA explicitly enables resource descriptors and reuses the detection session's file, byte and result caches. A changed parent PE or FNA detection implementation refreshes persisted facts once. Inspection reads at most 32 MiB and accepts embedded DLLs up to 8 MiB each. Referenced compressed, malformed, mismatched or over-limit dependencies remain explicit in `dependencyInspection`; Play stops before runtime installation when their requirements cannot be inspected safely. Dependency CLR architecture flags remain separate from the entrypoint's original flags.

Game assembly versions, FNA references, target frameworks and CLR metadata stay separate from the selected host. The pinned native host uses FNA `26.10.0.0`, .NET `8.0.31` and exact profile `26.10-net8-arm64-v2`. A CLR metadata string such as `v4.0.30319` does not identify an installed runtime. The retired v1 profile is preserved as version evidence; v2 includes every stock shader resource declared by the upstream project and resolves native libraries by their canonical ABI names.

The ordinary shared GitHub tag provider lists monthly source history on explicit Reload. The pinned 26.10 ARM64 profile is installable; earlier source tags remain inspectable without pretending they are compatible native packages. The known broken v1 selection upgrades to exact v2 with `upgradedFromVersion` evidence, retaining its original records. Other explicit versions never fall back to an installed profile.

## Runtime installation

The complete ARM64 distribution package includes .NET, FNA, the managed host, supported XNA type-forwarding facades and native graphics/audio libraries. Play verifies the sealed inventory and runs directly from the included, read-only resources. No runtime copy or download is needed. Existing managed installations under `~/Library/Application Support/maclauncher/runtimes/fna/<profile>/` retain priority. No game assets are included in runtime packages.

Development installations can build the same pinned profile when a bundle is absent. The builder downloads the official .NET 8.0.31 runtime, Roslyn 4.8 reference/compiler packages and SDL 3.4.18 source with pinned SHA-256 identities. Missing CMake/Ninja tools download automatically. Only the development source path requires Apple's Command Line Tools/macOS SDK; the packaged application does not. Source checkouts remain read-only, and builds use temporary local workspaces.

FNA source is pinned to `651c0ffdf4db43cd112865ad368c5d6cc3dc7558` (26.10) with its nested source dependencies. Install records framework/host/native versions, source and overlay identities, and critical dependency hashes. The pinned ARM64 package has a verified macOS 13.0 deployment floor and includes the stock shader resources declared by `FNA.Core.csproj`. An Intel runtime package is unavailable.

## Automatic preparation

Play replaces a legacy FNA framework or supplies supported XNA 4 facades in a small per-game overlay under `userData/games/<gameId>/modules/fna/overlays/`. Content, Images, Audio, Fonts, Resources and other immutable files are referenced from the original game. Linked asset trees are not scanned file by file on each launch; new and changed assets are visible directly. Files that need conversion and mutable configuration are copied into the overlay.

Copied inputs use cached content checksums. Unchanged files avoid repeated hashing or copying, and identical bytes reuse the overlay when filesystem metadata changes. Changed configuration or converted assemblies refresh only the affected game. Changes to copied inputs during hashing or copying stop preparation before replacing the current overlay.

Portable x64 PE32+ assemblies are converted automatically when their CLR metadata is IL-only, supports a 64-bit host and has no native entry point or managed native/ReadyToRun code. Only the PE machine field changes in the owned file. Both framework substitution and portable IL conversion have explicit per-game opt-outs. Originals remain unchanged. Updated overlays retain earlier local writes under `previous-overlays/`, and forgetting a game removes its owned module data.

The managed host resolves game assemblies from the overlay and native dependencies from the exact installed runtime. It prefers canonical ABI library names so SDL is loaded once across the host, FNA3D and FAudio. The host's .NET configuration disables roll-forward. Graphics selection is automatic; OpenGL, software OpenGL and game arguments remain configurable.

Actual Steam API imports trigger the shared native dependency automatically. The original game's compatible Mac library takes priority; otherwise the included helper supplies supported exports after checking the child's CPU and game-local App ID. Tiny per-game aliases handle [CLR library-name probing](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/native-library-loading), including Windows `.dll` names, without changing the game or copying the helper. Local Steam state stays under the game's own module data. DLL names alone do not trigger setup, and unsupported exports or encrypted-ticket libraries remain explicit requirements.

## Decompilation

The inspector's **Decompile** action confirms missing [ILSpy](https://github.com/icsharpcode/ILSpy) or .NET host downloads, installs them automatically, then continues. **Runtimes → ILSpy** provides explicit version choices and **Set default**, shared by FNA and Unity. Reload checks the bounded NuGet history and each package's target framework and publisher digest; unsupported host versions remain listed with a reason.

The default remains ILSpy **9.1.0.7988**, reusing FNA's .NET **8.0.31** host, including on macOS **13** when that included host is available. ILSpy **11.1.0.9782** uses a separate ARM64 .NET **10.0.12** host; new standalone hosts require macOS **14** or later. Changing the decompiler does not change the FNA runtime. Tools install under `userData/runtimes/fna-tools/ilspy/<version>/`; separate shared hosts use `userData/runtimes/dotnet-tools/<version>/arm64/`. No .NET SDK is required. Installed versions work offline and tool update checks are disabled.

C# project exports go to `userData/games/<gameId>/modules/fna/decompiled/<toolVersion>/`. Each export records original assembly/version/hash and exact tool/runtime provenance. Existing edited exports are retained before replacement. Decompilation does not execute the game, and remains usable for managed games the native host cannot launch, including assemblies flagged for a 32-bit CLR. The same action is callable through the headless core API or `pnpm launch --game <path> --action decompile`. Optional JSON payload `{"version":"9.1.0.7988"}` chooses an explicitly listed tool version.

## Compatibility limits

Portable managed exports can use automatic framework/IL conversion, C# export and native execution when their inspected requirements fit the selected profile. FNA API, audio, video and save compatibility remain dependent on the game's actual requirements.

FNA provides the XNA game API, graphics, audio and input. It does not provide every Windows desktop API, native Windows DLL or CLR execution model. Those requirements are surfaced before an unsuitable runtime download. Avatar, GamerServices/networking and newer .NET host targets are also outside the pinned profile. The current native build omits Theorafile/dav1dfile (`videoSupport: false`); video playback is unsupported. Save formats and cheat APIs vary by game; no generic FNA save codec or cheat injector is claimed.

Windows desktop checks include Forms, WPF dispatchers and System.Drawing graphics; portable drawing structs remain usable. The `32BITREQUIRED` header flag is retained. It declares a required CLR process architecture and does not by itself prove a native pointer layout. Converting callback pointers to 32-bit integers or importing x86 Windows DLLs requires compatible API implementations and caller conventions beyond portable IL conversion.

## Primary sources

- [FNA 26.10 source](https://github.com/FNA-XNA/FNA/tree/26.10)
- [Official monthly source archives](https://fna.flibitijibibo.com/archive/)
- [FNA on Apple platforms](https://fna-xna.github.io/docs/appendix/Appendix-C%3A-FNA-on-Apple-Platforms/)
- [FNA and Windows APIs](https://fna-xna.github.io/docs/4%3A-FNA-and-Windows-API/)
- [Distributing FNA games](https://github.com/FNA-XNA/docs/blob/main/docs/3%3A-Distributing-FNA-Games.md)
- [Microsoft .NET 8 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json)
- [Microsoft CLR architecture flags](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.portableexecutable.corflags)
- [ILSpy 9.1.0.7988 managed package](https://www.nuget.org/packages/ilspycmd/9.1.0.7988)
- [ILSpy 11.1.0.9782 managed package](https://www.nuget.org/packages/ilspycmd/11.1.0.9782)
- [Microsoft .NET macOS support](https://learn.microsoft.com/en-us/dotnet/core/install/macos)
- [Official SDL 3.4.18 release](https://github.com/libsdl-org/SDL/releases/tag/release-3.4.18)
