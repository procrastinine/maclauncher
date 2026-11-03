# FAVORITE / FVP

FVP is FAVORITE's visual novel engine for Windows. A game consists of a compiled HCB scenario, BIN resource archives, images, sound and other resources. MacLauncher plays FVP games with [RFVP](https://github.com/xmoezzz/rfvp), an independent interpreter for the engine.

| Runtime | Description |
| --- | --- |
| RFVP (default) | Independent FVP interpreter, running natively |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

## Importing games

Import accepts a complete game folder, its Windows executable or an HCB or BCH scenario file. A BIN resource file can identify the game scenario next to it, but a BIN file alone is not a complete game. RFVP does not run the Windows executable.

## Game formats

RFVP interprets the scenario bytecode and the engine's system-call dialect. FVP editions have different system-call signatures, and the [upstream format reference](https://github.com/xmoezzz/rfvp/blob/main/setsumei/COMPATIBILITY.md) describes how the interpreter handles each edition. RFVP reads HCB scenarios and the archive layouts described in that reference; translations keep the same data formats. Scenario text can be Japanese Shift-JIS, Chinese GBK or Unicode UTF-8.

## Preparation and storage

Play uses the original game directory when its script and archive names match RFVP and its saves use the game’s `save/` directory. A selected scenario with a different name, uppercase archive names or a separate save folder uses an adapter folder, `games/<gameId>/modules/fvp/play/`, which links the original assets under the names RFVP expects and links its `save/` entry to the selected save directory. Original files remain unchanged. Runtime logs remain in the module directory.

## Saves

Games added to the library use the game's `save/` directory. Games that already have a save location, or an explicit save-folder override, keep it, and the adapter folder links to it. RFVP uses its own [save format](https://github.com/xmoezzz/rfvp/blob/main/setsumei/compatibility/SAVEDATA.md), which differs from the saves of the original Windows engine. RFVP's launch interface takes a game directory and a text encoding but has no save-directory option.

## Settings

RFVP has two settings, each with a global default and a per-game override. Window and fullscreen behavior use the game's own controls.

| Setting | Default | Description |
| --- | --- | --- |
| Text encoding | Japanese (Shift-JIS) | Japanese (Shift-JIS), Chinese (GBK) or Unicode (UTF-8). Japanese game data uses Shift-JIS; a translation patch can require another encoding. |
| High-resolution text | On | Renders text at the display scale. |

## Inspection and asset exports

FVP's asset tools are included with MacLauncher:

- **Inspect game data**, in the **Advanced** group, reports the scenario title, file name, resolution, script functions and recognized resource archives.
- **List assets** writes a JSON inventory.
- **Extract assets** exports the resources in BIN archives and supported loose resource folders without converting their formats. Loose resources replace matching archive entries, as they do during play.
- **Show assets** opens the extracted folder in Finder.
- **Remove extracted assets** deletes the export and keeps the saves.

Asset exports are written to `games/<gameId>/modules/fvp/exports/`. Limits are 64 archives, 100,000 files, 1 GiB per file and 8 GiB in total, and archive indexes are limited to 8 MiB.

**Export text**, in the **Source** group, uses [msg-tool](https://github.com/lifegpc/msg-tool), a native tool listed under **Runtimes → Tools → msg-tool**, to export HCB dialogue as readable JSON in the selected source encoding. The output and the hashes of the original input are written to `games/<gameId>/modules/fvp/text-exports/`. The dialogue export does not reconstruct the full HCB program.

## Runtimes

### RFVP

RFVP is the default runtime. MacLauncher downloads the publisher's universal Mac application and starts its engine through a native host included with MacLauncher; on Apple Silicon, the host runs the publisher's ARM64 engine. The engine and host require macOS 11 or later, and MacLauncher itself requires macOS 13.

The **RFVP** tab in Runtimes reads the [publisher's release catalog](https://github.com/xmoezzz/rfvp/releases).

- Mac applications come from the publisher's rolling prerelease, a single GitHub prerelease that the publisher keeps updating. The older numbered source tags have no Mac application assets.
- MacLauncher records each state of the prerelease as a snapshot with its source commit and download checksum. An updated prerelease therefore becomes a new version, and older installed snapshots remain separate choices.
- Without a per-game or global choice, Play uses the newest listed snapshot. Before any list has been loaded, or when that snapshot is not installed, Play reads the publisher's catalog with consent and installs the current snapshot.
- The Mac download is the publisher's disk image or, after a rename or format change, another Mac archive in the prerelease. Installation finds the application and the engine library for this Mac's processor wherever the release places them.
- A compatible download that was already identified can still be installed when the release catalog is unavailable. MacLauncher verifies its checksum before using it.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected version and the inspector tools stay available with either runtime.

## Licenses

RFVP uses the [MPL-2.0 license](https://github.com/xmoezzz/rfvp/blob/main/LICENSE). Runtime dependencies keep their own licenses and notices. Original game data is supplied separately and remains the property of its rights holders. See [attributions](../ATTRIBUTIONS.md) and [runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md).
