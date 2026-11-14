# macOS app builds

MacLauncher's app releases are built and published by a GitHub Actions workflow, [Build macOS app](../../.github/workflows/macos-app.yml). It builds a separate app for Apple Silicon and for Intel Macs, each on a GitHub runner of the same architecture: `macos-26` for Apple Silicon and `macos-26-intel` for Intel. [Releases](RELEASING.md) describes the version model and what a release contains, and [Verifying MacLauncher](VERIFYING.md) describes how to check where an archive came from, verify its included packages and rebuild it locally.

## Triggers

- Raising the version in `package.json` on the default branch builds and publishes `v<version>`.
- Pushing a matching version tag also builds that release.
- A manual run builds an Actions artifact without publishing anything.

## Included packages

Each package that the app includes from MacLauncher Builds is listed in [`build/runtime-packages.json`](../../build/runtime-packages.json), the app's package lock file. A record there gives the package's exact project, version, architecture, URL, size and SHA-256, and also the app architectures that include it, so the same file serves both builds; [Application assembly](../runtimes/RUNTIME_DISTRIBUTION.md#application-assembly) describes what each app contains. When a package version has a build for the app's own CPU, the app includes that build, and otherwise it includes the Universal build. The workflow downloads only the packages for the architecture it is building, and it compiles no game runtimes. As a result, updating one runtime changes only that package's entry, and unchanged packages are reused from one app release to the next. Package URLs, checksums and architectures all come from the lock file, so the workflow needs no repository variables for them.

Module declarations name the projects that are included and their package architectures. The exact release of each package, however, comes only from the lock file, and the list of files in a package comes from the package declaration inside its archive. An included package is updated by selecting its published version in the lock file, running `node scripts/runtime-packages.cjs lock /path/to/catalogs` against the Builds catalogs and then running `pnpm install`. The lock command fills in the published records of the selected versions, but it never moves a package to a newer version on its own.

The app contains Python, 7-Zip, extraction helpers, and the core graphics and internal helper packages that the [distribution policy](../runtimes/RUNTIME_DISTRIBUTION.md#distribution-policy) selects. Game runtimes, Flash Player among them, are not part of the app build, and the app downloads them instead.

## Build

The workflow initializes only the `submodules` selection in [`build/source-dependencies.json`](../../build/source-dependencies.json). It then installs the pnpm dependencies at their locked versions, fetches Electron and the included packages selected for its architecture, builds the renderer and packages the app. Every GitHub Action it uses is referenced by an exact commit.

A separate fetch step prepares Electron first, then the files that come from their original publishers and from MacLauncher Builds. Each app job installs Python from the matching python-build-standalone release asset in [the embedded Python record](../../src/modules/shared/runtime/embedded-python.json) and takes a Universal executable from the official 7-Zip macOS download, and both downloads are checked against their recorded checksums. Neither is stored in Git, which holds only the record of where each one is published and its license text; Python and the 7-Zip executable are produced during this preparation. The same step downloads the ASM and apksig JARs from their publishers as well, checks them against recorded checksums and places them in tool paths that Git ignores. Checkout setup, development startup and local packaging all use the same preparation helpers as the workflow.

After archiving, a separate step reports duplicate files, CPU and macOS incompatibilities, signature failures, package metadata differences and unresolved library links. These are warnings and do not stop the build.

Stock bundled helpers, NW.js patches and Kawariki scripts come directly from their upstream sources, with MacLauncher's own additions layered over them where required. Custom Android launcher helpers, on the other hand, come from Builds packages.

Each MacLauncher Builds archive in the app must carry a signed build attestation, GitHub's record showing that the Builds **Runtime build** workflow produced it on a GitHub-hosted runner. Packaging verifies both the checksum and the attestation of each archive, and cached attestation bundles let local packaging verify the same published archives. As a result, a locally compiled replacement cannot be used in an app release.

Repository-wide tests and publication audits run separately from the app build. They use the normal development source initialization, which fetches the app's upstream helpers and the Android test source but none of their nested sources. In a checkout prepared only for packaging, `node scripts/ci-macos.cjs test-sources` adds the declared Android test source without changing the app's source selection or runtime packages. Optional checks of MacLauncher's upstream adaptations use `node scripts/init-submodules.cjs --all` instead, which fetches nested sources as each declaration in `.gitmodules` specifies.

Source checks reject compiled code and archives committed to Git but accept source artwork. Android test inputs, by contrast, are generated from text files into temporary test directories: binary XML comes from an encoder in the test helpers, resource APKs are built with the publisher's aapt2 and Android API archive at exact recorded versions, and D8, also at a recorded version, compiles the interface-default DEX caller fixture. In CI, the test preparation step fetches these public tools.

## Artifacts and publication

Each architecture has its own Actions artifact, which contains the app archive, its checksum, a record of the build and the release notes. The Apple Silicon archive is `MacLauncher.app.zip`, and the Intel archive is `MacLauncher-Intel.app.zip`. Each archive and its `MacLauncher-<arch>.build-manifest.json` share one signed GitHub build provenance attestation. The manifest records the digest and download URL of every included package, together with the verified attestation statements from MacLauncher Builds that show where each package was built. Both archives and both manifests are public release attachments. Runtime catalogs are not attached and remain in MacLauncher Builds; release tags identify their source commits, and license notices stay inside the app.

Only the publishing job has the `contents: write` permission, while the build jobs have `id-token: write` and `attestations: write` so that they can sign their attestations. Publication runs only after both architectures have built and been attested successfully, and both builds must come from the same commit and version with identical release notes. The publishing job creates a draft release at the built commit, uploads the apps and manifests, verifies each uploaded size and checksum and then publishes the release. A retry reuses a matching draft. It never moves an existing tag and never replaces a published release.

## Signing

By default, the app is signed ad hoc. Developer ID signing and notarization use the credentials described in [signing and notarization](DEVELOPMENT.md#signing-and-notarization).

## System requirements

MacLauncher requires macOS 13 or later on a Mac with Apple Silicon or an Intel processor. The lock file records the highest minimum macOS version among the included native packages, and packaging checks it; this value sets no upper limit on supported macOS versions. Downloaded runtimes check their own CPU and macOS requirements, and on Apple Silicon, Intel programs that MacLauncher starts still go through the Rosetta check.

The optional MacLauncher KosmicKrisp package, like the KosmicKrisp Vulkan driver itself, requires macOS 26 or later and is unavailable on older systems ([System requirements](../runtimes/SYSTEM_REQUIREMENTS.md)). A runtime that requires 26.0 also accepts 26.1, 26.2 and later releases.
