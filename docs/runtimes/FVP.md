# FAVORITE / FVP

[RFVP](https://github.com/xmoezzz/rfvp) is an independent interpreter for
FAVORITE's FVP visual novel engine. MacLauncher manages RFVP versions separately
from the original game files.

Import accepts a complete game folder, its Windows executable or an HCB/BCH
scenario file. A BIN resource file can identify its adjacent
game scenario; a BIN file alone is not a complete game. The Windows executable
is not run by RFVP.

## Versions and installation

**Play** installs a missing runtime after download consent and starts the
selected game. MacLauncher downloads the publisher's universal Mac application
and launches its engine through an included native host. A separate RFVP game
library, compiler, Homebrew installation or manual engine setup is unnecessary.

The **RFVP** Runtimes panel refreshes the [publisher's release catalog](https://github.com/xmoezzz/rfvp/releases)
on request. Mac application downloads use the publisher's rolling prerelease
channel; older numbered source tags have no Mac application assets. Each snapshot records its
source commit and artifact checksum, so an updated prerelease has a distinct
identity and installed older snapshots remain separate choices. Refresh retains
explicit global and per-game selections. Opening the launcher or selecting a
game does not fetch release information.

An already identified compatible download can still be installed when the release
catalog is unavailable. MacLauncher verifies the artifact checksum before using it.

Apple Silicon uses the publisher's ARM64 engine and the included game host.
The current native engine and host require macOS 11 or later; MacLauncher's
macOS 13 minimum also applies. Downloaded application versions are shared across
games. Game data and runtime version identities remain separate.

## Formats and compatibility

FVP input contains its compiled HCB scenario, BIN resource archives, images,
sound and other game resources. RFVP interprets the scenario bytecode and engine
syscall dialect.

FVP editions have distinct syscall signatures. The [upstream format reference](https://github.com/xmoezzz/rfvp/blob/main/setsumei/COMPATIBILITY.md)
describes the interpreter’s profiles.

Japanese scenarios normally use Shift-JIS. Translated scenarios may use UTF-8
or GBK, but choosing an encoding does not make a modified data format compatible.
Translations that move strings outside HCB files, encrypt resources differently
or change the original data structures can require additional engine support.

## Settings and storage

**Text encoding** offers Japanese (Shift-JIS), Chinese (GBK) and Unicode (UTF-8).
Shift-JIS is the default. **High-resolution text** renders text at the display
scale and is enabled by default. Both settings have global defaults and per-game
overrides. Window and fullscreen behavior use the game's own controls.

Preparation creates a private game view at `games/<gameId>/modules/fvp/play/`
under launcher data. Assets are linked to the original files rather than copied;
the selected scenario has the filename expected by the engine. The view is reused
while its source layout remains unchanged. The original game folder must contain
regular files and folders with unambiguous names.

RFVP saves use `games/<gameId>/modules/fvp/saves/`, or an explicit save-folder
override outside the original game folder. Runtime logs and preparation files
stay in the same module directory. Original game files remain unchanged.

RFVP saves use their own [save format](https://github.com/xmoezzz/rfvp/blob/main/setsumei/compatibility/SAVEDATA.md), stored separately from original Windows-engine saves.

## Inspection and asset exports

**Inspect game data** reports the scenario title, filename, resolution, script
functions and recognized resource archives. **List assets** writes a JSON
inventory. **Extract assets** exports BIN archive resources and supported loose
resource folders without converting their formats. Loose resources replace
matching archive entries, as they do during play.

Exports stay under `games/<gameId>/modules/fvp/exports/`. **Show assets** opens
the extracted folder in Finder. **Remove extracted assets** removes that export
without changing originals or saves. Asset tools are included and need no runtime
download.

Export limits are 64 archives, 100,000 files, 1 GiB per file and 8 GiB total;
archive indexes are limited to 8 MiB.

## Licenses

RFVP uses the [MPL-2.0 license](https://github.com/xmoezzz/rfvp/blob/main/LICENSE).
Runtime dependencies retain their own licenses and notices. Original game data
is supplied separately and remains the property of its rights holders. See
[attributions](../ATTRIBUTIONS.md) and [runtime distribution](RUNTIME_DISTRIBUTION.md).
