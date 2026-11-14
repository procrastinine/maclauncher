# Game icons

Each library entry shows an icon taken from the game itself, which MacLauncher reads offline without running the game. When no game artwork is found, the game type's default icon is used.

## Icon candidates

The launcher looks for an icon in these places, in order:

1. a renderable icon that the module resolves
2. the app or executable paths the entry names
3. executables next to a detected data file
4. the content folder
5. a parent folder of packaged content, within limits

A game imported as a single file uses only that file and its module's artwork, so apps and executables next to it are not considered. Candidate lists are ordered and limited, and when one candidate has no readable icon, the lookup moves on to the next. When the entry is normalized, a malformed module icon cannot replace a valid icon from the executable.

Folder searches leave out installers, updaters, crash reporters and bundled runtime tools, and executable discovery and icon selection apply the same rules for this. Icon selection tries the game's executable first and keeps configuration tools, launchers and servers as fallbacks. An executable that detection already identified as the game can supply its own artwork, even a packaged game whose filename resembles an installer.

## Icon readers

### App bundles

Both XML and binary `Contents/Info.plist` files are read, and the declared `CFBundleIconFile` takes precedence over `Contents/Resources/icon.icns` and other `*.icns` files in the bundle. Folders structured as application bundles without the `.app` suffix are read the same way. Resource aliases that point outside the bundle are ignored.

### Windows executables

PNG icon resources are kept as they are. Older DIB resources are decoded, including palette colors, vertical row order and transparency masks, and then encoded as standalone RGBA PNG files with Node's zlib and CRC checks, a conversion that works without Electron. Reads of PE resources and image dimensions are limited.

### HTML, Construct, Tyrano and GameMaker HTML5

For these game types, the title and icon come from local NW.js `window.title`, `productName` and `window.icon` values, document titles and icon links. PNG and WebP resources are used in place, while ICO artwork is converted to a cached PNG. Remote URLs and resources outside the content folder are ignored, and scripts are never evaluated. Web icon inspection considers at most 16 candidates and reads at most 32 MiB in total.

### Ren'Py

Literal `config.window_icon` values are read from loose scripts, within size limits, or found by inspecting the compiled AST without executing it, which also covers archived scripts. Dynamic, conditional, conflicting and unsafe paths are ignored. The reader also checks the conventional `gui/window_icon.png`, `gui/icon.png` and WebP names. Because RPA indexes are parsed without constructing Python objects and only the selected image member is read, up to 8 MiB, the game is never run or fully extracted to find its icon. PNG bytes are checked structurally, including the CRC, decompression and scanline limits, and the launcher's interface decodes the selected image before showing it.

### LÖVE

Literal titles and PNG or WebP icons come from `conf.lua` in source folders, `.love` archives and fused ZIP exports.

### Java

PNG resources are read from the JAR within size limits, and invalid artwork sends the lookup on to the next candidate.

### IPA packages

Declared loose PNG icon resources and conventional app icon file names are used.

### Siglus and RealLive

Loose ICO icons are read with the shared PNG and DIB decoder.

### Android

Labels and icons are read by a native APK resource reader included with MacLauncher, so they do not depend on installed Android and Java runtimes. The reader resolves localized labels and bitmap, vector and adaptive icons across the base APK and the matching splits. It runs offline, with access only to the selected packages and a private temporary output folder.

## Caching

App and executable icons are cached together with the resolved path, size, modification time and inode of their source files, so a change to the executable, its plist or the selected app icon refreshes them. Each cached result also records the extractor version, which keeps an earlier failed lookup from hiding artwork after the extractor improves. After an app upgrade, game facts are refreshed once, and unchanged games then reuse their caches.

| Icons | Cache |
| --- | --- |
| Ren'Py archived icons | `userData/games/<gameId>/modules/renpy/icons/`, with source fingerprints and content hashes. Changed source data refreshes the cache. A cached icon from an earlier explicit extraction can stay available after that extraction is removed. |
| Web, LÖVE, IPA and Siglus artwork | Per-game cache slots with a size limit. Validated, unchanged bytes are reused, and changed artwork replaces the cached file atomically. |
| Android labels and icons | `userData/games/<gameId>/icons/`, keyed by the package inputs, the locale and the reader version. |
| Java icons | The cache is invalidated when the archive's resolved path, inode, size or timestamps change. |

In the library, each icon is drawn as a preview of at most 128 pixels, decoded once for each version of the icon file. Every row's icon is drawn together with the list, so rows do not wait until they scroll into view. The previews are saved in `icon-previews.json` in MacLauncher's data folder for the app version that made them, and after a restart every icon whose file is unchanged appears as soon as the library does.

WebP conversion, which is available when the Electron main process supplies it, writes only to the launcher's own data. A metadata refresh keeps custom library titles and artwork; otherwise, names and icons follow the changes observed in the source. Changing the runtime keeps the detected game type.

## Dock icons

Game windows get a separate generated Dock icon, a 256-pixel image with transparent padding and rounded macOS corners, while the library keeps showing the original artwork. A shared AppKit bitmap renderer draws this icon for Electron game hosts, for the generated application entries of Android JVM, ART, AIM and Mac.apk, and for the prepared application bundle of an AnyPS5 game. When its content or style changes, a cached Dock image is refreshed during an ordinary launch, and images that are already prepared keep their size as they pass from one launch step to the next. Imported native publisher apps keep their own icons.

## Implementation

Icon discovery and Windows PE parsing are pure Node backend functions in `src/core/game-icons.js` and `src/core/icon-utils.js`. Image rendering checks and the optional app and WebP conversion come from the Electron main process. Existing callers keep working through the compatibility import `src/main/icon-utils.js`.
