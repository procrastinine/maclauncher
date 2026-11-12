# Game icons

Each library entry shows an icon taken from the game itself, read offline without running the game. Module default icons are the last fallback.

## Icon candidates

The launcher tries these sources in order:

1. a renderable icon that the module resolves
2. the app or executable paths the entry names
3. executables next to a detected data file
4. the content folder
5. a parent folder of packaged content, within limits

A game imported as a single file uses only that file and its module's artwork; apps and executables next to it are not candidates. Candidate lists are ordered and limited. If one candidate has no readable icon, the lookup moves on to the next. A malformed module icon cannot replace a valid icon from the executable when the entry is normalized.

Executable discovery and icon selection share the same rules for excluding installers, updaters, crash reporters and bundled runtime tools from folder searches. Icon selection tries the game's executable before configuration tools, launchers and servers, which remain available as fallbacks. An executable already identified as the game can supply its own artwork, including a packaged game whose filename resembles an installer.

## Icon readers

### App bundles

Both XML and binary `Contents/Info.plist` files are read. The declared `CFBundleIconFile` takes precedence over `Contents/Resources/icon.icns` and other `*.icns` files in the bundle. Folders structured as application bundles without the `.app` suffix use the same path. Resource aliases that point outside the bundle are ignored.

### Windows executables

PNG icon resources are kept as they are. Older DIB resources are decoded, including palette colors, vertical row order and transparency masks, and encoded as standalone RGBA PNG files with Node's zlib and CRC checks. This conversion works without Electron. Reads of PE resources and image dimensions have limits.

### HTML, Construct, Tyrano and GameMaker HTML5

These game types read local NW.js `window.title`, `productName` and `window.icon` values, document titles and icon links. PNG and WebP resources are used in place, and ICO artwork is converted to a cached PNG. Remote URLs and resources outside the content folder are ignored, and scripts are never evaluated. Web icon inspection considers at most 16 candidates and reads at most 32 MiB in total.

### Ren'Py

Literal `config.window_icon` values come from loose scripts, read within size limits, or from an inert inspection of the compiled AST, including archived scripts. Dynamic, conditional, conflicting and unsafe paths are ignored. The reader also checks the conventional `gui/window_icon.png`, `gui/icon.png` and WebP names. RPA indexes are parsed without constructing Python objects, and only the selected image member is read, up to 8 MiB, so the game is never run or fully extracted to find its icon. PNG bytes are checked structurally, including the CRC, decompression and scanline limits, and the UI adapter decodes the selected image before showing it.

### LÖVE

Literal titles and PNG or WebP icons come from `conf.lua` in source folders, `.love` archives and fused ZIP exports.

### Java

PNG resources are read from the JAR within size limits. If the artwork is invalid, the lookup moves on to the next candidate.

### IPA packages

Declared loose PNG icon resources and conventional app icon file names are used.

### Siglus and RealLive

Loose ICO icons are read with the shared PNG and DIB decoder.

### Android

Labels and icons come from an included native APK resource reader, independently of installed Android and Java runtimes. It resolves localized labels and bitmap, vector and adaptive icons across the base APK and the matching splits. Reads run offline, with access only to the selected packages and a private temporary output folder.

## Caching

App and executable icons are cached together with the identities and timestamps of their source files, and are refreshed when the executable, its plist or the selected app icon changes. Each cached result records the extractor version, so an earlier failed lookup cannot hide artwork after the extractor improves. After an app upgrade, game facts are refreshed once, and unchanged games then reuse their caches.

| Icons | Cache |
| --- | --- |
| Ren'Py archived icons | `userData/games/<gameId>/modules/renpy/icons/`, with source fingerprints and content hashes. Changed source data refreshes the cache. A cached icon from an earlier explicit extraction can stay available after that extraction is removed. |
| Web, LÖVE, IPA and Siglus artwork | Per-game cache slots with a size limit. Validated, unchanged bytes are reused, and changed artwork replaces the cached file atomically. |
| Android labels and icons | `userData/games/<gameId>/icons/`, keyed by the package inputs, the locale and the reader version. |
| Java icons | The cache is invalidated when the archive's identity changes. |

The library draws each icon as a preview of at most 128 pixels, decoded once for each version of the icon file, and every row's icon is drawn with the list rather than when the row scrolls into view. The previews are saved in `icon-previews.json` in MacLauncher's data folder, for the app version that made them, so after a restart every icon whose file is unchanged is part of the first library paint.

WebP conversion, available when an image adapter is present, writes only to the launcher's own data. A metadata refresh keeps custom library titles and artwork; otherwise names and icons follow the changes observed in the source. Changing the runtime keeps the detected game type.

## Dock icons

Game windows get a separate generated Dock icon: a 256-pixel image with transparent padding and rounded macOS corners. A shared AppKit bitmap renderer draws it for Electron game hosts, for the generated application entries of Android JVM, ART, AIM and Mac.apk, and for the prepared application bundle of an AnyPS5 game. The library keeps showing the original artwork. A cached Dock image is refreshed during an ordinary launch when its content or style changes, and images that are already prepared keep their size when passed between launch adapters. Imported native publisher apps keep their own icons.

## Implementation

Icon discovery and Windows PE parsing are pure Node backend functions in `src/core/game-icons.js` and `src/core/icon-utils.js`. The Electron main process supplies image rendering checks and the optional app and WebP conversion. The compatibility import `src/main/icon-utils.js` keeps existing callers working.
