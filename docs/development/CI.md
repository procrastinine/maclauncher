# macOS app builds

A GitHub Actions workflow, [Build macOS app](../../.github/workflows/macos-app.yml), builds MacLauncher for Apple Silicon and Intel Macs and publishes app releases. Each architecture is a separate app, built on a GitHub runner of the same architecture: `macos-26` for Apple Silicon and `macos-26-intel` for Intel. [Releases](RELEASING.md) describes the version model and what a release contains.

[Verifying MacLauncher](VERIFYING.md) describes archive provenance, included-package verification and local rebuilds.

## Triggers

- Raising the version in `package.json` on the default branch builds and publishes `v<version>`.
- Pushing a matching version tag also builds that release.
- A manual run builds an Actions artifact without publishing anything.

## Included packages

The app's package lock, [`build/runtime-packages.json`](../../build/runtime-packages.json), lists each package that the app includes from MacLauncher Builds, with its exact project, version, architecture, URL, size and SHA-256. Each record also lists the app architectures that include it, so the same lock serves both builds; [Application assembly](../runtimes/RUNTIME_DISTRIBUTION.md#application-assembly) describes what each app contains. For every package version it needs, an app includes the build for its own CPU when one exists, and otherwise the Universal build. The workflow downloads the packages for the architecture it builds and compiles no game runtimes. Updating one runtime changes only its package entry, and unchanged packages are reused across app releases. The workflow needs no repository variables for package URLs, checksums or architectures.

The app includes Python, 7-Zip, extraction helpers and the core graphics and internal-helper packages that the [distribution policy](../runtimes/RUNTIME_DISTRIBUTION.md#distribution-policy) selects. Game runtimes, including Flash Player, are not part of the app build; the app downloads them.

## Build

The workflow initializes only the `submodules` selection in [`build/source-dependencies.json`](../../build/source-dependencies.json), installs the locked pnpm dependencies, fetches Electron and the included packages selected for its architecture, builds the renderer and packages the app. The explicit fetch step prepares Electron before the publisher and Builds inputs. Each app job installs Python from the matching python-build-standalone release asset in [the embedded Python record](../../src/modules/shared/runtime/embedded-python.json). The official 7-Zip macOS download supplies a Universal executable. Both downloads are checked against their recorded checksums and kept for comparison with the files selected for the app. A final step verifies the assembled app and its ZIP archive. The workflow uses each GitHub Action at an exact commit.

Stock bundled helpers, NW.js patches and Kawariki scripts come directly from their upstream sources, with MacLauncher's own overlays where required. Custom Android launcher helpers come from Builds packages. Packaging ties each selected file, including the renderer's inputs and outputs, to launcher source, an upstream supplier, a locked source dependency or a MacLauncher Builds package record. Repository-wide tests and publication audits run separately from the app build, with the normal development source initialization: the app's upstream helpers and Android test source, without nested producer dependencies. `node scripts/ci-macos.cjs test-sources` adds the declared Android test source to a packaging-only checkout without changing the app's source selection or runtime packages. Optional upstream adaptation checks use `node scripts/init-submodules.cjs --all` and retain the maintainer recursion policy.

Each MacLauncher Builds archive in the app must carry a signed build attestation showing that the Builds **Runtime build** workflow produced it on a GitHub-hosted runner. Packaging verifies each archive's checksum and attestation, compares the native files of Python and 7-Zip with the publishers' archives, and rejects any native file that cannot be traced to one of the sources above. Cached attestation bundles let local packaging verify the same published archives. A locally compiled replacement cannot be used in an app release.

## Artifacts and publication

Each architecture has its own Actions artifact, which contains the app archive, its checksum, a record of the build and the release notes. The Apple Silicon archive is `MacLauncher.app.zip`, and the Intel archive is `MacLauncher-Intel.app.zip`. Each archive and its `MacLauncher-<arch>.build-manifest.json` share a GitHub build provenance attestation. The manifest records the included package digests, download URLs and verified Builds provenance statements. Both archives and both manifests are public release attachments. Runtime catalogs stay in MacLauncher Builds, release tags identify their source commits and license notices stay inside the app.

Only the publishing job has the `contents: write` permission. The build jobs have `id-token: write` and `attestations: write` to sign provenance. Publication runs only after both architectures build and attest successfully, and it requires both builds to come from the same commit and version with identical release notes. It creates a draft release at the built commit, uploads the apps and manifests, verifies each uploaded size and checksum and then publishes the release. A retry reuses a matching draft, never moves an existing tag and never replaces a published release.

## Signing

By default, the app is signed ad hoc. Developer ID signing and notarization use the credentials described in [signing and notarization](DEVELOPMENT.md#signing-and-notarization).

## System requirements

MacLauncher requires macOS 13 or later on a Mac with Apple Silicon or an Intel processor. The package lock records the highest minimum macOS version among the included native packages, and packaging checks it; the value sets no upper limit on supported macOS versions. Downloaded runtimes check their own CPU and macOS requirements, and Intel programs that MacLauncher starts still go through the Rosetta check on Apple Silicon.

The optional KosmicKrisp OpenGL ES 3.2 package requires macOS 27 or later because of its packaged dependencies, and is unavailable on older systems; the KosmicKrisp Vulkan driver itself requires macOS 26 ([System requirements](../runtimes/SYSTEM_REQUIREMENTS.md)). A runtime that requires 27.0 also accepts 27.1, 27.2 and later releases.
