# Development guide

This document covers local development, debugging, and useful scripts.

## Requirements
- Node.js 22.12+, 24, or 26 + current pnpm
- macOS 13 Ventura or later (required by Electron 44)

Install current pnpm using the [official installation instructions](https://pnpm.io/installation) before running these commands. Installation settings live in `pnpm-workspace.yaml`; pnpm 11+ reads `.npmrc` only for registry/auth configuration. The hoisted linker supports Electron packaging, with global virtual-store links disabled so installed dependencies remain within the checkout. The project uses the installed pnpm without selecting or downloading another tool version. Dependency installation and Electron acquisition are explicit commands.

## Dependency policy

- `minimumReleaseAge: 10080` holds direct and transitive npm releases for seven days, except the exact version listed below. Strict mode rejects a range with no eligible release; missing publication dates fail closed.
- `trustLockfile: false` rechecks existing lockfile entries, including frozen installs. A lockfile created under a weaker policy cannot bypass these checks.
- `trustPolicy: no-downgrade` rejects reductions in publisher trust evidence. `blockExoticSubdeps: true` rejects unexpected git/URL dependencies introduced transitively.
- Compatible `^` dependency ranges allow routine updates; the committed lockfile records exact resolutions and makes updates reviewable. Packages released within the last seven days stay at their newest eligible version; do not add broad age exceptions to make an update pass.
- `strictDepBuilds: true` fails on unreviewed dependency lifecycle scripts. `allowBuilds` explicitly denies the Windows-only `electron-winstaller` script. The project's install lifecycle prepares Electron after an explicit install or update.
- `verifyDepsBeforeRun: error` checks that installed dependencies match the project before scripts run, and fails when an explicit install is needed. Launching does not install dependencies.

The packaging graph overrides the legacy `tiny-async-pool@1` and `@electron/get@3` consumers to compatible `semver` 7.8.5, retaining trusted-publisher metadata.

The `@electron/get@3` proxy dependency uses `global-agent` 4.1.3 or a compatible
newer release. Its existing `bootstrap()` API remains compatible, and
[version 4.1 removed the old logger](https://github.com/gajus/global-agent/releases/tag/v4.1.0)
that depended on vulnerable `sprintf-js`. Downloader tests cover HTTP and HTTPS
proxies, `NO_PROXY` bypasses, certificate verification and checksum rejection.
The normal release-age, publisher-trust and audit policies still apply.

The exact age exception `http-cache-semantics@4.3.0` includes the [wildcard `Vary` fix](https://github.com/kornelski/http-cache-semantics/commit/9fb520be70eff3ff502fe965d9c3265ca2c64e26). Remove the exception after **2026-10-11 02:56:05.593 UTC**, when the release reaches seven days. Other versions retain the normal policy. The separate `max-stale` advisory is [disputed by the maintainer](https://github.com/github/advisory-database/issues/10139).

These controls reduce supply-chain exposure; package age is not a guarantee that a package is safe. The authoritative behavior is documented in [pnpm resolution settings](https://pnpm.io/settings/dependency-resolution) and [build settings](https://pnpm.io/settings/build).

## Updating dependencies

- `pnpm deps:update` runs `pnpm update --latest`, including new major versions, then runs `check` and the high-severity audit. The same release-age, trust, and script controls apply. Review the resulting manifest and lockfile changes.
- Update pnpm independently with `pnpm self-update`, or `brew upgrade pnpm` when Homebrew manages it. There is no project-specific pnpm pin.
- The package-manager version stays explicit so local and CI commands use the same implementation of these security controls. A bot can bump it and regenerate its lockfile; do not use a floating `latest` tool in CI.
- pnpm may use a multi-document lockfile when tool or configuration dependencies are present. Readers must load every document; the project dependency graph is last. This project has no pnpm tool pin.

## Install

Initialize pinned upstream sources from the repository root before installing dependencies:

```sh
node scripts/init-submodules.cjs
pnpm install --frozen-lockfile
```

The shared initializer follows `.gitmodules` checkout policy: required sources include their pinned nested dependencies, primary-only sources omit unused children, and reference-only sources remain uninitialized. `--dry-run` lists the plan without fetching; `-- PATH ...` selects specific top-level sources and `--all` includes references. It never follows moving branches or forces away local changes. See [upstream maintenance](UPSTREAMS.md) for the source inventory and update contract.

The install lifecycle prepares the Electron binary, including after dependency updates. Run `pnpm electron:install` to repair it separately (network may be required). Launch scripts resolve installed files without importing the npm Electron entry point, whose recent versions would download automatically. Unit tests, renderer builds, native launches, and read-only inspection do not need the binary.

## Run the launcher
- `pnpm run dev` (Vite + Electron)
- On macOS, development uses an offline cached **MacLauncher.app** with the app's name and icon. Its matching helpers and ad hoc signature are prepared once per Electron/icon/configuration identity under `~/Library/Caches/maclauncher/development/`; the installed Electron package and standalone game host stay separate. An explicit `MACLAUNCHER_ELECTRON_PATH` retains the supplied executable unchanged.
- `pnpm run dev:debug` (extra logging)
- `pnpm run dev` defaults `MACLAUNCHER_DEVTOOLS=1`. Set `MACLAUNCHER_DEVTOOLS_AUTO=1` to auto-open DevTools in Electron windows.
- Dev and preview use `127.0.0.1:5174` by default. Set `MACLAUNCHER_DEV_HOST` or `MACLAUNCHER_DEV_PORT` to override them. Dev chooses the next available port when the preferred port is occupied, preserving the existing server; Electron receives the actual bound URL.
- Vite explicitly prebundles and deduplicates React, including when dependencies are linked from a local directory.
- Dev owns its Vite server through the JavaScript API. Before opening Electron, it transforms the renderer's import graph and checks the page, Vite client and prepared modules over local HTTP. A dependency or startup error fails before opening an unusable launcher window; startup has a 30-second limit. Closing the launcher closes only that invocation's server.
- Dev caches live under `.local/cache/vite/<installed-layout>/`. The key includes installed React/Vite package versions and actual paths, so replacing or relocating dependencies cannot reuse resolutions from an older tree with the same lockfile. Starting dev never installs or downloads dependencies.

## Run without the launcher
- `pnpm launch --game /path/to/game` detects/imports and launches through `src/core/launcher.js`.
- `--runtime <id>` requires the specified runtime; unsupported or unlaunchable requests fail explicitly.
- `--user-data /path/to/launcher-data` isolates settings, imports, extracted files and saves from the normal library.
- `--wait` keeps the native process attached and returns its exit status. Some module-owned wrapper processes still manage their own output.
- `--inspect` detects and resolves metadata without writing launcher files or invoking import hooks.
- `--action <id> --payload '{"filePaths":["/path/to/input"]}'` invokes an existing module action. Actions can modify game files and may require installed tools; download/patch actions retain their existing explicit-action semantics.
- Native engines use Node directly. Hosted web games use `src/runtime/electron-game.js`, which creates no launcher window or launcher IPC endpoints.
- See [BACKEND.md](BACKEND.md) for the shared service contract.

## Build and preview
- `pnpm run build`
- `pnpm run preview`

## Packaging (macOS)
MacLauncher ships the same codebase in two modes:
- Dev mode (`pnpm run dev`) loads the renderer from Vite (`ELECTRON_START_URL`).
- Packaged mode loads the built renderer from `dist/renderer/index.html` and bundled resources.
- Packaging keeps most module resources inside `app.asar` for faster signing; bundled executable app resources are unpacked. Adding executable resources requires updating `build.asarUnpack` in `package.json`.
- Packaged builds only include the external subpaths listed in `build.extraResources`. If a module needs new `src/external` assets, update that filter.

The `src/resources` copy uses an explicit allowlist: 7zip, RPGMakerDecrypter, `maclauncher.png`, native runtimes and the current Python runtime. Backup Python trees, bytecode/`__pycache__`, local configuration, Git metadata and diagnostics are excluded. App files retain engine code, runtimes and artwork with the same local/cache exclusions. Review actual Builder selections with the [public repository audit](#public-repository-audit).

Build a macOS app bundle:
- `pnpm run package:mac` (outputs to `dist/app/`)
- Add `--arm64`, `--x64`, or `--universal` to target a specific build.
- Signing uses `CSC_LINK` or `CSC_NAME` + `CSC_KEY_PASSWORD` when available.
- If no Developer ID Application identity is found in the keychain and no signing env is set, packaging uses an ad hoc signature. This repairs the bundle's seal after branding and resource assembly; it is not Developer ID signing or notarization. An explicit packaging identity option retains priority.
- Notarization runs when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are set.
- Packaging runs `scripts/after-pack.js` to set document associations and restore sealed native resources. Resource filters select the declared runtime packages, and packaging checks reject duplicate or obsolete layouts. MKXP-Z uses the one versioned binary payload described in [its runtime guide](runtimes/MKXPZ.md).
- The package registers module-declared input formats for Finder **Open With**. Game formats such as `.exe`, `.pck`, `.love`, `.jar` and `.swf` receive preferred handler rank; ordinary HTML/text/configuration formats are alternate choices. **File → Open…** (`Cmd+O`), Finder and drag/drop use the same asynchronous import queue and open the added game's inspector. Finder events received before startup completes are retained; unsupported files do not prevent later imports.

## Shortcuts (.command)
Use the Shortcut button on a game card to generate a `.command` launcher.
- In dev, it runs `node scripts/run-game.mjs --game <path>`.
- In packaged builds, it opens the MacLauncher.app bundle with `--maclauncher-game=<path>`.
- Shortcuts launch with the same runtime selection and settings as the UI play action.

## Logs and debug
- Main log: `userData/logs/main.log`
- MKXP-Z log (per game): `userData/games/<gameId>/logs/rgss-mkxpz.log`
- MKXP-Z launch snapshot: `userData/games/<gameId>/logs/rgss-mkxpz.json`
- `MACLAUNCHER_DEBUG=1` enables extra logging and auto-opens DevTools for Electron windows.
- `MACLAUNCHER_DEVTOOLS=1` enables the DevTools shortcut in supported runtimes.
- `MACLAUNCHER_DEVTOOLS_AUTO=1` auto-opens DevTools for Electron launcher and game windows.
- `MACLAUNCHER_ICON_EXTRACT=0` disables icon extraction/caching.

## Development tips
- Prefer adding features via modules, not hard-coded branches.
- Keep the launcher offline by default and require explicit UI actions for network access.
- Update docs whenever behavior changes.

## Embedded Python runtime
For evbunpack tooling, MacLauncher can bundle a self-contained Python runtime under `src/resources/python/`.
To download and install Python 3.12 with required dependencies:
- `node scripts/setup-python-runtime.mjs`

This script downloads a macOS build from [python-build-standalone](https://github.com/astral-sh/python-build-standalone) and installs
`pefile` + `aplib` + `corrupy` into the embedded environment.
- It also normalizes entrypoint scripts under `src/resources/python/bin/` to run the
  bundled `python3` via a relative path.

## MKXP-Z update candidates

`node scripts/autoupdate-mkxpz.js` fetches the latest available [MKXP-Z](https://github.com/mkxp-z/mkxp-z) Actions build into ignored `.local/runtime-distribution/mkxpz-candidates`. Use `--version <exact-Actions-version>` to select a retained build, `--output <private-directory>` for a separate empty or previously owned output, and `--help` for usage. `node scripts/autoupdate-all.js` currently runs this same candidate workflow.

The updater records the exact Actions run, artifact, source commit, executable hash and complete app-tree hash, then proposes a binary pin. It does not change the included pin or existing payloads. Valid cached candidates are reused offline; selecting the Included version is a no-op. Incomplete transfers can be cleaned by the downloader.

Concurrent transfers of the same candidate are blocked. An interrupted transfer retains `transfers/<version>.json`; confirm its process has exited before removing the record and retrying.

New Actions checks and downloads require optional authenticated GitHub CLI: `brew install gh`, then `gh auth login`. Homebrew installs `gh` in `/opt/homebrew/bin` on Apple Silicon or `/usr/local/bin` on Intel; ensure that directory is on `PATH`. Importing these scripts or requesting help makes no network calls. Verify the candidate's exact identities before changing the pin, then follow [MKXP-Z offline staging](runtimes/MKXPZ.md).

## Verification
- `pnpm typecheck` checks the renderer without emitting files.
- `pnpm test` runs the Node backend and UI contract tests.
- `pnpm check` runs type checking, unit tests, and the renderer build.

ASAR test fixtures wait for the archive output stream to finish before inspecting
or modifying the archive, so integrity checks always read complete bytes.
- Use `pnpm install --frozen-lockfile` for reproducible installs.

Incoming IPC snapshots retain identities for unchanged games, settings and catalogs. A download-progress update can redraw its progress display without sorting the library again or rescanning the selected game's tools. Selection callbacks remain stable, and the inspector receives only its game's state. Inspector read-only requests are cached by game, action and runtime inputs; changing the selected version, settings, detection data or installed runtime invalidates the relevant check. Explicit status refresh bypasses that action's cache. Removed games release their cached requests, and slower responses from older inputs cannot replace newer results.

## Save-file transactions
Existing JSON save writes create a `.maclauncher.bak` backup before replacing the
save through a temporary file and atomic rename. Backup failure aborts the write.
MV/MZ preserve the engine's original encoding conventions:
MZ uses a compressed binary string stored through UTF-8 file I/O, rather than a
raw zlib buffer. Codecs can return buffers for byte-preserving writes.

## Public repository audit

Run the audit before publishing repository or app changes:

```sh
node scripts/audit-public-repo.cjs
node scripts/audit-public-repo.cjs --packaged-root /path/to/app/resources
```

It checks the current public worktree, intended untracked files, differing index blobs and the actual Electron Builder app/resource/file selections, including explicitly selected external assets. Git history and automatically collected production npm dependencies are outside this scan. Builder dependencies must be installed for a complete package-selection check; an incomplete scope is reported explicitly.

Compiler-path checks include the configured temporary directory and its resolved
symlink target, including custom `TMPDIR` locations, without printing matched values.

`--json` prints structured results; `--root` selects a repository; repeatable `--packaged-root` adds built resource trees; `--package-only` limits the scan to app packaging. Findings list categories, files and lines without printing private values. Local reports use restricted permissions; `--no-receipt` skips report output.

`--history` additionally scans reachable local-ref blobs and commit metadata; `--history-only` selects that scope alone. Submodule interiors, unreachable objects and reflogs are excluded. Author and committer credits remain separate from private-path findings. `--help` lists options without scanning or writing files.
