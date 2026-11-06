# macOS app builds

A GitHub Actions workflow, [Build macOS app](../../.github/workflows/macos-app.yml), builds MacLauncher for Apple Silicon and Intel Macs and publishes app releases. Each architecture is a separate app, built on a GitHub runner of the same architecture: `macos-26` for Apple Silicon and `macos-26-intel` for Intel. [Releases](RELEASING.md) describes the version model and what a release contains.

[Verifying MacLauncher](VERIFYING.md) describes archive provenance, included-package verification and local rebuilds.

## Triggers

- Raising the version in `package.json` on the default branch builds and publishes `v<version>`.
- Pushing a matching version tag also builds that release.
- A manual run builds an Actions artifact without publishing anything.

## Included packages

The app's package lock, [`build/runtime-packages.json`](../../build/runtime-packages.json), lists each package that the app includes from MacLauncher Builds, with its exact project, version, architecture, URL, size and SHA-256. Each record also lists the app architectures that include it, so the same lock serves both builds; [Application assembly](../runtimes/RUNTIME_DISTRIBUTION.md#application-assembly) describes what each app contains. For every package version it needs, an app includes the build for its own CPU when one exists, and otherwise the Universal build. The workflow downloads the packages for the architecture it builds and compiles no game runtimes. Updating one runtime changes only its package entry, and unchanged packages are reused across app releases. The workflow needs no repository variables for package URLs, checksums or architectures.

Module declarations name which projects are included and in which package architectures. The release version and identity of each package, however, come only from the app lock, and its file inventory comes from the package declaration inside its archive. An included package is updated by selecting its published version in the lock, running `node scripts/runtime-packages.cjs lock /path/to/catalogs` against the Builds catalogs and then running `pnpm install`. The lock command resolves the selected versions to their published records but does not select newer versions automatically.

The app includes Python, 7-Zip, extraction helpers and the core graphics and internal-helper packages that the [distribution policy](../runtimes/RUNTIME_DISTRIBUTION.md#distribution-policy) selects. Game runtimes, including Flash Player, are not part of the app build; the app downloads them.

## Build

The workflow initializes only the `submodules` selection in [`build/source-dependencies.json`](../../build/source-dependencies.json), installs the locked pnpm dependencies, fetches Electron and the included packages selected for its architecture, builds the renderer and packages the app. It uses each GitHub Action at an exact commit.

The explicit fetch step prepares Electron first and then the publisher and Builds inputs. Each app job installs Python from the matching python-build-standalone release asset in [the embedded Python record](../../src/modules/shared/runtime/embedded-python.json), and the official 7-Zip macOS download supplies a Universal executable. Both downloads are checked against their recorded checksums. Python and the 7-Zip executable are produced during this preparation and are not stored in Git, which holds only their publisher records and license text. The same step also downloads the ASM and apksig JARs from their publishers, checks them against recorded checksums and places them in tool paths that Git ignores. Checkout setup, development startup and local packaging use the same preparation helpers as the workflow.

After archiving, a separate step reports duplicate files, CPU and macOS incompatibilities, signature failures, package metadata differences and unresolved library links as warnings, which do not stop the build.

Stock bundled helpers, NW.js patches and Kawariki scripts come directly from their upstream sources, with MacLauncher's own overlays where required. Custom Android launcher helpers, on the other hand, come from Builds packages.

Each MacLauncher Builds archive in the app must carry a signed build attestation, which shows that the Builds **Runtime build** workflow produced it on a GitHub-hosted runner. Packaging verifies both the checksum and the attestation of each archive, and cached attestation bundles let local packaging verify the same published archives. As a result, a locally compiled replacement cannot be used in an app release.

Repository-wide tests and publication audits run separately from the app build. They use the normal development source initialization, which fetches the app's upstream helpers and the Android test source but none of their nested sources. In a checkout prepared only for packaging, `node scripts/ci-macos.cjs test-sources` adds the declared Android test source without changing the app's source selection or runtime packages. Optional upstream adaptation checks use `node scripts/init-submodules.cjs --all` instead, which fetches nested sources as each declaration in `.gitmodules` specifies.

Source checks reject compiled code and archives committed to Git but accept source artwork. Android test inputs are instead generated from text files into temporary test directories: binary XML comes from an encoder in the test helpers, resource APKs are built with the publisher's aapt2 and Android API archive at exact recorded versions, and D8, also at a recorded version, compiles the interface-default DEX caller fixture. In CI, the test preparation step fetches these public tools.

## Artifacts and publication

Each architecture has its own Actions artifact, which contains the app archive, its checksum, a record of the build and the release notes. The Apple Silicon archive is `MacLauncher.app.zip`, and the Intel archive is `MacLauncher-Intel.app.zip`. Each archive and its `MacLauncher-<arch>.build-manifest.json` share a GitHub build provenance attestation. The manifest records the included package digests, download URLs and verified Builds provenance statements. Both archives and both manifests are public release attachments. Runtime catalogs stay in MacLauncher Builds, release tags identify their source commits and license notices stay inside the app.

Only the publishing job has the `contents: write` permission. The build jobs have `id-token: write` and `attestations: write` to sign provenance. Publication runs only after both architectures build and attest successfully, and it requires both builds to come from the same commit and version with identical release notes. It creates a draft release at the built commit, uploads the apps and manifests, verifies each uploaded size and checksum and then publishes the release. A retry reuses a matching draft, never moves an existing tag and never replaces a published release.

## Signing

By default, the app is signed ad hoc. Developer ID signing and notarization use the credentials described in [signing and notarization](DEVELOPMENT.md#signing-and-notarization).

## System requirements

MacLauncher requires macOS 13 or later on a Mac with Apple Silicon or an Intel processor. The package lock records the highest minimum macOS version among the included native packages, and packaging checks it; the value sets no upper limit on supported macOS versions. Downloaded runtimes check their own CPU and macOS requirements, and Intel programs that MacLauncher starts still go through the Rosetta check on Apple Silicon.

The optional MacLauncher KosmicKrisp package, like the KosmicKrisp Vulkan driver itself, requires macOS 26 or later and is unavailable on older systems ([System requirements](../runtimes/SYSTEM_REQUIREMENTS.md)). A runtime that requires 26.0 also accepts 26.1, 26.2 and later releases.
