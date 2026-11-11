# Tyrano

TyranoScript and TyranoBuilder games are HTML games with KAG-style scenario scripts, so MacLauncher runs them in its [web runtimes](../runtimes/WEB_RUNTIMES.md).

## Detection

A Tyrano game is identified by its engine file, `tyrano/plugins/kag/kag.js`. Import accepts the game folder, its HTML entry page, a `package.nw` folder or file, a Windows executable, or a Mac app bundle, including an Electron app with `Contents/Resources/app.asar`. Packaged games are recognized from their contents: a ZIP payload inside an executable or a `package.nw` file must contain the engine file together with `package.json` or `builder_config.json`, and an Electron `app.asar` archive must contain the engine file. This check also applies when a Tyrano executable sits next to a generic `index.html`, so its archive contents identify it as Tyrano before the generic Web game type is considered.

The inspector also shows the Tyrano version that `kag.js` declares.

For library titles and icons, MacLauncher reads the local NW.js `window.title`, `productName` and `window.icon` values and the document's title and icon links. PNG and WebP artwork is read locally, while ICO artwork is converted to a cached PNG. Remote URLs, resources outside the game folder and dynamic scripts are ignored.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Electron (default) | Included with MacLauncher |
| NW.js | Downloaded from **Runtimes → NW.js** |
| NW.js (Patched) | The same NW.js installation with compatibility patches |
| Game's macOS app | A compatible Mac app supplied with the game |
| CrossOver, Sikarugir | Windows runtimes for the game's Windows executable |

[Web runtimes](../runtimes/WEB_RUNTIMES.md) describes the hosts and their settings. When a Tyrano game runs in Electron, it uses the shared legacy NW.js window interface, and its browser scripts keep their global libraries instead of loading through CommonJS.

## Preparation and saves

Whether a game must be extracted depends on how it is packaged. A `package.nw` folder is already readable, so it runs from its original location, and status checks do not copy it. A packaged game, such as a ZIP payload inside an executable or an `app.asar` archive, has to be extracted before it can launch. The extracted copy is kept in the game's launcher data and reused afterwards. For packed executables, extraction can fall back to the included [evbunpack](../runtimes/README.md#included-internal-tools).

Some Tyrano exports also expect a `$.userenv` object that their runtime does not provide. For these exports, MacLauncher injects a compatibility fallback into the game process without editing the author's `libs.js`.

Older Tyrano exports save files next to the runner executable. In Electron, that executable is MacLauncher's shared Electron executable, which does not become the game's save location. Tyrano's file-save functions instead write the original escaped JSON format to the original game folder, or to the save-folder override. Browser storage stays in the selected browser profile.

## Tools

Extraction unpacks supported game packages into a script and resource tree, and the inspector's **Extract** group offers it through **Extract**, **Reveal** and **Remove extracted files**. Existing KAG-style scenarios and JavaScript can already be read directly. Minification, plugins or game-specific encryption can limit readability, however, and extraction does not restore an original TyranoBuilder project.
