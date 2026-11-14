# GameMaker HTML5

GameMaker can export games for web browsers with its [HTML5 runtime](https://github.com/YoYoGames/GameMaker-HTML5), and MacLauncher runs these exports in its [web runtimes](../runtimes/WEB_RUNTIMES.md). Desktop GameMaker games belong to a separate game type, [GameMaker](GAMEMAKER.md), and their bytecode is not converted to HTML5.

## Detection

Import accepts a complete local browser export: its folder, its HTML entry page or a Mac app bundle. Within size limits, detection reads engine declarations and the canvas and GML metadata that GameMaker generates, without running JavaScript or following remote scripts. Obfuscated exports can be recognized even without the `JSON_game` or `g_pGMFile` names, while a generic canvas page stays a [Web](WEB.md) game.

The detected version is the asset compiler version declared in the export's scripts; when no compiler version can be read, it stays unknown. The inspector's **Details** show the asset compiler version, the version evidence, the game's own app version and the detection reference.

Library titles and icons come from the local NW.js `window.title`, `productName` and `window.icon` values and from the document's title and icon links. PNG and WebP artwork is read locally, and ICO artwork is converted to a cached PNG. Remote URLs, resources outside the game folder and dynamic scripts are ignored.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Electron (default) | Included with MacLauncher |
| NW.js | Downloaded from **Runtimes → NW.js** |
| Game's macOS app | A compatible Mac app supplied with the game |

GameMaker HTML5 has no NW.js (Patched) runtime. The hosts and their settings are described in [Web runtimes](../runtimes/WEB_RUNTIMES.md).

## Tools

GameMaker HTML5 has no separate source-export action; the shipped HTML, JavaScript and resources can be read directly. This output differs from the Studio VM `data.win` formats that UndertaleModTool handles for [GameMaker](GAMEMAKER.md#decompilation-and-inspection), and compiled or minified JavaScript does not restore the original GML or an editor project.
