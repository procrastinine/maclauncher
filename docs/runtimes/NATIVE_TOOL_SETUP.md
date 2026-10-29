# Native runtime and tool setup

Game runtimes and versioned tools are managed packages. Play or an inspector action requests consent for a missing version, installs it and resumes. Installed packages run offline without a compiler, Homebrew, source checkout or developer tools. The launcher never installs development tools.

`userData` normally means `~/Library/Application Support/maclauncher/`. Managed runtimes and tools live in `userData/runtimes/<managerId>/<version>/`; game-specific staging, saves and reports live in `userData/games/<gameId>/`. Locally registered runtimes stay at their selected paths, such as `~/Applications/MacLauncher Runtimes/`; [custom runtime layouts](CUSTOM_RUNTIME_LAYOUTS.md) lists the accepted forms.

## Package sources

MacLauncher Builds produces the adapted Mac packages from pinned upstream sources and owned overlays. Its [repository](https://github.com/procrastinine/maclauncher-builds) holds each package's build recipe, source pins, dependency definitions and license notices. Upstream publisher releases install unchanged. Both kinds of package appear in the same Runtimes lists and share consent, installation and offline reuse.

## System components

- **Rosetta:** Intel-only runtimes on Apple Silicon use Apple's system translator. Play offers installation after explicit license consent, then resumes the game; installed Rosetta is reused. macOS installs it under `/Library/Apple/`, outside launcher data. The equivalent manual command is `/usr/sbin/softwareupdate --install-rosetta` in Terminal. [Rosetta](ROSETTA.md) describes the shared check; Apple's [installation guide](https://support.apple.com/en-us/102527) describes the system prompt.
- **Metal compiler:** Switch preparation uses Apple's Metal compiler when the selected native-tools version requires it. The **Metal compiler** component of **Runtimes → Switch (nxnative)** selects a managed compiler, downloaded from Apple's public macOS MobileAsset catalog after consent, or an existing installed toolchain. Managed compilers use private launcher storage and change no system developer settings; see [nxnative](NXNATIVE.md).
- **Python:** included import, extraction and tool helpers use MacLauncher's embedded Python. Python-based tools need no system Python installation.
- **Official GameMaker runners:** Runtimes installs vendor runners from the official feeds or registers an existing `runtime-<version>` directory. Studio 2 setup installs the vendor's native Igor tool automatically; Studio 1.4 setup decodes its public Mac module without Igor. Launches use the extracted native runner directly; see [GameMaker](GAMEMAKER.md).

## Managed decompilers and inspectors

Inspector actions obtain their managed tools on first use: AliceSoft **Decompile** installs Sys3dc or Xsys35dc, GameMaker **Decompile** installs the UndertaleModTool CLI with its own .NET runtime, and the Java, C#, Flash, Unity, Android and native-program actions install their tools in the same way. Engine-specific tools are tabs in their engine's Runtimes entry, and cross-engine tools are under **Runtimes → Tools**, each with Refresh, explicit version selection and local import. Exports stay in the game's private launcher data. The [tool coverage tables](../GAME_TOOLS.md) list every tool and output.

## GameMaker software OpenGL

An official runner's accelerated-only pixel-format request can fail when the requested graphics format is unavailable. Apple's [pixel format documentation](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/OpenGL-MacProgGuide/opengl_pixelformats/opengl_pixelformats.html) describes format selection and nil results when a request cannot be satisfied.

The helper calls the original initializer first. Only after a nil result does it retry without the acceleration requirement, preserving the other attributes. Each helper package declares the runner checksums it supports and its logical-coordinate ABI. Original AppKit converters still run, and successful hardware formats and unrelated views retain their conversions. The helper keeps Apple's software renderer and the original game shaders.

**Graphics fallback** in the official runner's Runtime Settings offers Automatic, Enabled and Disabled. Automatic loads the helper for runners whose checksum the selected helper supports; Enabled also requests it for other runners; Disabled omits it. The helper applies to the separately staged, ad-hoc-signed runner through `DYLD_INSERT_LIBRARIES`; the installed vendor runner and system libraries remain untouched. Helper packages are listed under **Runtimes → GameMaker → Graphics helper** from the [Builds catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/catalogs/gamemaker-opengl-helper.json), and Play installs a missing helper after consent.

## Native Steam API helper

Compatible Steam consumers read the included `0.5.0` offline API library directly. The included encrypted-ticket loader rejects authentication and decryption requests. No SDK, compiler or helper installation is needed. [Steam support](STEAM_API.md) describes the supported interfaces and consumer profiles; [Development](../DEVELOPMENT.md) covers rebuilding included helpers from source.
