# Construct

Construct 2 and Construct 3 export games as HTML5 projects. MacLauncher runs them in its [web runtimes](../runtimes/WEB_RUNTIMES.md) and records which Construct version made the export.

## Detection

Import accepts the game folder, its HTML entry page, a `package.nw` folder or file, a Windows executable or a Mac app bundle. The Construct version comes from the runtime file next to the entry page: `c2runtime.js` identifies Construct 2, while `c3runtime.js`, `scripts/c3runtime.js` or `scripts/c3main.js` identify Construct 3. When none of those files is present, the page's `generator` meta tag or Construct markers in the page identify the version.

Construct Windows exports can keep the game in a separate `package.nw` next to a renamed NW.js executable. When such an executable is imported directly, MacLauncher reads its PE version metadata to confirm that it is the renamed NW.js executable and checks the Construct package separately before preparing the game for Play. As a result, an unrelated executable never picks up neighboring game files.

Library titles and icons come from the local NW.js `window.title`, `productName` and `window.icon` values and from the document's title and icon links. PNG and WebP artwork is read locally, and ICO artwork is converted to a cached PNG. Remote URLs, resources outside the game folder and dynamic scripts are ignored.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Electron (default) | Included with MacLauncher; other versions from **Runtimes → Electron** run the [game's own Electron app](../runtimes/WEB_RUNTIMES.md#the-games-electron-app) |
| NW.js | Downloaded from **Runtimes → NW.js** |
| NW.js (Patched) | The same NW.js installation with compatibility patches |
| Game's macOS app | A compatible Mac app supplied with the game |
| CrossOver, Sikarugir, WineCX | Windows runtimes for the game's Windows executable |

The hosts and their settings are described in [Web runtimes](../runtimes/WEB_RUNTIMES.md). In Electron, Construct games use the shared legacy NW.js window interface, and browser scripts keep their global libraries instead of loading through CommonJS.

Construct bundles built for WebView2 run in a frame with Node disabled, inside the same native NW.js window. Around that frame, a MacLauncher page keeps the native controls and reports startup. The game counts as ready only once its original document loads, and its startup errors stay visible. The original assets stay linked, and browser workers keep their browser APIs without Node integration.

## Preparation

A `package.nw` folder is already readable, so it runs from its original location and status checks do not copy it. A packaged export, such as a ZIP payload inside an executable or a `package.nw` file, has to be extracted before it can launch. In that case Play asks before extracting it into the game's launcher data, and later launches reuse the extracted copy.

## Tools

The inspector's **Bundle** group has **Extract bundle**, **Reveal extracted files** and **Remove extracted files**. Extraction uses the included package extractors and stores the readable HTML, JavaScript and resources in the game's launcher data. Until an extraction has completed, **Reveal extracted files** shows **Extract bundle first**. The exported runtime code does not contain the Construct authoring project or its event sheets.
