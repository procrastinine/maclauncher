# MKXP-Z binary distribution

The RGSS backend includes a pinned [MKXP-Z](https://github.com/mkxp-z/mkxp-z) binary. The default works offline without GitHub CLI, an account, a compiler or a source checkout. Optional **Reload** and **All versions** checks retain authenticated GitHub Actions downloads through `gh`; selecting a missing upstream build never silently installs a different version.

Every Play starts the same shared runtime executable with a tiny, unique config directory under `userData/games/<gameId>/runtimes/mkxpz/<version>/sessions/<launch-id>/`. It does not copy the app or its native libraries. Configs, logs and launch records belong to the session, so two games, or two headless launches of the same game, cannot overwrite each other's startup JSON. Original game assets stay in their original directory unless a packaged container requires automatic extraction.

An existing owned installation for the selected exact version takes priority, including an explicit installation of the Included version. A damaged selected installation fails without silently changing sources. With no exact owned registration, default Play reads the verified Included base directly and creates no global runtime copy. Explicit upstream versions remain installed under `userData/runtimes/mkxpz/<version>/` and use the same config isolation. A previously written publisher or managed-app config is never inherited into the new JSON.

Preparation binds the selected version to the canonical source path, immutable app tree, executable SHA-256 and exact config-helper build. Publisher executables, app config and Included resources stay unchanged. The module uses plain Node and reports the exact shared base and shared asset generation to runtime lease coordination. Removing or replacing an in-use base, or explicitly removing shared RGSS assets, is refused while a game uses it; unrelated runtime versions can still launch independently.

## Shared config helper

MKXP-Z's [macOS startup](https://github.com/mkxp-z/mkxp-z/blob/794d1897abe529a23f3f2f9c4f72d711a3b18391/src/main.cpp) first enters the app's `Contents/Game` before [reading `mkxp.json`](https://github.com/mkxp-z/mkxp-z/blob/794d1897abe529a23f3f2f9c4f72d711a3b18391/src/config.cpp). The small [config helper](../../src/modules/rgss/overlays/mkxpz-config.c) redirects only that exact directory transition in the selected native child. Every other `chdir` forwards unchanged, including the transition to the original game folder. The launcher process is never injected and its working directory/environment stay unchanged. The child starts in its private config directory, also supporting older apps that omit an empty `Contents/Game`.

`config-cwd-v2-universal` is a shared, sealed ARM64/Intel supplemental with a macOS 11.0 floor and a relocatable `@rpath` library identity. It is read directly from app resources; users need no installation or compiler. The [declaration](../../src/modules/rgss/runtime/distribution-supplementals.json) binds its source, native binary, manifest, license, CPU slices and floor. Compatible existing DYLD injections are retained; stale MacLauncher config mappings are replaced only in the child environment. Hardened or restricted signing policies that block the helper fail with an explicit runtime-selection error. Publisher bytes are never patched or re-signed during Play.

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

[bundled-binary.json](../../src/modules/rgss/runtime/bundled-binary.json) records the exact Actions build, publisher source revision, executable SHA-256 and complete input-app tree SHA-256. [binary-package.js](../../src/modules/rgss/runtime/binary-package.js) owns the staging recipe. Compiled app files are ignored and travel in the verified runtime payload release archive described in [CI setup](../CI.md). MKXP-Z does not require a source submodule or local source adaptation.

The binary retains its publisher source reference; it is not rebuilt by MacLauncher. Its manifest records `sourceKind: "reviewed-binary"` and `verifiedBuild: false`. Runtime notices and required corresponding source accompany release distribution separately; they are not production source dependencies.

## Staging the binary

Provide the original publisher `Z-universal.app`, including its license file. The shared stager checks every input file and permission against the pinned tree before relocating or signing a separate copy:

```sh
node scripts/stage-mkxpz-binary.cjs \
  --app /path/to/Z-universal.app \
  --output /path/to/staged-runtimes --arch arm64

node scripts/publish-native-runtimes.cjs \
  --source /path/to/staged-runtimes --only mkxpz --arch arm64
```

Use `--arch x64` for an Intel package; staging verifies actual native slices and dependency deployment targets. A universal publisher binary can supply both architectures.

The supplemental helper's developer recipe is:

```sh
node scripts/stage-mkxpz-config-helper.cjs --output /path/to/empty-staging
```

It builds both CPU slices, checks their macOS floor and signs the library ad hoc, then prints the new package metadata. Apple Command Line Tools are needed only for this developer build; install them on the Mac with `xcode-select --install` (their directory is `/Library/Developer/CommandLineTools`). Release verification packages the pinned helper with the native payload. Do not overwrite an existing sealed helper or relabel different bytes with its old version.

To update the default, obtain the exact new publisher artifact, verify its executable and full-tree identities, update the pin and any changed app layout, then stage the new versioned package. Do not label a different artifact with the old pin or modify an already sealed payload. Ordinary users can continue using the older included version or install an explicitly selected upstream Actions version through `gh`.
