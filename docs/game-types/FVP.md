# FAVORITE / FVP

FVP is FAVORITE's visual novel engine for Windows, and its games consist of a compiled HCB scenario, BIN resource archives, images, sound and other resources. MacLauncher plays FVP games with [RFVP](https://github.com/xmoezzz/rfvp), an independent interpreter for the engine.

| Runtime | Description |
| --- | --- |
| RFVP (default) | Independent FVP interpreter, running natively |
| CrossOver, Sikarugir, WineCX | Run the original Windows executable |

## Importing games

Import accepts a complete game folder, its Windows executable or an HCB or BCH scenario file. A BIN resource file can identify the game scenario next to it, although a BIN file alone is not a complete game. The Windows executable can be imported as well, but RFVP does not run it.

## Game formats

RFVP interprets the scenario bytecode together with the engine's system-call dialect. Because FVP editions differ in their system-call signatures, the [upstream format reference](https://github.com/xmoezzz/rfvp/blob/main/setsumei/COMPATIBILITY.md) describes how the interpreter handles each edition. RFVP reads HCB scenarios and the archive layouts described there, and translations keep the same data formats. Scenario text can be Japanese Shift-JIS, Chinese GBK or Unicode UTF-8.

## Preparation and storage

When a game's script and archive names match what RFVP expects and its saves use the game's `save/` directory, Play runs it from the original game directory. A game whose selected scenario has a different name, whose archive names are uppercase or whose saves are in a separate folder runs from an adapter folder, `games/<gameId>/modules/fvp/play/`, instead. That folder links the original assets under the names RFVP expects, and its `save/` entry links to the selected save directory. Either way, the original files remain unchanged. Runtime logs are kept in the module directory that also holds the adapter folder.

## Saves

Games added to the library save to the game's own `save/` directory, unless a game already has a save location or an explicit save-folder override, which it keeps instead. RFVP's launch interface takes a game directory and a text encoding but has no save-directory option, so in that case the adapter folder links to the chosen location. RFVP also uses its own [save format](https://github.com/xmoezzz/rfvp/blob/main/setsumei/compatibility/SAVEDATA.md), which differs from the saves of the original Windows engine.

## Settings

RFVP has two settings, each with a global default and a per-game override, while window and fullscreen behavior follow the game's own controls.

| Setting | Default | Description |
| --- | --- | --- |
| Text encoding | Japanese (Shift-JIS) | Japanese (Shift-JIS), Chinese (GBK) or Unicode (UTF-8). Japanese game data uses Shift-JIS; a translation patch can require another encoding. |
| High-resolution text | On | Renders text at the display scale. |

## Inspection and asset exports

MacLauncher includes asset tools for FVP games:

- **Inspect game data**, in the **Advanced** group, reports the scenario title, file name, resolution, script functions and recognized resource archives.
- **List assets** writes a JSON inventory.
- **Extract assets** exports the resources in BIN archives and supported loose resource folders without converting their formats. Loose resources replace matching archive entries, as they do during play.
- **Show assets** opens the extracted folder in Finder.
- **Remove extracted assets** deletes the export and keeps the saves.

Asset exports are written to `games/<gameId>/modules/fvp/exports/` and are limited to 64 archives, 100,000 files, 1 GiB per file and 8 GiB in total, with archive indexes of at most 8 MiB.

**Export text**, in the **Source** group, exports HCB dialogue as readable JSON in the selected source encoding. For this it uses [msg-tool](https://github.com/lifegpc/msg-tool), a native tool listed under **Runtimes → Tools → msg-tool**, and writes the output together with the hashes of the original input to `games/<gameId>/modules/fvp/text-exports/`. The dialogue export does not reconstruct the full HCB program.

## Runtimes

### RFVP

For RFVP, the default runtime, MacLauncher downloads the publisher's universal Mac application and starts its engine through a native host that is included with MacLauncher. On Apple Silicon, this host runs the publisher's ARM64 engine. The engine and host require macOS 11 or later, while MacLauncher itself requires macOS 13.

Versions come from the [publisher's release catalog](https://github.com/xmoezzz/rfvp/releases), which the **RFVP** tab in Runtimes reads.

- Mac applications come from the publisher's rolling prerelease, a single GitHub prerelease that the publisher keeps updating. The older numbered source tags have no Mac application assets.
- MacLauncher records each state of the prerelease as a snapshot with its source commit and download checksum, so an updated prerelease becomes a new version and older installed snapshots remain separate choices.
- Without a per-game or global choice, Play uses the newest listed snapshot. Before any list has been loaded, or when that snapshot is not installed, Play reads the publisher's catalog with consent and installs the current snapshot.
- The Mac download is the publisher's disk image or, after a rename or format change, another Mac archive in the prerelease. Installation finds the application and the engine library for this Mac's processor wherever the release places them.
- When the release catalog is unavailable, a compatible download that was already identified can still be installed, and MacLauncher verifies its checksum before using it.

### CrossOver, Sikarugir and WineCX

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application, [Sikarugir](../runtimes/SIKARUGIR.md) or [WineCX](../runtimes/WINECX.md). With each of them, the detected version and the inspector tools stay available.

## Licenses

RFVP uses the [MPL-2.0 license](https://github.com/xmoezzz/rfvp/blob/main/LICENSE), and its runtime dependencies keep their own licenses and notices. Original game data is supplied separately and remains the property of its rights holders. See [attributions](../ATTRIBUTIONS.md) and [runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md).
