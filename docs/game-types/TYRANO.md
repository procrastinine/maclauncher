# Tyrano

TyranoScript and TyranoBuilder games are HTML games with KAG-style scenario scripts. MacLauncher runs them in its [web runtimes](../runtimes/WEB_RUNTIMES.md).

## Detection

Import accepts the game folder, its HTML entry page, a `package.nw` folder or file, a Windows executable, or a Mac app bundle, including an Electron app with `Contents/Resources/app.asar`. The engine file `tyrano/plugins/kag/kag.js` identifies a Tyrano game. Packaged games are recognized from their contents: a ZIP payload inside an executable or a `package.nw` file must contain the engine file together with `package.json` or `builder_config.json`, and an Electron `app.asar` archive must contain the engine file. When a Tyrano executable sits next to a generic `index.html`, its archive contents identify it as Tyrano before the generic Web game type is considered.

The inspector shows the Tyrano version declared in `kag.js`.

Library titles and icons come from the local NW.js `window.title`, `productName` and `window.icon` values and from the document's title and icon links. PNG and WebP artwork is read locally and ICO artwork is converted to a cached PNG; remote URLs, resources outside the game folder and dynamic scripts are ignored.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Electron (default) | Included with MacLauncher |
| NW.js | Downloaded from **Runtimes → NW.js** |
| NW.js (Patched) | The same NW.js installation with compatibility patches |
| Game's macOS app | A compatible Mac app supplied with the game |
| CrossOver, Sikarugir (Wine) | Windows runtimes for the game's Windows executable |

[Web runtimes](../runtimes/WEB_RUNTIMES.md) describes the hosts and their settings. In Electron, Tyrano games use the shared legacy NW.js window interface, and browser scripts keep their global libraries instead of loading through CommonJS.

## Preparation and saves

A `package.nw` folder is already readable and runs from its original location; status checks do not copy it. A packaged game, such as a ZIP payload inside an executable or an `app.asar` archive, has to be extracted before it can launch, and the extracted copy in the game's launcher data is reused afterwards. Extraction can fall back to the included [evbunpack](../runtimes/README.md#included-internal-tools) for packed executables.

Some Tyrano exports expect a `$.userenv` object that their runtime does not provide. MacLauncher injects that compatibility fallback into the game process without editing the author's `libs.js`.

Older Tyrano exports save files next to the runner executable. In Electron, Tyrano's file-save functions write the original escaped JSON format to the original game folder, or to the save-folder override. The shared Electron executable does not become the game's save location. Browser storage stays in the selected browser profile.

## Tools

The inspector's **Extract** group has **Extract**, **Reveal** and **Remove extracted files**. Extraction unpacks supported game packages into a script and resource tree. Existing KAG-style scenarios and JavaScript are already readable directly. Minification, plugins or game-specific encryption can limit readability, and extraction does not restore an original TyranoBuilder project.
