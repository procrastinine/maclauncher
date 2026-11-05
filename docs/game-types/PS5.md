# PlayStation 5

This game type covers unpacked, decrypted PS5 games, plus PS5 PKG archives for inspection. Two runtimes can play an unpacked game: the default, [AnyPS5](#anyps5), converts the game's programs into macOS executables, and the optional [Prosper](#prosper) runs the original programs directly. Detection and the inspector tools belong to the game type, so they stay available with either runtime.

## Accepted inputs

MacLauncher identifies an unpacked PS5 game from its `sce_sys/param.json` metadata and its PS5 ELF or SELF executable. Import accepts the game folder or its `eboot.elf`, `eboot.bin` or `eboot.self` file. Ordinary Linux ELF and macOS executables do not match this format.

In a folder with that metadata, programs are identified by their ELF or SELF headers, so files with other names or extensions are also recognized. A folder already prepared for AnyPS5, with the original executable and modules in `source/` and the assets in `app0/`, is recognized as well.

PS5 PKG archives can be imported as well, but only for package inspection: Play and decompilation need unpacked, decrypted input, and MacLauncher does not decrypt encrypted PS5 content. Inputs that support only inspection use the **Inspect only** runtime, which does not launch anything.

## Inspector tools

For a PKG archive, **Inspect package** reads the FIH, CNT and PFS headers, with fixed read limits, without downloading a runtime or extracting the package. Its report covers signing, filesystem encryption when a readable superblock establishes it, and whatever container metadata is available. When the title ID is inferred from the file name, it is labeled with that source. A package without CNT metadata is reported as such, but it is not treated as corrupt for that reason alone. For an encrypted package, the report shows the reason, and the package cannot be converted or decompiled.

Once an AnyPS5 conversion exists, **Inspect program** exports the program metadata and the import registry.

**Decompile** uses the shared [Rizin/Ghidra tools](../tools/NATIVE_INSPECTION.md) to export ELF metadata, imports, symbols, strings, functions and C pseudocode, and it extracts SELF files with the selected AnyPS5 package. The pseudocode does not reconstruct an original source project.

**Show export** reveals the latest inspection output.

## Runtimes

| Runtime | Delivery | Requirements |
| --- | --- | --- |
| **PS5 (AnyPS5)**, default | Packages from MacLauncher Builds | macOS 26 or later on Intel or Apple Silicon; Vulkan with Intel support |
| **Prosper** | Packages from MacLauncher Builds or a local build registered in Runtimes | macOS 26 or later on Intel or Apple Silicon; Vulkan 1.4 with Intel support |

### AnyPS5

[AnyPS5](https://github.com/boykopovar/AnyPS5), which appears in MacLauncher as **PS5 (AnyPS5)**, converts the x86-64 PS5 executable and its bundled modules into Mach-O files. The converter itself follows the selected package's CPU, but converted games and PS5 system libraries use x86-64. As a result, both the Intel converter and the game run natively on Intel Macs, without Rosetta, while Apple Silicon runs converted games under [Rosetta](../runtimes/ROSETTA.md); if Rosetta is missing, the system consent flow installs it. On both Mac architectures, AnyPS5 requires macOS 26 or later and a Vulkan build with Intel support.

#### Versions

AnyPS5 versions are supplied by MacLauncher Builds and need no Python installation. **Refresh** reads them from the MacLauncher Builds catalog.

#### Preparation and saves

Because AnyPS5 is a PS5 runtime and not a native macOS game engine, each game needs a runtime container of its own, which preparation builds. Game resources are copied into the container's `app0/` folder, and the PS5 executables and nested modules are converted into Mach-O files, while the original programs stay unchanged. The conversion is cached, keyed by the game input and by the contents of AnyPS5's relinker and SELF extraction helper. As a result, runtime versions with identical converter inputs reuse the same conversion. Changes to the copied resources are preserved when the conversion is updated. The container reaches the shared runtime libraries through a directory link, so they follow the selected install.

AnyPS5 runs with the container as its working directory. The runtime's `/data` path uses the game's private save directory, and `_sd` uses a subfolder of it; an explicit save-location setting redirects both paths into the chosen save folder instead. Save-data memory, however, stays in the container's `launch/_sd_mem/`, keyed by user and slot and kept separate from the original game files.

A game can also carry PlayGo metadata, which describes which game chunks are installed. AnyPS5 treats any chunk that this metadata does not list as installed, and does the same for dumps that have no PlayGo metadata. An explicit `APS5_PLAYGO_UNLISTED_CHUNKS` environment value takes precedence over this default.

#### Vulkan

Because ARM-only Vulkan libraries cannot load into AnyPS5's x86-64 game process, its **Vulkan** setting selects an installed Vulkan implementation with Intel support. The list shows the installed implementations, and Automatic prefers a compatible KosmicKrisp, which it offers to download when needed. **Settings → PlayStation 5 → PS5 (AnyPS5)** sets the default for all games, and each game's runtime settings can override it.

#### Controller bindings

So that a keyboard and mouse can stand in for the PS5 controller, runtime settings include editable keyboard, mouse and wheel bindings for it. Each game inherits the module defaults and can override them or reset to them. Physical controllers keep working alongside the bindings, and changes to bindings and mouse routing apply on the next launch.

The face buttons form a diamond on the keyboard: I, J, K and L sit where Triangle, Square, Cross and Circle sit on the controller. The main defaults are:

| Controller input | Default bindings |
| --- | --- |
| Cross | K, Space, Return |
| Circle | L, C |
| Triangle | I |
| Square | J, right click |
| L1 / R1 | Q / E |
| L2 | R |
| R2 | U, left click |
| L3 / R3 | Shift / Ctrl |
| Options | Escape |
| Left stick | W, A, S, D |
| Right stick | T (up), G (down), F (left), H (right) |
| D-pad | Arrow keys |
| Touchpad left / right zone | Backspace / Tab |
| Touchpad click | V, on runtimes with touchpad key support |

The same settings window shows every other binding, and the [settings reference](../runtimes/SETTINGS_REFERENCE.md#ps5-anyps5-settings) lists all of them.

Binding fields accept comma-separated key names such as `Return, Space`, mouse names such as `Mouse Left`, and wheel directions such as `Wheel Up`; the comma key itself is named `Comma`. A blank field restores its default, although the optional stick modifier has no default binding. MacLauncher writes the bindings to AnyPS5's existing input configuration.

#### Mouse input

**Mouse input** chooses how the mouse reaches the game. The two routes are exclusive, so a click never triggers both:

- **Controller bindings** maps mouse buttons and wheel events to controller inputs, and captured mouse motion moves the right stick.
- **Native mouse** sends movement, buttons and wheel events to the game's own mouse API.
- **Automatic** keeps the selected runtime's default. Runtimes that support routing use controller bindings on macOS, even when a game opens the native mouse API.

Choosing a route explicitly requires a runtime with that capability.

At first, the pointer is visible and not captured, and F7 or a middle click toggles capture for the selected route. Buttons assigned to capture are reserved for it, so a native-mouse game receives the middle button only after it is removed from the capture binding. Releasing capture restores the pointer, and an explicit release persists across focus changes.

### Prosper

Unlike AnyPS5, [Prosper](https://github.com/mattias800/prosper) runs the original PS5 programs directly. It is an optional runtime: a 64-bit Intel macOS executable that runs natively on Intel Macs and under Rosetta on Apple Silicon, and it requires macOS 26 or later and a compatible Vulkan 1.4 build with Intel support. AnyPS5 remains the default, and selecting Prosper keeps the game's PlayStation 5 type and its inspection and decompilation actions.

Prosper packages come from MacLauncher Builds, whose shared Runtime build compiles the exact source and dependency versions declared under `producers/prosper/`, following the upstream build instructions. Each package includes the upstream README, an author and source notice, and dependency notices. Because the runtime executes the game's x86-64 instructions directly, Apple Silicon uses Rosetta instead of an ARM64 Prosper executable.

When Prosper is missing, Play asks for download consent, installs a compatible package and then continues preparation. Saved runtime choices are preserved, and installed packages remain usable offline. Instead of a package, the Runtimes view also accepts a local Prosper executable, app bundle or complete runtime directory. Packaged builds record their exact source revision in the runtime manifest, and launching an already built runtime needs no compiler or SDK. MacLauncher Builds' [verification guide](https://github.com/procrastinine/maclauncher-builds/blob/main/VERIFYING.md) describes the GitHub build records and rebuild comparison.

Prosper opens an ordinary dump and its selected executable directly from the original game folder, which also serves as its working directory. Two kinds of input are handled differently. A prepared AnyPS5 input keeps programs and assets in separate folders, so it requires a merged Prosper input, and a SELF file with a different name requires the `eboot.bin` alias that the runtime expects. The AnyPS5 preparation itself stays unchanged.

Prosper keeps saves in its upstream per-user locations, `savedata0` and `savedata-mem`, under `$XDG_DATA_HOME/prosper` or `$HOME/.local/share/prosper`. In each location, a game's saves have a namespace taken from its declared `PPSA` title ID, and a game with a missing or invalid title ID uses upstream's `_unknown-title` namespace. A save-location override selects separate roots for both save APIs. When games in the library share a save location, import can assign an ordinary save-location override, while explicit choices stay unchanged.

Prosper has three settings, with defaults in Settings and overrides in each game's runtime settings:

- **Vulkan** lists installed implementations. Automatic prefers KosmicKrisp.
- **Frame rate** turns on the runtime's frame-rate display.
- **Configuration file** selects an explicit Prosper configuration file, which is passed through upstream's `PROSPER_APP_CONFIG` input. Without this override, Prosper uses its ordinary shared player preferences under `$XDG_CONFIG_HOME/prosper` or `$HOME/.config/prosper`. A private configuration from MacLauncher 0.5.1 can be recovered once into a separate file, and that file's path is then kept as an ordinary per-game setting.
