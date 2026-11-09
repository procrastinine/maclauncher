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

The first command initializes the upstream source checkouts. The second installs the locked dependencies, Electron and the included native inputs for the Node process's CPU. Included MacLauncher Builds packages come from the exact releases in `build/runtime-packages.json`. Before installing one under `src/resources/native-runtimes/`, setup verifies the archive bytes and checksums and checks the package's contents against the declaration inside it. Setup also prepares Python, 7-Zip and the declared ASM and apksig JARs from their publisher records, which name each exact download and its checksum. Git ignores these downloaded files and stores only the text records and licenses, as [publisher payloads](#publisher-payloads) describes. The installation needs network access to the public publishers but no GitHub credentials. Managed game runtimes, by contrast, are acquired separately after consent in the launcher.

By default, `init-submodules.cjs` initializes the app and test sources listed in `build/source-dependencies.json`: the bundled upstream helpers and the Android source, at its recorded commit, that framework tests use. Ordinary setup fetches only those top-level checkouts, and it fetches a checkout's nested sources only when the same file also lists that checkout under `recursiveSubmodules`. `--dry-run` lists the plan without fetching. The other selections follow the declarations in `.gitmodules`. `--all` selects every declared source that is not marked reference-only, together with its nested sources unless its declaration keeps only the primary checkout. `-- PATH ...` selects individual declared sources, reference-only ones included, and treats their nested sources in the same way. Every checkout uses its recorded Gitlink commit. The script never follows moving branches, removes existing checkouts or discards local changes. [Upstreams](../runtimes/UPSTREAMS.md#upstream-commits-and-updates) describes the source inventory and how sources are updated.

CI handles this preparation differently. During its installation, postinstall leaves preparation to the workflow's explicit configure and fetch steps, and the fetch step prepares Electron, the selected Python profile, publisher inputs and included packages for that runner's CPU. An explicit `pnpm setup:dev` remains available for development setup.

Every `pnpm install` repeats this preparation, even when there is nothing new to install, so the update commands also prepare an included-package lock that changed without a dependency change. Prepared inputs that already match are verified and kept without being downloaded again. After a complete preparation, earlier downloaded versions of the included packages are removed, together with their archives, when no `build/runtime-packages.json` record for either CPU uses them. Locally staged copies of an included package, which are named by their content hashes, are also removed once neither CPU's package selection uses them, unless a running process or a lease in the package's `.generation-leases` folder still holds them. Other local builds and unrecognized files stay.

`pnpm setup:dev` runs the same preparation directly and repairs missing inputs. With `--arch x64`, it prepares the Intel package selection and Python profile on a Mac with Intel execution support, and `--arch arm64` selects Apple Silicon. On other operating systems, dependency installation prepares Electron and leaves the Mac-only inputs alone. `pnpm electron:install` repairs only the Electron installation and can download its binary. Launch scripts find the installed files without importing Electron's npm entry point, whose recent versions would download the binary automatically, and unit tests, renderer builds, native launches and read-only inspection do not need the Electron binary.

Starting dev uses the same preparation helpers to replace missing publisher files and the generated CP932 table, but it installs neither npm dependencies nor included MacLauncher Builds packages. If the installed included packages differ from the lock for this CPU, dev prints a one-line reminder to run `pnpm install` and then starts normally.

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

pnpm itself updates separately, with `pnpm self-update` or, for a Homebrew installation, `brew upgrade pnpm`. The project does not require a particular pnpm version, and the CI workflow records the version it installs. When tool or configuration dependencies are present, pnpm can write a multi-document lockfile; readers must load every document, and the project dependency graph is the last one.

## Run the launcher

`pnpm run dev` starts Vite and Electron, and `pnpm run dev:debug` adds extra logging.

- `pnpm run dev -- --background` passes the launcher option `--background`. The first Library window then opens without activating the app or opening DevTools. Reopening the Library explicitly and utility-window actions keep normal focus.
- The launcher option `--user-data=/absolute/directory` selects a separate library, Chromium session storage and log directory.

### Development app bundle

On macOS, development runs from a locally prepared and cached MacLauncher.app, which has the app's name and icon. This bundle, with its matching helpers and signature, is prepared at the fixed path `~/Library/Caches/maclauncher/development/stable/MacLauncher.app`. When a local signing identity named MacLauncher Development is configured, preparation signs the bundle with it; otherwise, the bundle gets an ad hoc signature. The outer app has an explicit designated requirement, which is bound to the certificate when one is present. The installed Electron package and the standalone game host stay separate, and an explicit `MACLAUNCHER_ELECTRON_PATH` uses the supplied executable unchanged.

The bundle is rebuilt when the Electron version, icon, signing identity or configuration changes. The new bundle is assembled in a staging directory, which then atomically replaces the stable directory; if running processes or generation leases still hold the current bundle, the replacement waits for a later launch. Earlier bundles, in directories named by digest, stay intact, while abandoned staging directories are removed. Source launches leave Electron's application entry point out of the document arguments, including when the development bundle uses the MacLauncher app identity. Launcher initialization waits on Electron's readiness promise, including when asynchronous module loading finishes after the ready event.

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
- `npm run test:setup` prepares the declared source checkouts, publisher JARs, CP932 table, both processor builds of included packages and Android fixture tools. This explicit setup command can access the network; all downloaded inputs use their recorded commits or checksums. Linked app worktrees reuse existing source repositories through detached worktrees when the pinned commits are available locally.
- `pnpm test` runs the Node backend and UI contract tests.
- `pnpm check` runs type checking, the unit tests and the renderer build.

The test runner checks these inputs offline before starting workers. Missing or changed inputs produce one error naming `npm run test:setup`; individual tests do not replace that setup step. Run setup after changes to the declared source or package pins.

The normal source initialization above includes the Android source, at its recorded commit, that native and framework tests use. A checkout prepared only for app packaging can run `node scripts/ci-macos.cjs test-sources` before repository-wide tests or source audits. This initializes the packaging sources and the additional test sources declared in `build/source-dependencies.json`, at their existing Gitlink commits and without fetching nested upstream trees. The Android source in `src/external/maclauncher-android` has its own upstream adaptation tests and records its nested sources by exact commit, and those nested checkouts are initialized within it. These test sources are separate from the included Builds runtime packages. Integration tests for VNDS and engine packages read a `maclauncher-builds` checkout placed beside this repository.

Some tests also need inputs that are separate from both the source checkout and the app's included helpers. The publisher JARs used by the APK signature verifier and the Android classfile tests are prepared by `pnpm install`, and `node tests/helpers/android-fixture-tools.cjs --fetch` prepares the Android SDK and APK fixture tools, which are checked against recorded checksums. Native-runtime integration tests take their runtime from `KLEPTON_NATIVE_RUNTIME` or from an installed package under `MACLAUNCHER_TEST_USER_DATA`.

The tables marked in [System requirements](../runtimes/SYSTEM_REQUIREMENTS.md) are generated by `node scripts/generate-system-requirements.mjs`, from the shared capability declarations and from the package declarations of the included graphics packages that setup prepares. With `--check`, the script reports drift without writing files, and `--resources /path/to/Resources` also verifies the selected package's manifest, binary checksums, processor slices and macOS minima. Generation needs the declared packages for both launcher architectures but no installed app.

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

The runtime-content rules filter the application files and every resource mapping. Production helpers are kept according to their actual runtime use. Git repository metadata files (`.gitmodules`, `.gitattributes` and `.gitignore`) are excluded along with `.git` directories. Packaging also leaves out files that only editors, type checkers, debuggers and readers of the checkout use: TypeScript sources and declarations, JavaScript and CSS source maps, TypeScript, lint, formatter and bundler configuration, README files, benchmark directories of Node packages, and Markdown and reStructuredText documents other than licence and notice documents. Development still serves and imports these files. They are excluded from the application files and from every resource mapping except the native resources, whose included package payloads are sealed by their manifests. Native test executables require an explicit CMake configuration with `-DBUILD_TESTING=ON`, and ordinary builds use `BUILD_TESTING=OFF`.

Packaging exclusions keep their precedence after electron-builder merges the file mappings. When an npm package runs its compiled JavaScript entry points, its unused documentation and separate TypeScript sources are left out, while runtime files and license notices stay. Source maps in npm packages are left out as well, and so are browser-only bundles and protocol schema sources that the Node.js entry points never load. An upstream resource that exists in several layouts ships once, from the layout its consumer reads first and without its editor type declarations.

Files in the source tree that no application code reads also stay out of the app. These include records kept in the repository, such as the Android package records, and the native build inputs that MacLauncher Builds compiles from the source tree, such as build recipes, native sources, patches, generated shader headers and the Godot graphics scripts. For those inputs, the app reads the built copies from the packages that contain them. Bundler's gem-generation templates, however, including the templates for generated test files, are production resources. GemRB's optional test and demo scripts are left out by the [MacLauncher Builds packaging rules](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/gemrb/runtime/payload-content.js).

Packaging copies `src/resources` through an explicit allowlist: artwork, the prepared upstream Python and 7-Zip files, and the custom core graphics and internal-helper files that MacLauncher Builds package records and [`build/runtime-packages.json`](../../build/runtime-packages.json) select. evbunpack comes directly from its upstream source submodule. Backup trees, local configuration, Git metadata, diagnostics and Python bytecode are excluded. The app contains module integration code and artwork, while downloadable game engines and versioned tools install separately.

The build recipes, patches and exact upstream sources of these packages are in the source tree of each MacLauncher Builds tag. Runtime release packages contain the binaries, the required data and notices and the metadata they consume directly, without source archives.

MacLauncher Builds reads the shared modules of this repository at the exact commit its source tree records, rather than keeping copies of them. Its package builds set `MACLAUNCHER_PACKAGE_PRODUCER=1`, which lifts the size, count and output-buffer guards in [`guards.js`](../../src/modules/shared/runtime/guards.js) that these modules apply in the app. Path safety, digests and tool failures are still checked.

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
| Java steamworks4j bridges | [Java Steamworks recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/tools/build-java-steamworks.mjs) in MacLauncher Builds |
| LÖVE LuaSteam bridge | [`luasteam-build.js`](../../src/modules/love/runtime/luasteam-build.js) with the inputs listed in [LÖVE](../game-types/LOVE.md#bridge-source); [`luasteam-package.js`](../../src/modules/love/runtime/luasteam-package.js) stages the packaged bridge profile |
| MKXP-Z configuration helper | [MKXP-Z configuration helper recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/scripts/stage-mkxpz-config-helper.cjs) in MacLauncher Builds |
| CatSystem2 KIF cipher | `node src/modules/catsystem2/runtime/stage-crypto.cjs <empty-resource-directory>` |
| iOS PlayTools storage adapter | `node scripts/stage-ios-helper.mjs` |
| Android account control | [Android launcher recipe](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/android-launcher/build.mjs) in MacLauncher Builds, shipped in an attested included package |

## Generated test inputs

Binary inputs for the Android tests are generated into temporary test directories, and Git ignores both the generated files and the tools that make them. Android manifest fixtures are stored as JSON trees, which the binary XML writer in the test helpers encodes. Resource APK fixtures are linked from their XML resources against the Android API archive by the publisher's aapt2, and the publisher's D8 compiles the interface-default DEX caller fixture from its Java sources. The exact public tool URLs and SHA-256 values are listed in `tests/fixtures/android-tools.json`.

`pnpm test` prepares these tools before it runs the tests. CI fetches them, while an offline local run reports the tests whose tools are absent as skipped. In addition, source checks reject compiled code and archives committed to Git but accept artwork.

## Publisher payloads

Some files that the app and its tests use come directly from their publishers, such as Python, 7-Zip and the ASM and apksig JARs. Git does not store these executables or archives. Instead, it keeps the records that describe each download: `embedded-python.json`, `src/resources/7zip/source.json`, Android's `asm-binary.json` and `apksig-binary.json`, and `tools/apksig/binary.json`. The last three place their JARs in their declared local tool directories. License and notice text also stays in the source tree.

Setup, development startup, local packaging and the app workflow share one set of preparation helpers, which check each publisher download against the checksum in its record. Before local packaging checks the payload, it also prepares the Python profile for its selected app CPU.

## Embedded Python runtime

MacLauncher packages a self-contained Python runtime for evbunpack and other internal tools. The runtime is prepared in `src/resources/python/`, a folder that Git ignores, and its setup script, `node scripts/setup-python-runtime.mjs`, downloads Python 3.12.15.

The script downloads the exact build from [python-build-standalone](https://github.com/astral-sh/python-build-standalone) that [the embedded Python record](../../src/modules/shared/runtime/embedded-python.json) names for the current Mac's architecture, and verifies the SHA-256 of the publisher's archive. `--arch x64` installs the Intel build for packaging the Intel app, which also works on Apple Silicon through Rosetta, and `--arch arm64` installs the Apple Silicon build, which needs an Apple Silicon Mac. It installs the exact hashed `pefile`, `aplib`, `corrupy` and `packaging` wheels without resolving other packages, and keeps the Python 3.12 ABI and the standard library's native modules. It also rewrites the entry-point scripts under `src/resources/python/bin/` to run the bundled `python3` through a relative path.
