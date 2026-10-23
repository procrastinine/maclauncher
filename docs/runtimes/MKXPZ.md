# MKXP-Z binary distribution

The RGSS backend manages pinned [MKXP-Z](https://github.com/mkxp-z/mkxp-z) binaries from MacLauncher Builds. Play requests download consent when the selected version is missing, installs it automatically and continues. Downloads need no GitHub CLI, account, compiler or source checkout. Installed versions work offline. **Reload** queries its public catalog; optional authenticated GitHub Actions builds remain available through `gh`. Selecting a missing upstream build never silently installs a different version.

Auto uses **20261003 · NFC 1** on Apple Silicon, with the macOS filename-normalization adaptation. Intel Macs use publisher build **20260112**. Both publisher builds **20260112** and **20261003** remain selectable through exact per-game version overrides. Installing another build does not change Auto.

Hosted baseline downloads use the shared Downloads list with progress and Cancel.
Installation verifies the catalog, archive, complete payload and publisher identity;
it preserves the selected version and keeps one managed base. Native game entries share its libraries and resources.
Refresh and installation run only after explicit actions.

GitHub CLI discovery includes standard Homebrew and MacPorts locations for Finder
and Dock launches. Installing an upstream build reports a missing executable
separately from unavailable GitHub authentication.

Play prepares a cached, game-named native application entry and a tiny, unique config directory under `userData/games/<gameId>/runtimes/mkxpz/<version>/sessions/<launch-id>/`. Only the main executable receives an APFS copy-on-write clone and an ad-hoc signature; native libraries, Ruby resources and other runtime assets remain linked to the verified base. Warm repeated launches reuse the signed entry without cloning, signing or reading the executable bytes again. Configs, logs and launch records belong to the session, so two games, or two launches of the same game, cannot overwrite each other's startup JSON. Original game assets stay in their original directory unless a packaged container requires automatic extraction.

After a game process and its owned teardown finish, cache retirement keeps the current native entry and one recent fallback. Active, modified and unrecognized entries remain available. This bounded check runs during process retirement, without a cache scan before Play. Removing a game also removes its per-game native-entry cache; removing a shared runtime version leaves per-game data intact.

Existing exact managed installations remain usable, including publisher builds installed by earlier launcher versions. Runtimes lists installed versions and available MacLauncher Builds downloads. A damaged selected installation reports its integrity error without substituting another version. Runtime packages install under `userData/runtimes/mkxpz/<version>/` and share the same per-game config isolation. A previously written publisher or managed-app config is never inherited into the new JSON.

Preparation binds the selected version to the canonical source path, immutable app tree, executable SHA-256 and exact config-helper build. Publisher executables, app config and shared runtime resources stay unchanged. The module reports the exact base, cached native entry and shared asset generation to runtime lease coordination. Removing or replacing an in-use base, or explicitly removing shared RGSS assets, is refused while a game uses it; unrelated runtime versions can still launch independently.

Repeated launches reuse verified native-file hashes while device, inode, mode, size, modification time and change time remain unchanged. A changed file is read again and compared with its pinned hash; a second metadata check detects changes during preparation.

## Shared config helper

MKXP-Z's [macOS startup](https://github.com/mkxp-z/mkxp-z/blob/37a04d14413454551a7b6aadbb4e93e67168accb/src/filesystem/filesystemImplApple.mm) enters the app's existing `Contents/Game`, or the publisher resource directory beside the app, before [reading `mkxp.json`](https://github.com/mkxp-z/mkxp-z/blob/37a04d14413454551a7b6aadbb4e93e67168accb/src/config.cpp). The small [config helper](../../src/modules/rgss/overlays/mkxpz-config.c) redirects only that exact directory transition in the selected native child. Every other `chdir` forwards unchanged, including the transition to the original game folder. The launcher process is never injected and its working directory/environment stay unchanged. The native game entry contains an empty `Contents/Game` directory so the engine selects that path; the helper redirects its directory transition to the current session. No shared config file or link to a session is installed. Direct-source fallback retains the selected runtime’s original layout. Publisher Ruby libraries remain shared beside the app; an empty Ruby load path includes the original game folder, shared standard library and matching CPU configuration directory.

`config-identity-v7-universal-content1` is a shared, sealed ARM64/Intel supplemental with a macOS 11.0 floor and a relocatable `@rpath` library identity. It is read directly from app resources; no installation or compiler is required. The [declaration](../../src/modules/rgss/runtime/distribution-supplementals.json) binds its source identity, native binary, manifest, license, CPU slices and floor. Source and build recipes remain in the matching release commit. Compatible existing DYLD injections are retained; stale MacLauncher config mappings are replaced only in the child environment. Hardened or restricted signing policies that block the helper fail with an explicit runtime-selection error. Publisher bytes are never patched or re-signed during Play.

The native entry uses the game name and icon while preserving the original bundle identifier and non-display property-list fields, including native window and resource settings. This retains the runtime’s application-preference domain and configured save locations. The [shared native-application helper](../../src/modules/shared/native-application.js) supplies the cached executable entry; its resource and framework links point only to the verified base. If application identity preparation is unavailable, Play records a warning and uses the selected runtime directly. Neither `NSProcessInfo.processName` nor `NSBundle` methods are replaced.

The imported game icon supplies `iconPath` by default; an explicit runtime icon takes precedence. The [macOS icon helper](../../src/modules/rgss/overlays/mkxpz-identity.m) also applies it through the public application-icon API once AppKit finishes launching. Icon input is restricted to a canonical regular file of at most 8 MiB, with source dimensions no larger than 4096×4096; decoding retains a thumbnail of at most 512 pixels. An absent or invalid icon preserves the runtime icon.

Kawariki and the soundfont use one small immutable shared asset generation per source identity. RTP packs are stored separately and shared between games. Source updates or repairs preserve earlier paths until an explicit, guarded Remove action.

Packaged support files bind to the real ASAR archive identity rather than its virtual inode values. Unpacked support files retain their physical file identities. Unchanged files reuse cached content hashes; changed files are checked again. Changes during a read and source symlinks stop publication.

## RTP assets

Game.ini determines required RTP packs: XP uses RTP1, RTP2 and RTP3 in order; VX and VX Ace use RTP. Empty entries require no pack. Play prompts for a missing supported pack, downloads it from the [official RPG Maker downloads](https://www.rpgmakerweb.com/downloads), extracts its data automatically and starts the game. The publisher's RTP terms apply. The Windows installer is read as data and never executed.

| Pack | Version | Download | Shared data |
| --- | --- | --- | --- |
| XP / Standard | 1.04 | 22 MiB | 21 MiB |
| VX / RPGVX | 1.02 | 36 MiB | 42 MiB |
| VX Ace / RPGVXAce | 1.00 | 186 MiB | 194 MiB |

The [RTP catalog](../../src/modules/rgss/rtp-catalog.json) pins each official archive, inner installer and companion data, installer file list and complete extracted data checksum. Each pack occupies one immutable directory under `userData/modules/rgss/assets/rtp-packs/<pack>/<version>/`. Warm launches reuse it without network access or per-game copies. Damaged data is repaired into a new directory without replacing paths used by an earlier game. Valid existing shared RTP generations remain usable.

**RTP mode → Manual path** retains local directory or archive selection, and **Extra RTP paths** remain additional search locations. Custom RTP names have no automatic official download; their files can be included with the game or selected through these settings. An empty RTP declaration does not infer a pack from the RGSS version.

## What belongs in Git

[bundled-binary.json](../../src/modules/rgss/runtime/bundled-binary.json) records the exact Actions build, publisher source revision, executable SHA-256 and complete input-app tree SHA-256. [binary-package.js](../../src/modules/rgss/runtime/binary-package.js) owns the staging recipe. Compiled app files are ignored and travel in the verified runtime payload release archive described in [CI setup](../CI.md). Publisher binary installation does not require a source checkout or compiler.

Publisher binaries retain their original source references and are not rebuilt by MacLauncher. Their manifests record `sourceKind: "reviewed-binary"` and `verifiedBuild: false`. The separate adapted build records `sourceKind: "owned-source-adaptation"`, the exact patch and implementation hashes, and `verifiedBuild: true`. Runtime notices and required corresponding source accompany release distribution separately; they are not production source dependencies.

## macOS filename normalization source adaptation

The owned [filename normalization overlay](../../src/modules/rgss/overlays/mkxpz-filename-nfc/source.json) targets MKXP-Z source revision `37a04d14413454551a7b6aadbb4e93e67168accb`. It replaces the path cache's `iconv_open("utf-8", "utf-8-mac")` conversion with CoreFoundation's complete Unicode NFC implementation. This avoids dependence on a converter-specific `utf-8-mac` encoding name. Path caching, original asset paths and case-insensitive lookup remain enabled.

Valid UTF-8 filenames are normalized to NFC before insertion into the path cache. Malformed UTF-8, a result that is not canonically equivalent to the input, or a normalized path exceeding the existing 512-byte buffer raises a filesystem error before replacing the original path. The macOS build explicitly links the system CoreFoundation framework and retains a macOS 11.0 deployment target.

The Apple Silicon build with this adaptation has its own version and immutable executable identity in the [owned build catalog](../../src/modules/rgss/runtime/owned-builds.json). It uses the same cached native-entry preparation, per-launch configuration and graphics integration as other MKXP-Z versions. Publisher builds remain separately selectable. The launcher does not apply a source patch during Play, interpose the statically linked converter or modify an installed publisher executable.

The [source descriptor](../../src/modules/rgss/overlays/mkxpz-filename-nfc/source.json) pins the original and adapted filesystem and Meson files, patch, C header and implementation. The CoreFoundation implementation compiles as C to keep Apple framework types separate from the engine's C++ types. [The developer build recipe](../../scripts/build-mkxpz-nfc.cjs) applies the adaptation to the exact source archive and uses the upstream Meson dependency closure. It enables the macOS Metal backend, disables Linux window-system backends, targets macOS 11.0, and verifies native dependencies before signing a distinct app. The matching MacLauncher Builds release commit contains the source pins and build recipe. Compilers and dependency checkouts are separate from runtime resources.

## Staging the binary

Provide the original publisher `mkxp-z.universal.app` and its sibling `LICENSE.txt`, `mkxp.json`, `scripts/` and `stdlib/`. The staging recipe checks every publisher file and permission against the pinned trees before relocating or signing a separate copy. It sets only the copied executable to mode 0755:

```sh
node scripts/stage-mkxpz-binary.cjs \
  --app /path/to/mkxp-z.universal.app \
  --output /path/to/staged-runtimes --arch arm64

node scripts/publish-native-runtimes.cjs \
  --source /path/to/staged-runtimes --only mkxpz --arch arm64
```

`--arch x64` selects an Intel package; staging verifies actual native slices and dependency deployment targets. A universal publisher binary can supply both architectures.

The supplemental helper's developer recipe is:

```sh
node scripts/stage-mkxpz-config-helper.cjs --output /path/to/empty-staging
```

It builds both CPU slices, checks their macOS floor and signs the library ad hoc, then prints the new package metadata. This developer build requires Apple Command Line Tools at `/Library/Developer/CommandLineTools`, acquired through `xcode-select --install`. Release verification packages the pinned helper with the native payload. Each changed helper has a distinct sealed version and content identity.

Changing the recommended build selects a distinct artifact, executable/full-tree identity and versioned package. Each sealed payload retains its original pin and bytes. Older publisher versions and explicitly selected upstream Actions versions remain available through the game inspector.
