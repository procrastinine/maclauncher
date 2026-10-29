# WOLF RPG Editor

WOLF RPG Editor games run with [Browser Woditor](https://frostyhowl.com/browser-woditor/), a browser port of the engine. Import accepts a game folder, `Game.exe`, `Data.wolf` or a recognized game archive. The launcher downloads a runtime after consent and prepares game data automatically.

**Runtimes → WOLF RPG** lists the versions currently published by Browser Woditor. Refresh fetches the complete download list. Versions install separately. Play uses the game's exact version override, then the runtime default. A saved default takes precedence over the manager default: the newest compatible stable listed version, or the newest ready installed version when none is listed. Clearing a saved default restores the manager default. A missing selected version downloads after consent. Installed versions work offline. The runtime downloads from its publisher and is not included in MacLauncher.

The launcher supports whole-game `Data.wolf` archives, `Data/BasicData.wolf` layouts and unpacked `Data/BasicData/Game.dat` projects. DX archive versions 1–6 and 8 with standard WOLF encryption keys are converted to a browser-compatible container in the launcher's game data folder. Other encryption and container layouts use unpacked game data. Game contents and the original Windows executable are preserved. Preparation is reused while the source files, selected runtime and settings remain unchanged.

Browser Woditor requires a small runtime marker and a file download list. The launcher provides both in the prepared copy. Its local HTTP server serves game files and WebAssembly; offline protections restrict requests to local content. The original Windows program is not executed.

Launch arguments are passed literally to the browser engine's WebAssembly startup arguments. Changes take effect on the next launch.

Arrow keys move, Enter confirms, Escape cancels and Shift performs the alternate action. Settings include touch-control visibility, a 30 or 60 FPS limit and offline protections. Native window controls and the standard macOS fullscreen shortcut remain available.

Saves use a per-game browser partition and are also written to the game's save directory in launcher storage. This keeps saves available when the local server address changes. Existing files from the game's `Save` folder are copied on first preparation. Save-folder overrides and save snapshots are available.

The inspector's **Asset tools** list or extract supported archives and loose assets without another download. **Extract WOLF Pro assets** uses managed [UberWolf](https://github.com/Sinflower/UberWolf) for additional archive encryption and WOLF RPG Pro formats. It requires the game's original `Game.exe` or `GamePro.exe` alongside its archives and processes private copies. Exports are stored separately from game data; **Show assets** opens the export folder and **Remove asset export** deletes that copy.

**Export project JSON** uses managed [WolfTL](https://github.com/Sinflower/WolfTL) to recover map, event and database data as JSON. **Reveal project JSON** opens the result. This export provides structured game data rather than an original editor project. Unsupported archive encryption can use UberWolf extraction before JSON conversion. Both tools download after consent and run in a private Windows environment through an installed Sikarugir or CrossOver engine. If neither engine is available, Sikarugir can download after consent. Tool use does not change the selected playback runtime.

The selected Browser Woditor version supplies WOLF RPG format and API support. Games using Windows-specific system functions, native DLLs, WOLF RPG Pro APIs or MP4 video can use [Sikarugir](SIKARUGIR.md) or [CrossOver](CROSSOVER.md).

Browser Woditor is proprietary. Its download includes the publisher's license and dependency notices. The license permits runtime use and limits redistribution to games distributed by their rights holders; standalone redistribution of Browser Woditor is not permitted. Runtime and game data remain on the local computer.
