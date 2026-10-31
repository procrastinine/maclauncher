# Nintendo Switch

This game type covers Switch game containers and extracted Switch programs. Its runtime, [nxnative](https://github.com/seedds/nxnative), runs the game's ARM64 code in a native Apple Silicon host with Metal graphics. Extracted programs that cannot be played remain available for inspection.

## Accepted inputs

MacLauncher identifies NSP, NSZ, XCI and XCZ containers from their headers and directory tables, reading only a limited part of each file. A folder holding an application's containers can also be imported. Detection does not extract game data or read key contents.

Extracted ExeFS/RomFS applications, standalone NSO and NRO modules and HFS0 partitions are recognized for inspection only and use the **Inspect only** runtime, which does not launch anything; playback preparation needs an application container.

## Keys

Encrypted input needs a `prod.keys` file. The **prod.keys** setting in the nxnative runtime settings holds its path:

- **Choose file…** opens the macOS file picker. Dropping a single local file on the control also registers it.
- The control shows **Registered**, **Missing** or **Invalid**, with a short reason and the file name.
- **Replace…** and **Remove** change only the registration.

The module setting supplies the default, and each game can override it or reset to that default. The inspector shows **Choose prod.keys…** for games that need keys.

If preparation needs keys and no configured file is available, it uses a `prod.keys` file next to the imported container or asks for one. Play explains the requirement and resumes once a valid file is chosen. Key files stay at their original paths and are never copied into runtime packages or inspection exports.

## Inspector tools

**Inspect program** exports the format and module metadata reported by the nxnative native tools.

**Decompile** converts the original NSO code to an ARM64 ELF with upstream `nso2elf.py`, then uses the shared [Rizin/Ghidra tools](../tools/NATIVE_INSPECTION.md) to export imports, symbols, strings, functions and C pseudocode. NRO and HFS0 inputs support metadata inspection only. The pseudocode does not reconstruct an original source project.

**Show export** reveals the latest export.

## Runtimes

### nxnative

nxnative appears in MacLauncher as **Switch (nxnative)** and is the only runtime for this game type.

#### Versions and components

nxnative versions download directly from upstream, and **Refresh** lists upstream commits with their commit dates. Each installed version, called a snapshot, records its full commit hash.

A working setup has three components: the nxnative runtime, the native tools and the Metal compiler. The native host, the preparation tools and the launcher adapters are separate packages from MacLauncher Builds, downloaded when needed. Play uses the scripts of the selected nxnative snapshot to prepare the game application.

**Runtimes → Switch (nxnative)** opens with an overview of the components, each marked **Installed** or **Automatic on Play**. Play checks the required components and installs any that are missing. **Advanced · versions and components** holds the version, source, default, custom registration, import and removal controls. A component download shows the component name, percentage, bytes and current step (download, check, extract or installation check). Cancel is available in the component row, the runtime panel, Downloads and the Play progress.

On a first Play with nothing installed, MacLauncher asks before listing upstream commits and installing a snapshot, and asks again before downloading the native tools.

#### Metal compiler

Preparation uses Apple's Metal compiler when the selected native-tools version requires it, and reuses a compatible installed compiler. Native-tools versions that support it can have MacLauncher download Apple's compiler before extraction. **Metal compiler** in Runtimes selects a downloaded version or an existing toolchain.

A downloaded compiler is kept in MacLauncher's private storage, without Xcode and without changing system developer settings. The available components come from Apple's public macOS MobileAsset catalog. When that catalog is absent, the compiler cannot be downloaded, but compatible system and registered toolchains still work. Cached games launch without repeating shader preparation. Earlier native-tools versions keep their original compiler requirements.

#### Python dependencies

Native-tools packages that use a shared Python run MacLauncher's included interpreter with the exact Python dependency versions the tools declare. A private environment keeps those dependencies apart from launcher, system and user packages, including in preparation subprocesses. MacLauncher's app and the runtime package stay unchanged. Older runtime packages that contain their own interpreter remain supported.

#### Preparation and storage

Preparation stores the extracted resources, patched code and shader caches in the game's private launcher data. A cached preparation is identified by the input, the selected source commit and the native-tools version. Saves and temporary files use separate private folders; the save-location setting overrides the save folder.

Play builds a private Mac application named after the game, with the game's extracted Control icon, or the module icon when no game artwork is available, and preserves the native host's entitlements. Stop and window activation act on the actual native game process.

The first preparation shows upstream stages, work counts and, when available, the estimated time remaining. Estimated totals are marked with `~`, and stages without a usable count or fraction show indeterminate progress. The progress detail holds stage summaries and diagnostic messages. After a runtime update, preparation reuses the input's private workspace, and upstream stage fingerprints decide which extraction, code and shader data can be reused.

#### Game options

After preparation, each game's runtime settings include the choices generated from upstream `launcher.json`: the game, control and performance options that nxnative offers for that game. The choices live in the game's `org.nxnative.<title ID>` preferences domain, which upstream Mac applications also use. Only values that differ from nxnative's defaults are stored, and Reset removes them. Saved values are checked against the current generated schema, so retired options fall back to the new defaults.

Temporary launch environment overrides take precedence over saved choices. MacLauncher sets `DM_LAUNCHER=0` so that upstream does not open a second settings window. `DM_SAVED_CHOICES=0` skips the saved choices for one launch without changing them.

#### Keyboard and controller mapping

nxnative reads physical key positions and has no keyboard or controller remapping. **Fixed keyboard mapping** and **Fixed controller mapping**, in Settings → Nintendo Switch and in each game's Switch (nxnative) settings, show its layouts for reference. Key names follow the US keyboard layout.

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

Controllers with a macOS extended gamepad profile are detected automatically through the native GameController input path. Face buttons map by position, whatever their printed labels say.
