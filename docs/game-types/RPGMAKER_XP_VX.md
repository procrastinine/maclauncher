# RPG Maker XP/VX/VX Ace

RPG Maker XP, VX and VX Ace games run on the Ruby Game Scripting System (RGSS): XP uses RGSS1, VX uses RGSS2 and VX Ace uses RGSS3. MacLauncher plays these games with [MKXP-Z](https://github.com/mkxp-z/mkxp-z), an RGSS-compatible player. It also offers Ruby script export and repacking, read-only save and database inspection, and in-game cheats.

## Detection

Import accepts the game folder, `Game.exe`, `Game.ini` or an encrypted archive (`.rgssad`, `.rgss2a` or `.rgss3a`). A folder is recognized by `Game.ini` or by `Data/Scripts.rxdata`, `.rvdata` or `.rvdata2`. When a game is packed into an archive, installer or packed executable, it is extracted automatically.

By default, the **RGSS version** setting uses the version that MacLauncher detected. Alternatively, **Auto (MKXP-Z)** lets MKXP-Z decide, or RGSS1, RGSS2 or RGSS3 can be set explicitly.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| MKXP-Z (default) | Package from MacLauncher Builds, or an upstream build |
| CrossOver, Sikarugir (Wine) | Windows runtimes for the original `Game.exe` |

MKXP-Z has a long list of runtime settings for the window, scaling, fonts, audio, Ruby and RTP paths; the [settings reference](../runtimes/SETTINGS_REFERENCE.md#rpg-maker-xpvxvx-ace) lists them all.

### MKXP-Z versions

**Runtimes → MKXP-Z** has two download sources with separate controls:

- MacLauncher Builds packages, listed from the public [Builds catalog](https://procrastinine.github.io/maclauncher-builds/#mkxpz). Downloads need no GitHub CLI or account. These packages include MacLauncher's [fix for Unicode file names](#macos-file-name-normalization).
- Upstream GitHub Actions builds of the `dev` branch, read from GitHub's public API with no GitHub CLI or account. The refresh control lists the newest successful build with a macOS app artifact, and **All versions** lists every such build among the 20 most recent successful runs. From each run, one app artifact is listed: a universal app in preference to the app for this Mac's CPU, while standalone and other-CPU artifacts are not listed. The artifact is downloaded through [nightly.link](https://nightly.link/), also without a sign-in, and checked against the digest that GitHub publishes for it. An expired artifact is no longer listed, although an installed build keeps working after its artifact expires.

Installed versions from both sources share the inspector's MKXP-Z version selector and the runtime settings. Publisher builds installed by earlier launcher versions remain usable.

During installation, MacLauncher verifies the catalog entry, the archive, every installed file and the publisher's identity. MacLauncher Builds packages are installed under `userData/runtimes/mkxpz/<architecture>/<version>/`, where the architecture is `arm64`, `x64` or `universal`, and the Apple Silicon and Intel apps share a Universal installation. Packages installed earlier in a single folder per version stay where they are and are listed alongside the new ones, and both layouts keep their recorded manifest and checksum checks. Each game then gets its own app bundle that uses the libraries and resources of the selected base installation.

## Preparation and launch

For every game, including one extracted from an installer, game data and portable saves come from the original game folder, and Play does not create a second game tree.

What Play does prepare is a native application entry (a cached app bundle named after the game) and a small, unique config folder for each launch under `userData/games/<gameId>/runtimes/mkxpz/<version>/sessions/<launch-id>/`. Of the runtime files, only the main executable is copied, as an APFS copy-on-write clone where the volume supports cloning, and given an ad hoc signature. Native libraries, Ruby resources and other runtime assets stay linked to the base installation. Later launches reuse this signed entry without copying, signing or reading the executable again.

Configs, logs and launch records belong to the launch session, so two games, or two launches of the same game, cannot overwrite each other's startup JSON. A config written earlier by the publisher or by a MacLauncher app entry is never carried into the new JSON.

Preparation records the selected version together with the canonical source path, the app tree, the executable's SHA-256 and the exact config-helper build, and it never modifies the published MKXP-Z executables, the app config or the shared runtime resources. On repeated launches, the verified hashes of native files are reused as long as their device, inode, mode, size, modification time and change time stay the same. A changed file is read again and compared with its recorded hash, and a second metadata check detects changes made during preparation.

While a game runs, MacLauncher records that it uses the base installation, its native entry and the shared assets, as described in [concurrent runtime use](../runtimes/README.md#concurrent-runtime-use). Removing or replacing a base that a game is using is therefore refused, and so is explicitly removing shared RGSS assets while a game uses them. Other runtime versions can still launch.

Old native entries are cleaned up after a game process and its teardown finish. The cleanup keeps the current native entry and one recent fallback, and it leaves active, modified and unrecognized entries in place. Because this check runs when the process ends, Play does not scan the cache first. Removing a game also removes its native-entry cache, while removing a shared runtime version leaves per-game data intact.

### Shared config helper

MKXP-Z looks for its configuration in a fixed place. At startup, its [macOS code](https://github.com/mkxp-z/mkxp-z/blob/37a04d14413454551a7b6aadbb4e93e67168accb/src/filesystem/filesystemImplApple.mm) changes into the app's `Contents/Game` folder, or into the publisher's resource folder beside the app, before it [reads `mkxp.json`](https://github.com/mkxp-z/mkxp-z/blob/37a04d14413454551a7b6aadbb4e93e67168accb/src/config.cpp). To give each launch its own configuration, the small [config helper](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/rgss/overlays/mkxpz-config.c) redirects only that one folder change, in the game process only, to the current launch session. Every other `chdir` passes through unchanged, including the change to the original game folder. The native game entry contains an empty `Contents/Game` folder so that the engine takes that path. No shared config file or link to a session is installed, and the launcher process itself is never injected, so its working folder and environment stay unchanged.

When Play runs the selected runtime directly instead, that runtime keeps its original layout. Publisher Ruby libraries stay shared beside the app, and an empty Ruby load path includes the original game folder, the shared standard library and the configuration folder for the matching CPU.

The helper itself, version `1.0.0`, is a universal ARM64 and Intel library for macOS 11.0 or later, with a relocatable `@rpath` install name, and it is read directly from MacLauncher's app resources. Its [package record](../../src/modules/rgss/runtime/distribution-supplementals.json) lists the source, native binary, manifest, license, CPU slices and minimum macOS version, and the source and build scripts are in the MacLauncher release commit that includes it. Compatible existing `DYLD` injections are kept, and stale MacLauncher config mappings are replaced only in the game process's environment. A runtime whose signing policy (hardened or restricted) blocks the helper fails with an explicit runtime-selection error. The original runtime files are never patched or re-signed during Play.

### Application name and icon

The native entry shows the game's name and icon, but it keeps the original bundle identifier and the property-list fields that are not about display, including native window and resource settings. The runtime therefore keeps its application-preference domain and configured save locations. The cached executable entry is supplied by the [shared native-application helper](../../src/modules/shared/native-application.js), and its resource and framework links point only to the base installation. If the named app entry cannot be prepared, Play records a warning and uses the selected runtime directly. Neither `NSProcessInfo.processName` nor `NSBundle` methods are replaced.

By default, `iconPath` comes from the imported game icon, although an explicit runtime icon takes precedence. Once AppKit has finished launching, the [macOS icon helper](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/rgss/overlays/mkxpz-identity.m) also applies the icon through the public application-icon API. The icon must be a canonical regular file of at most 8 MiB with source dimensions no larger than 4096 × 4096, and decoding keeps a thumbnail of at most 512 pixels. If the icon is missing or invalid, the runtime's icon is kept.

### Shared assets

The included Kawariki compatibility scripts are extracted into one shared folder for each version of their source, and that folder never changes afterwards. RTP packs are stored separately and are also shared between games. Updates and repairs create a new folder and keep the earlier ones until an explicit **Remove**, which is refused while a game uses them. The inspector's **Assets** group reveals the staged compatibility scripts, prepares them again (**Extract runtime assets**) and removes them.

The GMGSx MIDI soundfont is downloaded on the first Play after consent, unless **Soundfont path** supplies another file. MacLauncher checks the download against a fixed size and SHA-256 before installing it, and the soundfont then remains in shared permanent Application Support for later offline launches.

To detect changes, packaged support files are identified by the real ASAR archive rather than its virtual inode values, and unpacked support files by their file system identifiers. Unchanged files reuse cached content hashes and changed files are checked again, while a change during a read or a symlinked source stops the extraction.

## RTP assets

The RPG Maker Run Time Package (RTP) supplies standard graphics and audio that many games do not ship themselves. `Game.ini` names the RTP packs a game needs: XP uses RTP1, RTP2 and RTP3 in that order, while VX and VX Ace use RTP. Empty entries need no pack. Play downloads a missing supported pack from the [official RPG Maker downloads](https://www.rpgmakerweb.com/downloads), extracts its data automatically and starts the game. Each missing pack has its own download and license consent, and these requests are collected alongside runtime consent before installation begins, so declining any of them leaves every pending installation untouched. Installing RTP preserves the selected MKXP-Z runtime and default. The publisher's RTP terms apply, and the Windows installer is read as data and never run.

| Pack | Version | Download | Shared data |
| --- | --- | --- | --- |
| XP / Standard | 1.04 | 22 MiB | 21 MiB |
| VX / RPGVX | 1.02 | 36 MiB | 42 MiB |
| VX Ace / RPGVXAce | 1.00 | 186 MiB | 194 MiB |

Each pack's download link is read from the official downloads page. MacLauncher's [RTP catalog](../../src/modules/rgss/rtp-catalog.json) records each known official archive, the installer inside it and its companion data, the installer's file list, and the checksum of the complete extracted data, and a matching download is checked against those records. When the publisher has replaced an archive, the new archive installs from its own installer's file list, and its archive and data hashes are recorded at installation. Each pack then occupies one unchanging folder under `userData/modules/rgss/assets/rtp-packs/<pack>/<version>/`, which later launches reuse without per-game copies. Damaged data is repaired into a new folder without replacing paths that an earlier game uses, and valid existing RTP folders stay usable.

RTP files can also come from elsewhere. **RTP source → Manual path** selects a local folder or archive, and **Extra RTP paths** add further search locations. Custom RTP names have no automatic official download; instead, their files can ship with the game or be selected through these settings. An empty RTP declaration never makes MacLauncher infer a pack from the RGSS version.

## Cheats

For in-game cheats, MKXP-Z loads MacLauncher's cheat script as a postload script. In the game, F8 then opens the RGSS cheat menu, which mirrors the launcher's cheat fields. [Cheats](../tools/CHEATS.md#rpg-maker-xpvxvx-ace-cheat-menu) lists the available cheats for each RGSS version.

## Ruby scripts

RGSS games store their Ruby scripts in a script archive in the game data. The inspector's **Ruby scripts** group exports them for editing and packs the edited scripts into a new archive:

1. **Export Ruby scripts** writes each script to its own file in a new working folder. Exporting again leaves earlier edits intact.
2. **Reveal scripts** opens the folder, where the `.rb` files can be edited.
3. **Repack edited scripts** writes a new script archive from the edits.

To find the script archive, MacLauncher uses the file named by the `[Game] Scripts` entry in `Game.ini`, or otherwise `Data/Scripts.rxdata`, `.rvdata` or `.rvdata2`, in any letter case. Paths in INI files must stay inside the game's content folder. For encrypted and packaged games, the existing extraction step has to run before the script archive can be read.

Exports are stored under `userData/games/<gameId>/modules/rgss/tools/scripts/<exportId>/` and contain:

- `original.bin`: the original Marshal bytes, kept as the baseline.
- `manifest.json`: the engine variant, the selected MKXP-Z version when one is configured, the original hash, the record order, IDs, names as base64 bytes, source and compressed hashes, and node identities.
- `<index>-<id>.rb`: the exact inflated source bytes of each script. Duplicate IDs and names and empty names remain separate records, and file names never contain script names, which could be unsafe.

Before it repacks, the repacker checks the manifest against the original baseline and rejects missing files, changed IDs or order, symlinked files and conflicting edits to a shared compressed payload. Untouched scripts keep their original compressed bytes, and an edited source replaces only the matching existing String byte sequence, so object and symbol tables, encoding instance variables, names, aliases and other serialized data stay in place. As a result, a repack without edits is byte-identical to the original archive.

Each repack is written as a new file under `tools/repacked/`, so the game's own files are never overwritten. Installing a repacked archive, and running the edited scripts, is a separate decision for the user, and the edited archive loads in the selected RGSS runtime. These tools recover the Ruby source that the game stores; they do not decompile native code or rebuild missing DLLs or editor assets.

## Saves and databases

**Find portable saves** lists the stock `Save*.rxdata` (XP), `Save*.rvdata` (VX) and `Save*.rvdata2` (VX Ace) files in the content folders, RGSS data and `.sav` files in `Save` or `Saves` subfolders, and the files in a configured save-folder override. For each file, it checks the Marshal header and records the size and modification time. Symbolic links are skipped, at most 256 files are listed, and database files at the root and the `Data/` folder are excluded. Games with custom save scripts may need a folder chosen through the backend's `directory` payload instead.

**Inspect save or database** reads a selected file and writes a graph report under `tools/reports/`. Each game keeps one current save report and one inspection report, so a successful run replaces the earlier report of the same kind. From the backend, a caller supplies `{ filePath }`.

XP and VX saves consist of sequential Marshal streams, so the inspector reads such streams and resets the reference tables for each one. Because graph edges are node IDs, shared references and cycles survive inspection. Raw strings, symbol names, encodings, class names, Float and Bignum representations and opaque `_dump` payloads are kept as bytes, with short text previews, while Table, Color and Tone payloads stay opaque instead of being guessed at or deserialized.

The parser never imports Ruby, resolves classes, calls `_load` or `marshal_load`, evaluates source or runs regular expressions from the input. It reads only Marshal 4.8, and it rejects unknown tags, `U` (`marshal_load`), `d` (`_load_data`), `e` (extensions) and `C` (subclasses). Custom ordinary objects and Structs become inert nodes holding the class name and instance variables, and `u` payloads become inert bytes. Encoded `_dump` payloads follow Ruby's delayed object-registration rule, which keeps later reference IDs correct.

The default limits are 64 MiB of input, 250,000 nodes, a depth of 256, 100,000 entries per collection, 32 MiB per blob and 64 sequential streams, and callers can lower them. Script inflation is limited to 8 MiB per script and 128 MiB of source in total. Truncated blobs, negative lengths, invalid links, oversized input, trailing compressed data and format mismatches produce a decoding error.

Save editing is not available.

## Asset extraction

The inspector's **Extract** group decrypts supported RGSS archives with [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter), and it can also reveal or remove the extracted files.

RPGMakerDecrypter is downloaded from MacLauncher Builds, which publishes separate Apple Silicon and Intel packages. Automatic selection follows the launcher process, while alternate builds use the shared [runtime architecture controls](../runtimes/README.md). Intel extraction on Apple Silicon needs the [Rosetta prerequisite](../runtimes/ROSETTA.md), which is completed before an existing extraction is replaced, so declining it preserves those files.

## Backend API

The RGSS tools run in the Node backend; Electron only supplies file selection and reveal services, and the same module actions work from the backend with explicit payload paths.

- `src/modules/rgss/marshal.js` provides `parseMarshal`, `resolveNode`, `graphReport` and a String-byte replacement helper.
- `script-tools.js` provides `decodeScripts`, `exportScripts`, `repackScripts` and `writeRepackedScripts`.
- `tools.js` handles content lookup, save discovery and per-game reports.

The module's actions are `exportScripts`, `repackScripts`, `discoverSaves`, `inspectRgssFile`, `refreshRgssTools` and `revealScripts`. They require a valid `gameId` and `context.userDataDir`.

## Package sources

Two files in MacLauncher Builds describe how the publisher's app is packaged. [bundled-binary.json](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/rgss/runtime/bundled-binary.json) records the exact Actions build, the publisher's source revision, the executable's SHA-256 and the SHA-256 of the complete input app tree, and [binary-package.js](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/rgss/runtime/binary-package.js) is the packaging script.

MacLauncher does not rebuild the publisher's binaries, which keep their original source references, and their manifests record `sourceKind: "reviewed-binary"` and `verifiedBuild: false`. The build with MacLauncher's file-name fix, by contrast, records `sourceKind: "owned-source-adaptation"`, the exact patch and implementation hashes, and `verifiedBuild: true`. License notices stay with the binaries, and the corresponding source and patches are available at the Builds release's tagged Git commit.

## macOS file-name normalization

MKXP-Z's path cache converts file names with `iconv_open("utf-8", "utf-8-mac")`, which depends on the converter-specific `utf-8-mac` encoding name. MacLauncher's [file-name normalization patch](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json), which targets MKXP-Z source revision `37a04d14413454551a7b6aadbb4e93e67168accb`, replaces that conversion with CoreFoundation's complete Unicode NFC implementation. Path caching, original asset paths and case-insensitive lookup stay enabled.

With the patch, valid UTF-8 file names are normalized to NFC before they enter the path cache. Malformed UTF-8, a result that is not canonically equivalent to the input, or a normalized path longer than the existing 512-byte buffer raises a file-system error instead, before the original path is replaced. The macOS build links the system CoreFoundation framework explicitly and keeps a macOS 11.0 deployment target.

Builds with this fix are separate MKXP-Z versions, each with its own version and executable checksum in the [MacLauncher Builds catalog](https://github.com/procrastinine/maclauncher-builds/blob/main/catalogs/mkxpz.json). They use the same cached native-entry preparation, per-launch configuration and graphics integration as other MKXP-Z versions, and publisher builds stay separately selectable. The launcher itself does not patch source during Play, intercept the statically linked converter or modify an installed publisher executable.

The [source descriptor](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json) records the exact original and changed file-system and Meson files, the patch, the C header and the implementation. The CoreFoundation implementation is compiled as C, to keep Apple framework types apart from the engine's C++ types. [The build recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/scripts/build-mkxpz-nfc.cjs) applies the adaptation to the exact source archive and uses the upstream Meson dependency set; it enables the macOS Metal backend, disables the Linux window-system backends, targets macOS 11.0 and verifies the native dependencies before signing a separate app. Each build's MacLauncher Builds release commit contains the exact source commits and the build script, while compilers and dependency checkouts are not part of the package.

## Packages

For the publisher's builds, MacLauncher Builds packages the original `mkxp-z.universal.app` with its `LICENSE.txt`, `mkxp.json`, `scripts/` and `stdlib/`, after checking every publisher file and permission against recorded file lists. Only the copied executable is relocated and signed, and each package build verifies its actual native slices and the deployment targets of its dependencies. The included per-launch configuration helper contains both CPU slices and is signed ad hoc; every change to the helper gets a new version and checksum. Once published, a package never changes. [Development](../development/DEVELOPMENT.md) covers rebuilding included helpers.
