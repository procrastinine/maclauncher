# WOLF RPG Editor

WOLF RPG Editor is a Windows engine for role-playing games. MacLauncher plays WOLF RPG Editor games with [Browser Woditor](https://frostyhowl.com/browser-woditor/), a browser port of the engine, and offers asset extraction and project data export.

## Detection and preparation

Import accepts the game folder, `Game.exe`, `Data.wolf` or a recognized game archive. Supported layouts are whole-game `Data.wolf` archives, `Data/BasicData.wolf` layouts and unpacked `Data/BasicData/Game.dat` projects.

DX archives in versions 1–6 and 8 that use the standard WOLF encryption keys are converted into a browser-compatible container in the game's launcher data. Games with other encryption or container layouts need unpacked game data. A preparation is reused while the source files, the selected runtime and the settings stay the same.

Browser Woditor needs a small runtime marker and a list of the game's files, and MacLauncher adds both to the prepared copy. A local HTTP server serves the game files and WebAssembly, and **Offline protections** restricts requests to local content. The original Windows program is never run.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Browser Woditor (default) | Downloaded from its publisher, **Runtimes → WOLF RPG** |
| CrossOver, Sikarugir | Windows runtimes for the original `Game.exe` |

The selected Browser Woditor version determines which WOLF RPG formats and APIs work. Games that use Windows-specific system functions, native DLLs, WOLF RPG Pro APIs or MP4 video can run in [Sikarugir](../runtimes/SIKARUGIR.md) or [CrossOver](../runtimes/CROSSOVER.md) instead.

### Browser Woditor versions

**Runtimes → WOLF RPG** lists the versions Browser Woditor publishes, and Refresh loads the complete download list from the publisher; Browser Woditor is not included in MacLauncher.

Refresh reads every ZIP link on the publisher's page that names Browser Woditor and a version of two to four numbers, such as `BrowserWoditor_0_6_2_0.zip`, hosted on frostyhowl.com or one of its subdomains. A link that cannot be read is skipped, and a page with no readable link keeps the cached list. The publisher lists no checksum, so the archive's SHA-256 is recorded at installation. Installation reads the runtime from the archive's top level or from the folder that holds `public/index.html`.

### Settings and controls

| Setting | Values |
| --- | --- |
| **Hide touch controls** | On (default) or off |
| **Frame rate** | 60 FPS (default) or 30 FPS |
| **Offline protections** | On (default); restricts the game to local content |

**Launch arguments** are passed literally to the engine's WebAssembly startup arguments and take effect on the next launch.

The arrow keys move, Enter confirms, Escape cancels and Shift performs the alternate action. Native window controls and the standard macOS fullscreen shortcut remain available.

## Saves

Saves use a browser storage partition for each game and are also written to the game's save folder in launcher storage, so they stay available when the local server's address changes. Existing files from the game's `Save` folder are copied on the first preparation. Save-folder overrides and save snapshots are available.

## Tools

The inspector's **Asset tools** group has these actions:

| Action | Tool | Output |
| --- | --- | --- |
| **List assets**, **Extract assets** | Included archive reader | A list of supported archives and loose assets, or an extracted copy, with no extra download |
| **Extract WOLF Pro assets** | [UberWolf](https://github.com/Sinflower/UberWolf) | Assets from archives with other encryption and from WOLF RPG Pro formats |
| **Export project JSON** | [WolfTL](https://github.com/Sinflower/WolfTL) | Map, event and database data as JSON |

**Reveal assets** opens the asset export folder, **Remove asset export** deletes that copy, and **Reveal project JSON** opens the JSON output. Exports are stored apart from the game data.

UberWolf needs the game's original `Game.exe` or `GamePro.exe` next to its archives and works on private copies. It handles the format and key of each archive; unknown formats or keys can fail. The included reader does not guess unknown keys. Archives with unsupported encryption can be extracted with UberWolf before JSON conversion.

WolfTL exports the translation-relevant databases, common events and maps from `.dat`, `.mps` and `.project` data. The result is structured game data, not an original editor project.

UberWolf and WolfTL are Windows programs and run in a private Windows environment through an installed Sikarugir or CrossOver engine; Sikarugir is downloaded when neither is installed. Using these tools does not change the game's runtime.

## License

Browser Woditor is proprietary. Its download includes the publisher's license and dependency notices. The license permits running games and limits redistribution to games distributed by their rights holders; Browser Woditor may not be redistributed on its own. The runtime and game data stay on the local computer.
