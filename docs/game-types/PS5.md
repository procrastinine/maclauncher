# PlayStation 5

This game type covers unpacked, decrypted PS5 games, plus PS5 PKG archives for inspection. Two runtimes can play an unpacked game: the default, [AnyPS5](#anyps5), converts the game's programs into macOS executables, and the optional [Prosper](#prosper) runs the original programs directly. Detection and the inspector tools belong to the game type and stay available with either runtime.

## Accepted inputs

MacLauncher identifies an unpacked PS5 game from its `sce_sys/param.json` metadata and its PS5 ELF or SELF executable. Import accepts the game folder or its `eboot.elf`, `eboot.bin` or `eboot.self` file. Ordinary Linux ELF and macOS executables do not match this format.

In a folder with that metadata, programs are identified by their ELF or SELF headers, so files with other names or extensions are also recognized. A folder already prepared for AnyPS5, with the original executable and modules in `source/` and the assets in `app0/`, is recognized as well.

PS5 PKG archives can be imported for package inspection. Play and decompilation need unpacked, decrypted input, and MacLauncher does not decrypt encrypted PS5 content. Inputs that support only inspection use the **Inspect only** runtime, which does not launch anything.

## Inspector tools

**Inspect package** reads a PKG archive's FIH, CNT and PFS headers, with fixed read limits, without downloading a runtime or extracting the package. The report covers signing, filesystem encryption when a readable superblock establishes it, and whatever container metadata is available. A title ID inferred from the file name is labeled with that source. A package without CNT metadata is reported as such and is not treated as corrupt for that reason alone. Encrypted packages show the reason in the report and cannot be converted or decompiled.

**Inspect program** exports the program metadata and the import registry once an AnyPS5 conversion exists.

**Decompile** uses the shared [Rizin/Ghidra tools](../tools/NATIVE_INSPECTION.md) to export ELF metadata, imports, symbols, strings, functions and C pseudocode. SELF extraction uses the selected AnyPS5 package. The pseudocode does not reconstruct an original source project.

**Show export** reveals the latest inspection output.

## Runtimes

| Runtime | Delivery | Requirements |
| --- | --- | --- |
| **PS5 (AnyPS5)**, default | Packages from MacLauncher Builds | macOS 26 or later on Intel or Apple Silicon; Vulkan with Intel support |
| **Prosper** | Packages from MacLauncher Builds or a local build registered in Runtimes | macOS 26 or later on Intel or Apple Silicon; Vulkan 1.4 with Intel support |

### AnyPS5

[AnyPS5](https://github.com/boykopovar/AnyPS5) appears in MacLauncher as **PS5 (AnyPS5)** and converts the x86-64 PS5 executable and its bundled modules into Mach-O files. The converter follows the selected package's CPU, while converted games and PS5 system libraries use x86-64. On Intel Macs, both the Intel converter and the game run natively without Rosetta. Apple Silicon runs converted games under [Rosetta](../runtimes/ROSETTA.md); if Rosetta is missing, the system consent flow installs it. Both Mac architectures require macOS 26 or later and a Vulkan build with Intel support.

#### Versions

AnyPS5 versions are supplied by MacLauncher Builds, whose catalog **Refresh** reads, and they need no Python installation.

#### Preparation and saves

AnyPS5 supplies a PS5 runtime rather than a native macOS game engine. Preparation builds the per-game runtime container that it needs: game resources are copied into its `app0/` folder, and PS5 executables and nested modules are converted into Mach-O files. Original programs stay unchanged. The conversion is cached by game input and the contents of the relinker and SELF extraction helper. Runtime versions with identical converter inputs reuse the conversion, and changes to private resources are preserved during conversion updates. Shared runtime libraries follow the selected install through a directory link.

The container is the runtime's working directory. Its `/data` path uses the game's private save directory and `_sd` uses a subfolder there. An explicit save-location setting redirects both paths into the chosen save folder. Save-data memory stays in the per-game container's `launch/_sd_mem/`, keyed by user and slot, separate from the original game files.

PlayGo metadata describes which game chunks are installed. AnyPS5 treats an unlisted chunk as installed, including dumps without that metadata. An explicit `APS5_PLAYGO_UNLISTED_CHUNKS` environment value takes precedence.

#### Vulkan

AnyPS5's **Vulkan** setting selects an installed Vulkan implementation with Intel support, because ARM-only Vulkan libraries cannot load into its x86-64 game process. Automatic prefers a compatible KosmicKrisp and offers to download it when needed. **Settings → PlayStation 5 → PS5 (AnyPS5)** sets the default for all games, and each game's runtime settings can override it. The list shows installed implementations.

#### Controller bindings

Runtime settings include editable keyboard, mouse and wheel bindings for the PS5 controller. Each game inherits the module defaults and can override them or reset to them. Physical controllers keep working alongside the bindings, and changes to bindings and mouse routing apply on the next launch.

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

Binding fields accept comma-separated key names such as `Return, Space`, mouse names such as `Mouse Left`, and wheel directions such as `Wheel Up`. `Comma` names the comma key. A blank field restores its default, and the optional stick modifier has no default binding. The bindings are written to AnyPS5's existing input configuration.

#### Mouse input

**Mouse input** chooses how the mouse reaches the game. The two routes are exclusive, so a click never triggers both:

- **Controller bindings** maps mouse buttons and wheel events to controller inputs, and captured mouse motion moves the right stick.
- **Native mouse** sends movement, buttons and wheel events to the game's own mouse API.
- **Automatic** keeps the selected runtime's default. Runtimes that support routing use controller bindings on macOS, even when a game opens the native mouse API.

Choosing a route explicitly requires a runtime with that capability.

The pointer starts visible and uncaptured. F7 or a middle click toggles capture for the selected route. Buttons assigned to capture are reserved for it, so a native-mouse game receives the middle button only after it is removed from the capture binding. Releasing capture restores the pointer, and an explicit release persists across focus changes.

### Prosper

[Prosper](https://github.com/mattias800/prosper) is an optional runtime for PS5 games: a 64-bit Intel macOS executable that runs natively on Intel Macs and under Rosetta on Apple Silicon. It requires macOS 26 or later and a compatible Vulkan 1.4 build with Intel support. Selecting Prosper keeps the game's PlayStation 5 type and its inspection and decompilation actions. AnyPS5 remains the default.

Prosper packages come from MacLauncher Builds. Its shared Runtime build compiles the exact source and dependency versions declared under `producers/prosper/`, following the upstream build instructions. The package includes the upstream README, an author and source notice, and dependency notices. The runtime executes the game's x86-64 instructions directly, so Apple Silicon uses Rosetta rather than an ARM64 Prosper executable.

When Prosper is missing, Play asks for download consent, installs a compatible package and continues preparation. Saved runtime choices are preserved, and installed packages remain usable offline. The Runtimes view also accepts a local Prosper executable, app bundle or complete runtime directory. Packaged builds record their exact source revision in the runtime manifest. Launching an already built runtime needs no compiler or SDK. MacLauncher Builds' [verification guide](https://github.com/procrastinine/maclauncher-builds/blob/main/VERIFYING.md) describes the GitHub build records and rebuild comparison.

Prosper opens an ordinary dump and its selected executable directly from the original game folder, which is also its working directory. A prepared AnyPS5 input with separate program and asset folders requires a merged Prosper input; a SELF file with a different name requires the runtime's `eboot.bin` alias. AnyPS5 preparation stays unchanged. Saves use Prosper's upstream per-user locations under `$XDG_DATA_HOME/prosper`, or `$HOME/.local/share/prosper`: `savedata0` and `savedata-mem`, each with a namespace from the game's declared `PPSA` title ID. Missing or invalid title IDs use upstream's `_unknown-title` namespace. Save-location overrides select separate roots for both save APIs. When games in the library share a save location, import can assign an ordinary save-location override; explicit choices stay unchanged.

Prosper has three settings, with defaults in Settings and overrides in each game's runtime settings:

- **Vulkan** lists installed implementations. Automatic prefers KosmicKrisp.
- **Frame rate** turns on the runtime's frame-rate display.
- **Configuration file** selects an explicit Prosper configuration file through upstream's `PROSPER_APP_CONFIG` input. With no override, Prosper uses its ordinary shared player preferences under `$XDG_CONFIG_HOME/prosper` or `$HOME/.config/prosper`. A private configuration from MacLauncher 0.5.1 can be recovered once into a separate file, whose path is kept as an ordinary per-game setting.
