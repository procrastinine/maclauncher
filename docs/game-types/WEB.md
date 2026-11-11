# Web

Web is the game type for HTML games that no more specific game type recognizes, and MacLauncher runs these games in its [web runtimes](../runtimes/WEB_RUNTIMES.md).

## Detection

Because Web is a fallback, detection considers it only after every specific engine layout and packaged-game check has failed, although still before generic macOS and Windows game recognition. A generic canvas page that is not a recognized GameMaker HTML5 export, for example, stays a Web game.

Import accepts:

- a folder whose entry page is a local HTML file
- an HTML file selected directly
- an NW.js app bundle with the game in `Contents/Resources/app.nw`
- an Electron-style layout with the game in `Contents/Resources/app` (using `dist/index.html`), `resources/app` or `Resources/app`
- a Windows NW.js or Electron executable that carries the game

A Windows executable counts as a web game only when its PE metadata identifies NW.js or Electron and it has a contained, unpacked app package with a real entry page and HTML export. An HTML file next to an arbitrary executable therefore does not make that executable a web game. In addition, a `main` entry in `package.json` must be a local HTML file inside the game folder.

For library titles and icons, MacLauncher reads the local NW.js `window.title`, `productName` and `window.icon` values and the document's title and icon links. PNG and WebP artwork is read locally, while ICO artwork is converted to a cached PNG. Remote URLs, resources outside the game folder and dynamic scripts are ignored.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Electron (default) | Included with MacLauncher |
| NW.js | Downloaded from **Runtimes → NW.js** |
| NW.js (Patched) | The same NW.js installation with compatibility patches |
| Game's macOS app | A compatible Mac app supplied with the game |
| CrossOver, Sikarugir, WineCX | Windows runtimes for the game's Windows executable |

[Web runtimes](../runtimes/WEB_RUNTIMES.md) describes the hosts and their settings.

Both Electron and NW.js load the game's HTML, scripts and assets from the original game folder. NW.js also uses a small launcher package for host settings and compatibility helpers, but the game's files are not copied. Browser profiles remain separate from file-based game data.

## Tools

Web has no separate source-export action. Instead, the supplied HTML, JavaScript, CSS and data files can be read directly, so how much source is visible depends on those files; minified, obfuscated or WebAssembly code does not restore an original authoring project. For live debugging, the available tools, such as [DevTools](../runtimes/WEB_RUNTIMES.md#devtools), depend on the selected runtime.
