# WOLF RPG Editor

WOLF RPG Editor games run with [Browser Woditor](https://frostyhowl.com/browser-woditor/), a browser port of the engine. Add a game folder, `Game.exe`, `Data.wolf` or a supported game archive, then select **Play**. The launcher downloads a runtime after consent and prepares game data automatically.

**Runtimes → WOLF RPG** lists the versions currently published by Browser Woditor. Refresh fetches the complete download list. Versions install separately; the selected default and optional per-game version remain explicit choices. Installed versions work offline. The runtime is downloaded from its publisher and is not included in MacLauncher.

The launcher supports whole-game `Data.wolf` archives, `Data/BasicData.wolf` layouts and unpacked `Data/BasicData/Game.dat` projects. DX archive versions 1–6 and 8 with supported standard WOLF encryption keys are converted to a browser-compatible container in the launcher's game data folder. Unpacked games are packaged there too. Game contents and the original Windows executable are preserved. Preparation is reused while the source files, selected runtime and settings remain unchanged. Customized encryption keys, encrypted header variants and newer containers may require unpacked data.

Browser Woditor requires a small runtime marker and a file download list. The launcher provides both in the prepared copy. Its local HTTP server serves game files and WebAssembly; offline protections restrict requests to local content. The original Windows program is not executed.

Arrow keys move, Enter confirms, Escape cancels and Shift performs the alternate action. Settings include touch-control visibility, a 30 or 60 FPS limit and offline protections. Native window controls and the standard macOS fullscreen shortcut remain available.

Saves use a per-game browser partition and are also written to the game's save directory in launcher storage. This keeps saves available when the local server address changes. Existing files from the game's `Save` folder are copied on first preparation. Save-folder overrides and save snapshots are available; save editing is not supported.

The inspector's **Asset tools** list or extract supported archives and loose assets. Exports are stored separately from game data; **Show assets** opens the export folder and **Remove asset export** deletes that copy. These actions do not require another download. Binary maps, events and databases retain their original formats; they are not decompiled into an editable project.

Compatibility depends on the selected Browser Woditor version. Windows-specific system functions, external DLLs, WOLF RPG Pro features and MP4 video are not generally supported. Older game data may still contain features that differ in newer engines. No general compatibility claim is made for every WOLF RPG game.

Browser Woditor is proprietary. Its download includes the publisher's license and dependency notices. The license permits runtime use and limits redistribution to games distributed by their rights holders; standalone redistribution of Browser Woditor is not permitted. Runtime and game data remain on the local computer.
