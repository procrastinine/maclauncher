# Ren'Py Live2D libraries

Ren'Py SDK installations expose **Install Live2D**, **Import Live2D ZIP**, and **Remove Live2D** on each installed version row. Install downloads a pinned official Cubism SDK for Native archive, extracts only the macOS Core dylib and its license, and installs it beside that SDK's macOS `renpy` executable. Each SDK owns its own library. These actions are pure Node functions; no Electron import, game execution or network request occurs while loading the module or reading SDK status.

After download confirmation, an explicit Play action can install a missing SDK and its matching Live2D library when bounded loose-file/RPA index inspection finds `.moc3` or `.model3.json` assets. The inspector does not evaluate scripts or deserialize Python objects. Unknown/protected archives remain unknown; users can install Live2D from the SDK row. SDK selection preserves explicit game/global overrides and otherwise prefers the detected exact published version. Unknown Ren'Py major versions require a choice.

Play claims the actual SDK version and Python generation before preparation. Missing
Live2D downloads use that SDK's shared mutation guard and recheck the library after
waiting, while a game already using it prevents changes. Other SDK versions remain
independent; source use lasts until the game exits.

| Ren'Py runtime | Required ordering export | Pinned Native SDK archive |
| --- | --- | --- |
| SDK7 and SDK8 through 8.5.2 | `csmGetDrawableRenderOrders` | `5-r.4.1` |
| SDK8 from 8.5.3 | `csmGetRenderOrders` | `5-r.5` |

The change is stated in the [Ren'Py 8.5.3 changelog](https://www.renpy.org/doc/html/changelog.html#id10) and reflected in its [pinned native loader](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy/gl2/live2dcsm.pxi). The SDK 7.8.7/8.5.2 loaders use the legacy export. Live2D's [5.3 compatibility guidance](https://docs.live2d.com/en/cubism-sdk-manual/compatibility-with-cubism-5-3/) distinguishes Native SDK R5 from R4 and earlier. Installing the latest Core in an older Ren'Py SDK is therefore rejected rather than assumed compatible.

The installer checks the dylib's bounded Mach-O headers and symbol tables for every runtime CPU architecture and all required Cython exports. It never executes an imported library to inspect it. ZIP directory paths, symlinks, encryption, duplicate members, sizes, deflate expansion and CRCs are checked before installation. An existing library is backed up with its checksum and mode. Removal restores that original only when the current installed library and backup still match their recorded checksums; changed files are preserved with an error. Import records distinguish an exact pinned official archive from a user-supplied archive.

The game's **Libraries** group is separate. Install Live2D library changes only its existing macOS runtime library directory and keeps its reversal record in launcher game data. A runtime copied by Patch uses the recorded SDK version; a preexisting macOS runtime uses its detected actual version. Unknown versions and signed app bundles are refused. No model, script, archive, or runtime executable is rewritten by Live2D installation. Import can also supply `archivePath` or `filePaths` headlessly.

## Backend API

`sdk-runtime-manager.performInstalledAction({installedActionId, sectionId, version, userDataDir, archivePath?, downloads?, signal?})` accepts `installLive2D`, `importLive2D`, or `removeLive2D`. Sections are `v7` and `v8`. `getState()` returns each row's `libraries.live2d` status and `actions` descriptors; Import declares `inputKind: 'file'` and `extensions: ['zip']` for the launcher's injected file picker.

Module actions are `live2DStatus`, `patchLive2D`, and `removeLive2D`. `live2d.js` exports lower-level target, status, import, download and remove functions for headless callers. Downloads use the shared progress/cancellation manager, explicit HTTPS URLs, bounded archive sizes, and pinned SHA-256. Downloaded ZIPs remain in `userData/runtimes/live2d/<version>` for later explicit installs.

| Native SDK archive | SHA-256 |
| --- | --- |
| `5-r.4.1` | `b71ec6bafc6578cce3b4cbbaa42a1cb51ae6eb477557932b02d22af957e733c7` |
| `5-r.5` | `7ff3a4bbc19c0a8728965aa522ab77eb11b252916453e68a8a78d3b71188bb12` |

Official versioned URLs are published by Live2D's [Native SDK download script](https://cubism.live2d.com/sdk-native/js/download.js); the [download page and license terms](https://www.live2d.com/en/sdk/download/native/) remain linked from the actions. Vendor binaries and ZIPs are not bundled with the launcher.

## Compatibility limits

Library selection enforces the runtime's CPU and ordering-symbol requirements. Model behavior still depends on the selected Ren'Py renderer, game scripts and assets; a matching Core library does not ensure every model renders correctly.
