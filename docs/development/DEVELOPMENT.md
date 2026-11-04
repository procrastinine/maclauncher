# Development guide

This guide covers working from a source checkout: requirements, installation, the dependency policy, running the launcher, checks, packaging and the helpers that ship inside the app. The [repository guide](REPO_GUIDE.md) describes the code layout, and [backend and command line](BACKEND.md) describes running games without the launcher.

## Requirements

- Node.js 22.19 or a later 22.x release, Node.js 24 or Node.js 26
- a current [pnpm](https://pnpm.io/installation)
- macOS 13 Ventura or later, which Electron 45 requires

## Install

```sh
node scripts/init-submodules.cjs
pnpm install --frozen-lockfile
```

The first command initializes the upstream source checkouts. The second installs the locked dependencies, Electron and the included native inputs for the Node process's CPU. Included MacLauncher Builds packages come from the exact releases in `build/runtime-packages.json`; archive bytes, checksums and sealed contents are verified before installation under `src/resources/native-runtimes/`. Setup prepares Python, 7-Zip and the declared ASM and apksig JARs from their pinned publisher records. Git ignores these downloaded files and stores only the text records and licenses. This installation requires network access to the public publishers and does not require GitHub credentials. Managed game runtimes are acquired separately after consent in the launcher.

`init-submodules.cjs` initializes the app and test sources listed in `build/source-dependencies.json`: the bundled upstream helpers and the pinned Android producer used by framework tests. Ordinary setup fetches only those top-level checkouts; nested sources require an explicit `recursiveSubmodules` entry within that same selection. `--dry-run` lists the plan without fetching. `--all` selects the enabled maintainer sources in `.gitmodules`, with their declared recursive or primary-only policy. `-- PATH ...` selects individual declared sources, including references, with that same recursion policy. Every checkout uses its recorded Gitlink commit. The script never follows moving branches, removes existing checkouts or discards local changes. [Upstreams](../runtimes/UPSTREAMS.md#upstream-commits-and-updates) describes the source inventory and how sources are updated.

During CI installation, postinstall leaves preparation to the workflow's explicit configure and fetch steps. Fetch prepares Electron, the selected Python profile, publisher inputs and included packages for that runner's CPU. An explicit `pnpm setup:dev` remains available for development setup.

Every `pnpm install` repeats this preparation, including one with nothing new to install, so the update commands also prepare an included-package lock that changed without a dependency change. Prepared inputs that already match are verified and kept, without downloading again. After a complete preparation, earlier downloaded versions of the included packages that no `build/runtime-packages.json` record for either CPU uses are removed, together with their archives. Locally staged copies of an included package, named by their content hashes, are also removed once neither CPU's package selection uses them, unless a running process or a lease in the package's `.generation-leases` folder holds them. Other local builds and unrecognized files stay. `pnpm setup:dev` runs the same preparation directly and repairs missing inputs. `pnpm setup:dev --arch x64` prepares the Intel package selection and Python profile on a Mac with Intel execution support; `--arch arm64` selects Apple Silicon. Non-macOS dependency installation prepares Electron and leaves the Mac-only inputs alone. `pnpm electron:install` repairs only the Electron installation and can download its binary. Launch scripts find the installed files without importing Electron's npm entry point, whose recent versions would download the binary automatically. Unit tests, renderer builds, native launches and read-only inspection do not need the Electron binary. Starting dev uses the same preparation helpers to replace missing publisher files and the generated CP932 table, but it does not install npm dependencies or included MacLauncher Builds packages. When the installed included packages differ from the lock for this CPU, dev prints a one-line reminder to run `pnpm install` and starts normally.

## Dependency policy

The project uses the installed pnpm and never selects or downloads another version of it. Installation settings live in `pnpm-workspace.yaml`; pnpm 11 and later read `.npmrc` only for registry and authentication settings. The hoisted linker supports Electron packaging, and global virtual-store links are turned off so that installed dependencies stay inside the checkout.

The workspace sets these controls:

| Setting | Effect |
| --- | --- |
| `minimumReleaseAge: 10080` | Direct and transitive npm releases become eligible after seven days, except the exact security-fix versions listed in the workspace policy. Strict mode rejects a range with no eligible release, and a release without a publication date is ineligible. |
| `trustLockfile: false` | Existing lockfile entries are checked again, including during frozen installs, so a lockfile created under a weaker policy cannot bypass the checks. |
| `trustPolicy: no-downgrade` | Rejects a package whose publisher trust evidence is weaker than before. |
| `blockExoticSubdeps: true` | Rejects unexpected Git and URL dependencies that other packages introduce. |
| `strictDepBuilds: true` | Fails on dependency lifecycle scripts that have not been reviewed. `allowBuilds` explicitly denies the Windows-only `electron-winstaller` script. |
| `optimisticRepeatInstall: false` | Runs the full installation check and the project's postinstall preparation on every install, even when the lockfile and manifests are unchanged. |
| `verifyDepsBeforeRun: error` | Checks that the installed dependencies match the project before scripts run, and fails when an install is needed. Launching never installs dependencies. |

Dependencies use compatible `^` ranges, which allow routine updates, and the committed lockfile records the exact resolutions so that every update can be reviewed. A package released within the last seven days stays at its newest eligible version. pnpm documents these controls in its [resolution settings](https://pnpm.io/settings/dependency-resolution) and [build settings](https://pnpm.io/settings/build).

The workspace also overrides some transitive dependencies:

- The packaging graph moves the legacy `tiny-async-pool@1` and `@electron/get@3` consumers to a compatible `semver` 7.8.5, which keeps trusted-publisher metadata.
- Scoped overrides keep Steam's app-ticket Protobuf reader and CDN ZIP reader on maintained packages with their existing formats. HTTP clients keep their Undici major versions with security fixes, and packaging uses the corrected URI parser.
- The proxy support in `@electron/get@3` uses `global-agent` 4.1.3 or a compatible newer release. Its `bootstrap()` API is unchanged, and [version 4.1 removed the old logger](https://github.com/gajus/global-agent/releases/tag/v4.1.0) that depended on the vulnerable `sprintf-js`. Downloader tests cover HTTP and HTTPS proxies, `NO_PROXY` bypasses, certificate verification and checksum rejection. The normal release-age, publisher-trust and audit policies still apply.

### Updating dependencies

`pnpm deps:update` runs `pnpm update --latest`, including new major versions, prepares the updated Electron installation and included inputs with `pnpm setup:dev`, and then runs `pnpm check` and the high-severity audit. The same release-age, trust and script controls apply, and the manifest and lockfile record the resolved dependencies.

pnpm itself updates separately, with `pnpm self-update` or, for a Homebrew installation, `brew upgrade pnpm`. The project does not pin a pnpm version, and the CI workflow records the version it installs. pnpm may write a multi-document lockfile when tool or configuration dependencies are present; readers must load every document, and the project dependency graph is the last one.

## Run the launcher

`pnpm run dev` starts Vite and Electron, and `pnpm run dev:debug` adds extra logging.

- `pnpm run dev -- --background` passes the launcher option `--background`. The first Library window then opens without activating the app or opening DevTools. Reopening the Library explicitly and utility-window actions keep normal focus.
- The launcher option `--user-data=/absolute/directory` selects a separate library, Chromium session storage and log directory.

### Development app bundle

On macOS, development runs from a locally prepared, cached MacLauncher.app with the app's name and icon. Its matching helpers and signature are prepared at the fixed path `~/Library/Caches/maclauncher/development/stable/MacLauncher.app`. Preparation signs it with a local signing identity named MacLauncher Development when one is configured, and with an ad hoc signature otherwise. The outer app has an explicit designated requirement, bound to the certificate when present. The installed Electron package and the standalone game host stay separate. An explicit `MACLAUNCHER_ELECTRON_PATH` uses the supplied executable unchanged.

A change to the Electron version, icon, signing identity or configuration rebuilds the bundle in a staging directory, which then atomically replaces the stable directory. While running processes or generation leases still hold the current bundle, the replacement waits for a later launch. Earlier bundles, in directories named by digest, stay intact, and abandoned staging directories are removed. Source launches leave Electron's application entry point out of the document arguments, including when the development bundle uses the MacLauncher app identity. Launcher initialization waits on Electron's readiness promise, including when asynchronous module loading finishes after the ready event.

### Development server

Dev and preview use `127.0.0.1:5174` by default, and `MACLAUNCHER_DEV_HOST` and `MACLAUNCHER_DEV_PORT` override the host and port. When the preferred port is taken, dev picks the next free port and leaves the existing server running, and Electron receives the address that was actually bound.

Dev runs its own Vite server through the JavaScript API. Before opening Electron, it transforms the renderer's import graph and checks the page, the Vite client and the prepared modules over local HTTP. A dependency or startup error stops dev before it opens an unusable launcher window, and startup has a 30-second limit. Closing the launcher closes only the server that this invocation started.

Vite explicitly prebundles and deduplicates React, including when dependencies are linked from a local directory. Its development cache key includes the installed React and Vite package versions and their actual paths, so a replaced or moved dependency tree cannot reuse resolutions from an older tree with the same lockfile. Each start keeps the current Vite cache and the two most recently modified others under `~/Library/Caches/maclauncher/vite/` and removes the rest. Starting dev never installs or downloads dependencies.

Development loads the checkout directly. The shared content rules in `scripts/runtime-content.cjs` reject imports of tests, fixtures and generated output in both Node and Vite, refuse to serve those renderer files directly and check the copied public assets. A development-only Electron entry loads the import guard before the launcher; the Vite process loads the same guard. Node worker options preload it in backend workers. Electron, games and helpers receive the existing `NODE_OPTIONS` unchanged; MacLauncher adds no Node preload option to their environment.

### Logs and debugging

| Variable | Effect |
| --- | --- |
| `MACLAUNCHER_DEBUG=1` | Turns on extra logging and opens DevTools automatically in Electron windows |
| `MACLAUNCHER_DEVTOOLS=1` | Enables the DevTools shortcut in supported runtimes. `pnpm run dev` sets it by default. |
| `MACLAUNCHER_DEVTOOLS_AUTO=1` | Opens DevTools automatically in Electron launcher and game windows |
| `MACLAUNCHER_ICON_EXTRACT=0` | Turns off icon extraction and caching |

The launcher writes its main log to `userData/logs/main.log`. MKXP-Z writes a log for each game to `userData/games/<gameId>/logs/rgss-mkxpz.log` and a launch snapshot to `userData/games/<gameId>/logs/rgss-mkxpz.json`. [Graphics diagnostics](BACKEND.md#diagnostics) lists the variables for effect timing and tracing.

## Run games without the launcher

`pnpm launch --game /path/to/game` detects, imports and launches a game through the shared backend, without opening the launcher. Its options can require a runtime, use a separate data directory, wait for the game to exit, inspect the game without changes or run a module action. [Backend and command line](BACKEND.md#command-line) describes every option.

## Checks

- `pnpm typecheck` checks the renderer types without emitting files.
- `pnpm test` runs the Node backend and UI contract tests.
- `pnpm check` runs type checking, the unit tests and the renderer build.

The normal source initialization above includes the pinned Android source used by native and framework tests. A checkout prepared only for app packaging can run `node scripts/ci-macos.cjs test-sources` before repository-wide tests or source audits. This initializes the packaging sources and the additional test sources declared in `build/source-dependencies.json`, at their existing Gitlink commits and without fetching nested upstream trees. Android test inputs remain separate from the included Builds runtime packages. Checks of optional upstream adaptations use the broader maintainer checkout from `node scripts/init-submodules.cjs --all`. Tests that read those sources, such as the Steam API overlay and AIM tests, are skipped when the sources are absent, and the AI5 disc stream, VNDS and engine package tests are skipped without a `maclauncher-builds` checkout beside this repository.

`node scripts/generate-system-requirements.mjs` updates the marked tables in [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md) from the shared capability declarations and sealed included graphics package records prepared by setup. `--check` reports drift without writing files. `--resources /path/to/Resources` also verifies the selected package's manifest, binary checksums, processor slices and macOS minima. Generation needs the declared packages for both launcher architectures and does not need an installed app.

The [backend reference](BACKEND.md), [UI code map](UI_STYLES.md), [data model](DATA_MODEL.md) and [save transactions](../tools/SAVE_SNAPSHOTS.md) describe the contracts that the tests cover.

## Packaging

`pnpm run build` builds the renderer, and `pnpm run preview` previews the build. The same codebase runs in two modes:

- Development mode (`pnpm run dev`) loads the renderer from Vite, through `ELECTRON_START_URL`.
- Packaged mode loads the built renderer from `dist/renderer/index.html` together with the bundled resources.

### Building the app

`pnpm run package:mac` builds the app into `dist/app/`. MacLauncher ships separate apps for Apple Silicon and Intel Macs, so each run builds one architecture: `--arm64` or `--x64` selects it, and without either option the app matches the Mac that builds it. Universal builds are rejected.

Packaging runs `scripts/after-pack.js`, which sets the document associations and restores the verified core graphics and internal-helper resources. Downloadable game runtimes install separately, as the [distribution policy](../runtimes/RUNTIME_DISTRIBUTION.md#distribution-policy) describes.

### App contents

Most module resources stay inside `app.asar`, which makes signing faster, and bundled executable app resources are unpacked. A new executable resource needs an entry in `build.asarUnpack` in `package.json`. Packaged builds include only the external subpaths listed in `build.extraResources`, which also declares module-owned external resources.

The runtime-content rules filter the application files and every resource mapping. Production helpers are kept according to their actual runtime use. Native test executables require an explicit CMake configuration with `-DBUILD_TESTING=ON`, and ordinary builds use `BUILD_TESTING=OFF`.

Packaging exclusions keep their precedence after electron-builder merges the file mappings. Unused npm documentation and separate TypeScript sources are left out when a package runs its compiled JavaScript entry points, while runtime files and license notices stay. Source maps in npm packages, browser-only bundles and protocol schema sources that the Node.js entry points never load are left out too. An upstream resource that exists in several layouts ships once, from the layout its consumer reads first, and without its editor type declarations. Source-tree records that no application code reads, such as the Android package records kept in the repository, stay out of the app. The same applies to native build inputs that MacLauncher Builds compiles from the source tree, such as build recipes, native sources, patches, generated shader headers and the Godot graphics scripts: the app reads their built copies from the packages that contain them. Bundler's gem-generation templates, including the templates for generated test files, are production resources. GemRB's optional test and demo scripts are left out by the [MacLauncher Builds packaging rules](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gemrb/runtime/payload-content.js).

The copy of `src/resources` uses an explicit allowlist: artwork, the prepared upstream Python and 7-Zip files, and the custom core graphics and internal-helper files that MacLauncher Builds package records and [`build/runtime-packages.json`](../../build/runtime-packages.json) select. evbunpack comes directly from its upstream source submodule. Backup trees, local configuration, Git metadata, diagnostics and Python bytecode are excluded. The app contains module integration code and artwork, while downloadable game engines and versioned tools install separately.

The build recipes, patches and exact upstream sources of these packages are in the source tree of each MacLauncher Builds tag. Runtime release packages contain the binaries, the required data and notices and the metadata they consume directly, without source archives.

### Signing and notarization

- Signing uses `CSC_LINK`, or `CSC_NAME` together with `CSC_KEY_PASSWORD`, when they are set.
- When the keychain has no Developer ID Application identity and no signing variables are set, packaging signs the app ad hoc. The ad hoc signature repairs the bundle's code signature after branding and resource assembly; it is neither Developer ID signing nor notarization. An explicit packaging identity option takes priority.
- Notarization runs when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set.

### File associations

The packaged app registers the input formats that modules declare for Finder's **Open With** menu. Game formats such as `.exe`, `.pck`, `.love`, `.jar` and `.swf` are registered with the preferred handler rank, and ordinary HTML, text and configuration formats as alternate choices. **File → Open…** (Cmd-O), Finder and drag and drop use the same asynchronous import queue and open the inspector of the added game. Finder events that arrive before startup finishes are kept, and an input that matches no module does not block later imports. Import errors name the selected file and the reason it could not be added.

## Included helpers

Small integration helpers ship inside the app with fixed versions. Their sources and build recipes are in this repository, while [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) builds the downloadable game runtimes and tools. Rebuilding a helper requires Node.js and Apple's Command Line Tools (`xcode-select --install`), which install under `/Library/Developer/CommandLineTools`. Each builder writes to a new, empty output directory, sets its deployment targets explicitly, signs native output ad hoc and records source and binary checksums. A changed helper gets a new version and a new recorded content checksum.

| Helper | Builder |
| --- | --- |
| Offline Steam API library | `node src/modules/shared/runtime/steamworks/native/offline-0.5.0/build.cjs /absolute/new-output` |
| Steam encrypted-ticket loader | `node src/modules/shared/runtime/steamworks/native/ticket-0.1.0/build.cjs /absolute/new-output` |
| Java steamworks4j bridges | `node src/modules/java/runtime/steamworks/stage-bridge.cjs <publisher-archives> <jdk-bin> <empty-resource-directory>`, with the publisher archives from the catalog and the `bin` directory of a JDK 17 |
| LÖVE LuaSteam bridge | [`luasteam-build.js`](../../src/modules/love/runtime/luasteam-build.js) with the inputs listed in [LÖVE](../game-types/LOVE.md#bridge-source); [`luasteam-package.js`](../../src/modules/love/runtime/luasteam-package.js) stages the packaged bridge profile |
| MKXP-Z configuration helper | `node scripts/stage-mkxpz-config-helper.cjs --output /path/to/empty-staging` |
| CatSystem2 KIF cipher | `node src/modules/catsystem2/runtime/stage-crypto.cjs <empty-resource-directory>` |
| iOS PlayTools storage adapter | `node scripts/stage-ios-helper.mjs` |
| Android account control | [Android launcher recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/android-launcher/build.mjs) in MacLauncher Builds, shipped in an attested included package |

## Generated test inputs

Android manifest fixtures are stored as JSON trees, which the binary XML writer in the test helpers encodes into temporary test directories. The publisher's aapt2 links resource APK fixtures from their XML resources against the Android API archive, and the publisher's D8 compiles the interface-default DEX caller fixture from its Java sources. The exact public tool URLs and SHA-256 values are in `tests/fixtures/android-tools.json`. `pnpm test` prepares these tools first. CI fetches them, and an offline local run reports the tests whose tools are absent as skipped. Git ignores the tools and the generated files, and source checks reject compiled code and archives committed to Git while accepting artwork.

## Publisher payloads

Git does not store executables or archives from publishers. Setup, development startup, local packaging and the app workflow share one set of preparation helpers, which check each publisher download against its pinned checksum. Git keeps the records that describe these downloads: `embedded-python.json`, `src/resources/7zip/source.json`, Android's `asm-binary.json` and `apksig-binary.json`, and `tools/apksig/binary.json`. The last three place their JARs in their declared local tool directories. License and notice text stays in the source tree. Local packaging prepares the Python profile for its selected app CPU before checking the payload.

## Embedded Python runtime

MacLauncher packages a self-contained Python runtime for evbunpack and other internal tools, prepared in `src/resources/python/`, which Git ignores. `node scripts/setup-python-runtime.mjs` downloads Python 3.12.15.

The script downloads the exact build from [python-build-standalone](https://github.com/astral-sh/python-build-standalone) that [the embedded Python record](../../src/modules/shared/runtime/embedded-python.json) names for the current Mac's architecture, and verifies the SHA-256 of the publisher's archive. `--arch x64` installs the Intel build for packaging the Intel app, which also works on Apple Silicon through Rosetta, and `--arch arm64` installs the Apple Silicon build, which needs an Apple Silicon Mac. It installs the exact hashed `pefile`, `aplib`, `corrupy` and `packaging` wheels without resolving other packages, and keeps the Python 3.12 ABI and the standard library's native modules. It also rewrites the entry-point scripts under `src/resources/python/bin/` to run the bundled `python3` through a relative path.
