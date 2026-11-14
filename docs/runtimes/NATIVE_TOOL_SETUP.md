# Native runtime and tool setup

This page describes where runtimes and tools come from, where MacLauncher installs them, and the system components and helpers that some of them depend on. Game runtimes and tools are packages that MacLauncher downloads and installs as described in [Downloads and offline use](README.md#downloads-and-offline-use).

All of them live under `userData`, which normally means `~/Library/Application Support/maclauncher/`. Downloaded runtimes and tools are installed in `userData/runtimes/<managerId>/<version>/`, and each game's prepared files, saves and reports are kept in `userData/games/<gameId>/`. Locally registered runtimes are the exception: they stay where they were selected, for example in `~/Applications/MacLauncher Runtimes/`. [Custom runtime layouts](CUSTOM_RUNTIME_LAYOUTS.md) lists the forms they can take.

## Package sources

Runtimes and tools that need changes to run on macOS come from [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds), a companion repository that compiles each one from an exact upstream commit with MacLauncher's changes applied. That repository also holds each package's build script, upstream commit, dependency definitions and license notices. Everything else is the publisher's own release, installed unchanged. Both kinds appear in the same **Runtimes** lists and install the same way. [Runtime distribution](RUNTIME_DISTRIBUTION.md) lists where each one comes from.

## System components

Some runtimes depend on components that macOS or Apple supplies.

### Rosetta

Intel-only runtimes on Apple silicon run through Rosetta, Apple's system translator. When Rosetta is missing, Play offers to install it, which requires accepting Apple's license, and then starts the game. macOS installs Rosetta under `/Library/Apple/`, outside the launcher's data. The equivalent manual command is `/usr/sbin/softwareupdate --install-rosetta` in Terminal. [Rosetta](ROSETTA.md) describes the shared check, and Apple's [installation guide](https://support.apple.com/en-us/102527) describes the system prompt.

### Metal compiler

Some versions of the Nintendo Switch native tools need Apple's Metal compiler to prepare a game. The **Metal compiler** component of **Runtimes → Switch / Switch 2 (nxnative)** chooses where it comes from: either MacLauncher downloads it from Apple's public macOS MobileAsset catalog, or a toolchain already installed on the Mac is used. A downloaded compiler is kept in private launcher storage and changes no system developer settings. [Nintendo Switch](../game-types/SWITCH.md) describes the runtime.

### Python

The included import, extraction and tool helpers use MacLauncher's embedded Python, so Python-based tools need no system Python.

### Official GameMaker runners

Official GameMaker runners are installed in **Runtimes** from the vendor's feeds, or an existing `runtime-<version>` directory can be registered instead. For Studio 2, setup installs the vendor's native Igor tool automatically, while Studio 1.4 setup decodes the public Mac module without Igor. Games then launch with the extracted native runner directly. [GameMaker](../game-types/GAMEMAKER.md) describes the runners.

## Decompilers and inspectors

Inspector actions install the tools they need the first time they are used. For example, AliceSoft **Decompile** installs Sys3dc or Xsys35dc, and GameMaker **Decompile** installs the UndertaleModTool CLI together with its own .NET runtime. The Java, C#, Flash, Unity, Android and native-program actions install their tools the same way. Every tool also supports Refresh, explicit version selection and local import. The [tool tables](../tools/README.md) list every tool, its output and [where it appears in **Runtimes**](../tools/README.md#where-tools-appear-in-runtimes).

## GameMaker software OpenGL

An official GameMaker runner can request a pixel format that allows only hardware acceleration, and that request fails when no such format is available. Apple's [pixel format documentation](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/OpenGL-MacProgGuide/opengl_pixelformats/opengl_pixelformats.html) describes format selection and the nil result returned when a request cannot be satisfied.

MacLauncher's graphics helper works around this failure. It calls the original initializer first, and only when that returns nil does it retry without the acceleration requirement, keeping the other attributes. In that case the helper uses Apple's software renderer with the game's original shaders. Each helper package declares which runner versions use its logical-coordinate ABI. The original AppKit converters still run, so successful hardware formats and unrelated views keep their usual conversions.

**Graphics fallback** in the official runner's **Runtime Settings** has three values:

- **Automatic** loads the helper for runners whose executable links the OpenGL framework.
- **Enabled** also loads it for other runners.
- **Disabled** never loads it.

The helper is loaded through `DYLD_INSERT_LIBRARIES` into a separate, ad-hoc-signed copy of the runner, which leaves the installed vendor runner and the system libraries unmodified. Helper packages are listed under **Runtimes → GameMaker → Graphics helper** from the [MacLauncher Builds catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/catalogs/gamemaker-opengl-helper.json), and Play installs a missing helper when needed.

## Native Steam API helper

Compatible games that call the Steam API load the included `0.5.0` offline API library directly. A second included library, the encrypted-ticket loader, rejects authentication and decryption requests. [Steam API support](STEAM_API.md) describes both helpers and their supported interfaces, and [development](../development/DEVELOPMENT.md) covers rebuilding them from source.
