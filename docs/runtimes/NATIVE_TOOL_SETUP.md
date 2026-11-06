# Native runtime and tool setup

Game runtimes and tools are packages that MacLauncher downloads and installs as described in [Downloads and offline use](README.md#downloads-and-offline-use).

`userData` normally means `~/Library/Application Support/maclauncher/`. Downloaded runtimes and tools are installed in `userData/runtimes/<managerId>/<version>/`, and game-specific prepared files, saves and reports are kept in `userData/games/<gameId>/`. Locally registered runtimes stay where they were selected, for example in `~/Applications/MacLauncher Runtimes/`. [Custom runtime layouts](CUSTOM_RUNTIME_LAYOUTS.md) lists the accepted forms.

## Package sources

Runtimes and tools that need changes to run on macOS come from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds), which builds them from an exact upstream commit with MacLauncher's changes applied. Its repository holds each package's build script, upstream commit, dependency definitions and license notices. The others are the publishers' own releases, installed unchanged. Both kinds appear in the same **Runtimes** lists and install the same way. [Runtime distribution](RUNTIME_DISTRIBUTION.md) lists where each one comes from.

## System components

Some runtimes depend on components that macOS or Apple supplies.

### Rosetta

Intel-only runtimes on Apple silicon use Rosetta, Apple's system translator. If it is missing, Play offers to install it, which requires accepting Apple's license, and then starts the game. macOS installs Rosetta under `/Library/Apple/`, outside the launcher's data. The equivalent manual command is `/usr/sbin/softwareupdate --install-rosetta` in Terminal. [Rosetta](ROSETTA.md) describes the shared check, and Apple's [installation guide](https://support.apple.com/en-us/102527) describes the system prompt.

### Metal compiler

Nintendo Switch preparation uses Apple's Metal compiler when the selected native-tools version requires it. The **Metal compiler** component of **Runtimes → Switch / Switch 2 (nxnative)** selects either a compiler that MacLauncher downloads from Apple's public macOS MobileAsset catalog, or a toolchain already installed on the Mac. A downloaded compiler is kept in private launcher storage and changes no system developer settings. [Nintendo Switch](../game-types/SWITCH.md) describes the runtime.

### Python

The included import, extraction and tool helpers use MacLauncher's embedded Python, so Python-based tools need no system Python.

### Official GameMaker runners

**Runtimes** installs official GameMaker runners from the vendor's feeds or registers an existing `runtime-<version>` directory. Studio 2 setup installs the vendor's native Igor tool automatically, and Studio 1.4 setup decodes its public Mac module without Igor. Launches use the extracted native runner directly. [GameMaker](../game-types/GAMEMAKER.md) describes the runners.

## Decompilers and inspectors

Inspector actions install the tools they need on first use. AliceSoft **Decompile** installs Sys3dc or Xsys35dc, GameMaker **Decompile** installs the UndertaleModTool CLI with its own .NET runtime, and the Java, C#, Flash, Unity, Android and native-program actions install their tools the same way. Each tool has Refresh, explicit version selection and local import. The [tool tables](../tools/README.md) list every tool, its output and [where it appears in **Runtimes**](../tools/README.md#where-tools-appear-in-runtimes).

## GameMaker software OpenGL

When an official GameMaker runner requests an accelerated-only pixel format that is not available, the request can fail. Apple's [pixel format documentation](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/OpenGL-MacProgGuide/opengl_pixelformats/opengl_pixelformats.html) describes format selection and the nil result returned when a request cannot be satisfied.

The graphics helper calls the original initializer first. Only when it returns nil does the helper retry without the acceleration requirement, keeping the other attributes. Each helper package declares the runner versions that use its logical-coordinate ABI. The original AppKit converters still run, and successful hardware formats and unrelated views keep their conversions. The helper uses Apple's software renderer with the game's original shaders.

**Graphics fallback** in the official runner's **Runtime Settings** has three values:

- **Automatic** loads the helper for runners whose executable links the OpenGL framework.
- **Enabled** also loads it for other runners.
- **Disabled** never loads it.

The helper is loaded through `DYLD_INSERT_LIBRARIES` into a separate, ad-hoc-signed copy of the runner, so the installed vendor runner and the system libraries are not modified. Helper packages are listed under **Runtimes → GameMaker → Graphics helper** from the [MacLauncher Builds catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/catalogs/gamemaker-opengl-helper.json), and Play installs a missing helper when needed.

## Native Steam API helper

Compatible games that call the Steam API load the included `0.5.0` offline API library directly, and the included encrypted-ticket loader rejects authentication and decryption requests. [Steam API support](STEAM_API.md) describes both helpers and their supported interfaces, and [development](../development/DEVELOPMENT.md) covers rebuilding them from source.
