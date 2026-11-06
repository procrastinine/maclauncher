# Nintendo Switch

This game type covers Switch game containers, decrypted Switch and Switch 2 dumps, and extracted Switch programs. Its runtime, [nxnative](https://github.com/seedds/nxnative), runs the game's ARM64 code in a native Apple Silicon host with Metal graphics. Extracted programs that cannot be played remain available for inspection.

## Accepted inputs

Import accepts NSP, NSZ, XCI and XCZ containers, as well as a folder holding an application's containers. MacLauncher identifies each container from its header and directory tables, reading only a limited part of the file, and detection neither extracts game data nor reads key contents.

NUP containers and decrypted dumps also support Play without prod.keys. A dump contains base/exefs/main.npdm and base/romfs, exefs and romfs directly at its root, or complete updates/<decimal version>/exefs and romfs. Optional DLC lives under dlc/<title ID>/<number>/romfs. Updates contain full patched filesystems. A NUP holds the same decrypted content in one container. A folder containing one NUP is accepted; folders mixing NUP, dumps and encrypted packages require an explicit input selection.

Other Switch formats are recognized for inspection only: extracted ExeFS/RomFS applications, standalone NSO and NRO modules, and HFS0 partitions. These use the **Inspect only** runtime, which does not launch anything. Standalone code and incomplete extracted applications remain inspection inputs.

## Keys

NUP and decrypted dump preparation bypasses key files. No firmware installation is required for that route. Runtime packages contain neither keys, firmware nor game data.

Encrypted input needs a `prod.keys` file, whose path is held by the **prod.keys** setting in the nxnative runtime settings:

- **Choose file…** opens the macOS file picker. Dropping a single local file on the control also registers it.
- The control shows **Registered**, **Missing** or **Invalid**, with a short reason and the file name.
- **Replace…** and **Remove** change only the registration.

This setting works at two levels: the module setting supplies the default, and each game can override it or reset to that default. For games that need keys, the inspector also shows **Choose prod.keys…**.

When preparation needs keys and no configured file is available, it falls back to a `prod.keys` file next to the imported container or else asks for one. In that case, Play explains the requirement and resumes once a valid file is chosen. Key files themselves stay at their original paths and are never copied into runtime packages or inspection exports.

## Inspector tools

The inspector can export program metadata and decompiled code. **Inspect program** exports the format and module metadata that the nxnative native tools report.

**Decompile** works on NSO code. It first converts the original NSO code to an ARM64 ELF with upstream `nso2elf.py`, and the shared [Rizin/Ghidra tools](../tools/NATIVE_INSPECTION.md) then export imports, symbols, strings, functions and C pseudocode from it. That pseudocode does not reconstruct an original source project. NRO and HFS0 inputs, on the other hand, support metadata inspection only.

**Show export** then reveals the latest export.

## Runtimes

### nxnative

nxnative appears in MacLauncher as **Switch (nxnative)** and is the only runtime for this game type.

#### Versions and components

nxnative versions correspond to upstream commits and download directly from upstream. **Refresh** lists those commits with their commit dates, and each installed version, called a snapshot, records its full commit hash.

A working setup has three components: the nxnative runtime, the native tools and the Metal compiler. Play prepares the game application with the scripts of the selected nxnative snapshot. The native host, the preparation tools and the launcher adapters, however, are separate packages from MacLauncher Builds and are downloaded when needed.

**Runtimes → Switch (nxnative)** opens with an overview of the components, each marked **Installed** or **Automatic on Play**. Play checks the required components and installs any that are missing. The version, source, default, custom registration, import and removal controls are under **Advanced · versions and components**. While a component downloads, its progress shows the component name, percentage, bytes and current step (download, check, extract or installation check), and the download can be cancelled from the component row, the runtime panel, Downloads or the Play progress.

On a first Play with nothing installed, MacLauncher asks before listing upstream commits and installing a snapshot, and asks again before downloading the native tools.

The native host normally comes from its MacLauncher Builds package. **Build the upstream host when needed**, which is disabled by default and needs Xcode, offers an alternative: during preparation, native tools that support this option build the selected snapshot's unmodified host when the packaged host is missing or comes from another revision. These builds are cached by snapshot revision and game title ID. Missing build tools or a failed build result in a warning, and the packaged host is kept. Native-tools packages without upstream-host build support ignore the option.

#### Metal compiler

When the selected native-tools version requires Apple's Metal compiler, preparation uses it, reusing a compatible installed compiler when there is one. Native-tools versions that support it can also have MacLauncher download Apple's compiler before extraction. Whether a downloaded version or an existing toolchain is used is selected with **Metal compiler** in Runtimes.

Downloadable components come from Apple's public macOS MobileAsset catalog. A downloaded compiler is kept in MacLauncher's private storage and needs neither Xcode nor any change to system developer settings. When that catalog is absent, no compiler can be downloaded, although compatible system and registered toolchains still work. Once a game is cached, it launches without repeating shader preparation. Earlier native-tools versions keep their original compiler requirements.

#### Python dependencies

Some native-tools packages use a shared Python. They run MacLauncher's included interpreter with the exact Python dependency versions that the tools declare, and a private environment keeps those dependencies apart from launcher, system and user packages, including in preparation subprocesses. Neither MacLauncher's app nor the runtime package is changed. Older runtime packages that contain their own interpreter remain supported.

#### Preparation and storage

Preparing a game produces extracted resources, patched code and shader caches, all stored in the game's private launcher data. Each cached preparation is identified by the input, the selected source commit and the native-tools version. Saves and temporary files have separate private folders, and the save-location setting overrides the save folder.

To launch, Play builds a private Mac application named after the game. This application carries the game's extracted Control icon, or the module icon when no game artwork is available, and keeps the native host's entitlements. Stop and window activation then act on the actual native game process.

During the first preparation, progress follows the upstream stages, with work counts and, when available, the estimated time remaining. Estimated totals are marked with `~`, while stages without a usable count or fraction show indeterminate progress. Stage summaries and diagnostic messages are in the progress detail. After a runtime update, preparation reuses the input's private workspace, and upstream stage fingerprints decide which extraction, code and shader data can be reused.

#### Game options

Decrypted inputs offer **Game update** before preparation. **Latest available** selects the newest local package; another available version can be selected per game. The inspector records the selected version. Changing it prepares that version while preserving saves.

For each game, nxnative offers its own game, control and performance options. After preparation, these appear in the game's runtime settings as choices generated from upstream `launcher.json`. They are stored in the game's `org.nxnative.<title ID>` preferences domain, which upstream Mac applications also use, and only values that differ from nxnative's defaults are kept there. Reset removes them. Because saved values are checked against the current generated schema, retired options fall back to the new defaults.

Temporary launch environment overrides take precedence over saved choices, and `DM_SAVED_CHOICES=0` skips the saved choices for one launch without changing them. MacLauncher itself sets `DM_LAUNCHER=0`, so that upstream does not open a second settings window.

#### Keyboard and controller mapping

nxnative reads physical key positions and has no keyboard or controller remapping. Its fixed layouts can still be viewed for reference: **Fixed keyboard mapping** and **Fixed controller mapping** appear in Settings → Nintendo Switch and in each game's Switch (nxnative) settings. The layouts are as follows, with key names from the US keyboard layout:

| Switch input | Keyboard | Controller |
| --- | --- | --- |
| A / B / X / Y | J / K / U / I | Right / bottom / top / left face button, by position |
| Left stick | W A S D | Left stick |
| Right stick | No keyboard binding | Right stick |
| D-pad | Arrow keys | D-pad |
| L / R | Q / E | Left / right shoulder |
| ZL / ZR | Z / C | Left / right trigger |
| L3 / R3 | F / G | Left / right stick click |
| + / − | Return / Tab | Menu / Options |
| L + R prompt | Hold Q + E | |
| Shake | Space | |
| Touch | Left click or drag | |
| Fullscreen | Control-Command-F | |

A controller with a macOS extended gamepad profile is detected automatically through the native GameController input path. Its face buttons map by position, whatever their printed labels say.
