# Development guide

This document covers local development, debugging, and useful scripts.

## Requirements
- Node.js 22.12+, 24, or 26 + current pnpm
- macOS 13 Ventura or later (required by Electron 44)

The project uses current [pnpm](https://pnpm.io/installation). Installation settings live in `pnpm-workspace.yaml`; pnpm 11+ reads `.npmrc` only for registry/auth configuration. The hoisted linker supports Electron packaging, with global virtual-store links disabled so installed dependencies remain within the checkout. The project uses the installed pnpm without selecting or downloading another tool version. Dependency installation and Electron acquisition are explicit commands.

## Dependency policy

- `minimumReleaseAge: 10080` holds direct and transitive npm releases for seven days, except the exact security-fix versions listed in the workspace policy. Strict mode rejects a range with no eligible release; missing publication dates fail closed.
- `trustLockfile: false` rechecks existing lockfile entries, including frozen installs. A lockfile created under a weaker policy cannot bypass these checks.
- `trustPolicy: no-downgrade` rejects reductions in publisher trust evidence. `blockExoticSubdeps: true` rejects unexpected git/URL dependencies introduced transitively.
- Compatible `^` dependency ranges allow routine updates; the committed lockfile records exact resolutions and makes updates reviewable. Packages released within the last seven days stay at their newest eligible version.
- `strictDepBuilds: true` fails on unreviewed dependency lifecycle scripts. `allowBuilds` explicitly denies the Windows-only `electron-winstaller` script. The project's install lifecycle prepares Electron after an explicit install or update.
- `verifyDepsBeforeRun: error` checks that installed dependencies match the project before scripts run, and fails when an explicit install is needed. Launching does not install dependencies.

The packaging graph overrides the legacy `tiny-async-pool@1` and `@electron/get@3` consumers to compatible `semver` 7.8.5, retaining trusted-publisher metadata.

Scoped overrides keep Steam's app-ticket Protobuf and CDN ZIP readers on maintained packages while preserving their existing formats. HTTP clients retain their Undici major versions with security fixes, and packaging uses the corrected URI parser.

The `@electron/get@3` proxy dependency uses `global-agent` 4.1.3 or a compatible
newer release. Its existing `bootstrap()` API remains compatible, and
[version 4.1 removed the old logger](https://github.com/gajus/global-agent/releases/tag/v4.1.0)
that depended on vulnerable `sprintf-js`. Downloader tests cover HTTP and HTTPS
proxies, `NO_PROXY` bypasses, certificate verification and checksum rejection.
The normal release-age, publisher-trust and audit policies still apply.

The package-manager controls are documented in [pnpm resolution settings](https://pnpm.io/settings/dependency-resolution) and [build settings](https://pnpm.io/settings/build).

## Updating dependencies

- `pnpm deps:update` runs `pnpm update --latest`, including new major versions, then runs `check` and the high-severity audit. The same release-age, trust, and script controls apply. The manifest and lockfile retain the resulting dependency identities.
- pnpm updates independently through `pnpm self-update`, or `brew upgrade pnpm` for a Homebrew installation. There is no project-specific pnpm pin.
- The package-manager version stays explicit so local and CI commands use the same implementation of these security controls. CI records the selected tool version explicitly.
- pnpm may use a multi-document lockfile when tool or configuration dependencies are present. Readers must load every document; the project dependency graph is last. This project has no pnpm tool pin.

## Install

Source initialization and locked dependency installation use:

```sh
node scripts/init-submodules.cjs
pnpm install --frozen-lockfile
```

The shared initializer follows `.gitmodules` checkout policy: required sources include their pinned nested dependencies, primary-only sources omit unused children, and reference-only sources remain uninitialized. `--dry-run` lists the plan without fetching; `-- PATH ...` selects specific top-level sources and `--all` includes references. It never follows moving branches or forces away local changes. [upstream maintenance](UPSTREAMS.md) describes the source inventory and update contract.

The install lifecycle prepares the Electron binary, including after dependency updates. `pnpm electron:install` repairs the Electron installation separately and can download its binary. Launch scripts resolve installed files without importing the npm Electron entry point, whose recent versions would download automatically. Unit tests, renderer builds, native launches, and read-only inspection do not need the binary.

## Run the launcher
- `pnpm run dev` (Vite + Electron)
- The launcher option `--user-data=/absolute/directory` selects a separate library, Chromium session storage and log directory.
- On macOS, development uses an offline cached **MacLauncher.app** with the app's name and icon. Its matching helpers and ad hoc signature are prepared once per Electron/icon/configuration identity under `~/Library/Caches/maclauncher/development/`; the installed Electron package and standalone game host stay separate. An explicit `MACLAUNCHER_ELECTRON_PATH` retains the supplied executable unchanged.
- Development app caches retain the current bundle, one previous bundle and bundles referenced by running processes. Preparing another bundle removes unused older generations and abandoned staging directories.
- Launcher initialization uses Electron's readiness promise, including when asynchronous module loading completes after the ready event.
- `pnpm run dev:debug` (extra logging)
- `pnpm run dev` defaults `MACLAUNCHER_DEVTOOLS=1`. `MACLAUNCHER_DEVTOOLS_AUTO=1` opens DevTools automatically in Electron windows.
- Dev and preview use `127.0.0.1:5174` by default. `MACLAUNCHER_DEV_HOST` and `MACLAUNCHER_DEV_PORT` override the host and port. Dev chooses the next available port when the preferred port is occupied, preserving the existing server; Electron receives the actual bound URL.
- Vite explicitly prebundles and deduplicates React, including when dependencies are linked from a local directory.
- Dev owns its Vite server through the JavaScript API. Before opening Electron, it transforms the renderer's import graph and checks the page, Vite client and prepared modules over local HTTP. A dependency or startup error fails before opening an unusable launcher window; startup has a 30-second limit. Closing the launcher closes only that invocation's server.
- Vite's development cache key includes installed React/Vite package versions and actual paths, so replacing or relocating dependencies cannot reuse resolutions from an older tree with the same lockfile. Starting dev never installs or downloads dependencies.
- Development loads the checkout directly. A shared content boundary rejects test/fixture and generated-output imports in both Node and Vite, rejects direct serving of those renderer files, and checks copied public assets. The development-only Node option is removed before game or helper processes inherit their environment; existing `NODE_OPTIONS` are preserved.

## Run without the launcher
- `pnpm launch --game /path/to/game` detects/imports and launches through `src/core/launcher.js`.
- `--runtime <id>` requires the specified runtime; the runtime reports its input and installation requirements explicitly.
- `--user-data /path/to/launcher-data` isolates settings, imports, extracted files and saves from the normal library.
- `--wait` keeps the native process attached and returns its exit status. Some module-owned wrapper processes still manage their own output.
- `--inspect` detects and resolves metadata without writing launcher files or invoking import hooks.
- `--action <id> --payload '{"filePaths":["/path/to/input"]}'` invokes an existing module action. Actions can modify game files and may require installed tools; download/patch actions retain their existing explicit-action semantics.
- Native engines use Node directly. Hosted web games use `src/runtime/electron-game.js`, which creates no launcher window or launcher IPC endpoints.
- [Backend and CLI](BACKEND.md) defines the shared service contract.

## Build and preview
- `pnpm run build`
- `pnpm run preview`

## Packaging (macOS)
MacLauncher ships the same codebase in two modes:
- Dev mode (`pnpm run dev`) loads the renderer from Vite (`ELECTRON_START_URL`).
- Packaged mode loads the built renderer from `dist/renderer/index.html` and bundled resources.
- Packaging keeps most module resources inside `app.asar` for faster signing; bundled executable app resources are unpacked. Adding executable resources requires updating `build.asarUnpack` in `package.json`.
- Packaged builds only include the external subpaths listed in `build.extraResources`. Module-owned external resources are declared in that filter.
- The same runtime-content rules filter application files and every resource mapping. The assembled app and ASAR reject undeclared upstream resources and test/build outputs, including entries inside nested archives. Production helpers remain selected by actual runtime use. Native test executables require explicit CMake configuration with `-DBUILD_TESTING=ON`; ordinary builds use `BUILD_TESTING=OFF`. Corresponding production recipes, patches and pinned sources are available in the Builds tag's source tree. Runtime release packages contain binaries, required data/notices and directly consumed metadata, without source archives.
- Packaging exclusions retain precedence after Builder merges file mappings. Final ASAR and unpacked files are checked against those delivery filters, including managed runtime payloads. Unused npm documentation and separate TypeScript sources are omitted when packages run their compiled JavaScript entry points; runtime files and license notices remain included.
- Bundler's gem-generation templates are production resources, including templates for generated test files. GemRB's optional test/demo scripts are omitted from new runtime publications. `node scripts/project-gemrb-runtime.cjs INPUT OUTPUT [NEW_VERSION]` creates a separate payload from a sealed GemRB input, updates the copied bundle's resource signature and manifest, and verifies unchanged executable instructions and native dependencies. The original payload remains unchanged; no binary compilation is involved.

The `src/resources` copy uses an explicit allowlist: 7zip, RPGMakerDecrypter, `maclauncher.png`, the core graphics/internal-helper closure and the current Python runtime. Backup Python trees, bytecode/`__pycache__`, local configuration, Git metadata and diagnostics are excluded. App files retain module integration code and artwork; managed game engines and versioned tools install separately. Package checks inspect the actual Builder selections.

App bundle commands and options:
- `pnpm run package:mac` (outputs to `dist/app/`)
- `--arm64`, `--x64` and `--universal` select the build architecture.
- Signing uses `CSC_LINK` or `CSC_NAME` + `CSC_KEY_PASSWORD` when available.
- If no Developer ID Application identity is found in the keychain and no signing env is set, packaging uses an ad hoc signature. This repairs the bundle's seal after branding and resource assembly; it is not Developer ID signing or notarization. An explicit packaging identity option retains priority.
- Notarization runs when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are set.
- Packaging runs `scripts/after-pack.js` to set document associations and restore the sealed core graphics/internal-helper resources. Packaging checks reject duplicate or obsolete layouts. Managed game runtimes install separately, as described in [the runtime guides](runtimes/README.md).
- The package registers module-declared input formats for Finder **Open With**. Game formats such as `.exe`, `.pck`, `.love`, `.jar` and `.swf` receive preferred handler rank; ordinary HTML/text/configuration formats are alternate choices. **File → Open…** (`Cmd+O`), Finder and drag/drop use the same asynchronous import queue and open the added game's inspector. Finder events received before startup completes are retained; an unmatched input does not prevent later imports.
- Source launches exclude Electron's application entry point from document arguments, including when the development bundle uses the MacLauncher app identity. Import errors identify the selected file and the reason it could not be added.

## Shortcuts (.command)
The Shortcut action saves an executable `.command` file with a custom name and location.
It runs `src/core/game-cli.js` through the current Electron executable in Node mode,
using source files during development and the included archive in packaged builds.
The library window stays closed. Hosted games open only their game runtime.
Shortcuts retain the library data directory and read the game's current saved runtime,
version, settings and save locations, matching Play without a separate Node installation.

## Logs and debug
- Main log: `userData/logs/main.log`
- MKXP-Z log (per game): `userData/games/<gameId>/logs/rgss-mkxpz.log`
- MKXP-Z launch snapshot: `userData/games/<gameId>/logs/rgss-mkxpz.json`
- `MACLAUNCHER_DEBUG=1` enables extra logging and auto-opens DevTools for Electron windows.
- `MACLAUNCHER_DEVTOOLS=1` enables the DevTools shortcut in supported runtimes.
- `MACLAUNCHER_DEVTOOLS_AUTO=1` auto-opens DevTools for Electron launcher and game windows.
- `MACLAUNCHER_ICON_EXTRACT=0` disables icon extraction/caching.

## Module boundaries

Engine-specific features live in module code. The launcher discovers their
metadata and delegates runtime behavior through the shared backend contract.
Network acquisition starts from explicit download or installation actions.

## Embedded Python runtime
For evbunpack tooling, MacLauncher can bundle a self-contained Python runtime under `src/resources/python/`.
The pinned Python 3.12.15 acquisition command is:
- `node scripts/setup-python-runtime.mjs`

This script downloads the exact Apple Silicon build from [python-build-standalone](https://github.com/astral-sh/python-build-standalone) recorded in [the embedded profile](../src/modules/shared/runtime/embedded-python.json). It verifies the publisher archive SHA-256 and installs exact hashed `pefile`, `aplib`, `corrupy` and `packaging` wheels without resolving additional packages. The Python 3.12 ABI and standard-library native modules are preserved.
- It also normalizes entrypoint scripts under `src/resources/python/bin/` to run the
  bundled `python3` via a relative path.

## MKXP-Z update downloads

`node scripts/autoupdate-mkxpz.js` fetches the latest available [MKXP-Z](https://github.com/mkxp-z/mkxp-z) Actions build into a separate output directory. `--version <exact-Actions-version>` selects a retained build, `--output <output-directory>` selects an empty or previously owned output, and `--help` describes arguments. `node scripts/autoupdate-all.js` runs the same updater.

The updater records the exact Actions run, artifact, source commit, executable hash and complete app-tree hash, then proposes a binary pin. Existing pins and payloads remain unchanged. Valid cached downloads are reused offline, and the downloader can clean incomplete transfers. Ordinary Play uses the selected managed package without requiring authenticated Actions access.

Only one transfer owns a version at a time. An interrupted transfer retains its process identity in `transfers/<version>.json` until that process exits.

Actions queries and downloads require an authenticated GitHub CLI. Homebrew provides `gh` under `/opt/homebrew/bin` on Apple Silicon or `/usr/local/bin` on Intel. Script imports and help make no network calls. [MKXP-Z offline staging](runtimes/MKXPZ.md) consumes the selected artifact identity.

## Verification
- `pnpm typecheck` checks the renderer without emitting files.
- `pnpm test` runs the Node backend and UI contract tests.
- `pnpm check` runs type checking, unit tests, and the renderer build.

- `pnpm install --frozen-lockfile` installs the recorded dependency graph.

Incoming IPC snapshots retain identities for unchanged games, settings and catalogs. A download-progress update can redraw its progress display without sorting the library again or rescanning the selected game's tools. Selection callbacks remain stable, and the inspector receives only its game's state. Inspector read-only requests are cached by game, action and runtime inputs; changing the selected version, settings, detection data or installed runtime invalidates the relevant check. Explicit status refresh bypasses that action's cache. Removed games release their cached requests, and slower responses from older inputs cannot replace newer results.

## Save-file transactions
Existing JSON save writes create a `.maclauncher.bak` backup before replacing the
save through a temporary file and atomic rename. Backup failure aborts the write.
MV/MZ preserve the engine's original encoding conventions:
MZ uses a compressed binary string stored through UTF-8 file I/O, rather than a
raw zlib buffer. Codecs can return buffers for byte-preserving writes.
