# macOS app builds

[Build macOS app](../.github/workflows/macos-app.yml) builds the Apple Silicon app on a macOS runner. A version increase in `package.json` on the default branch publishes `v<version>`; a matching version tag also builds that release. A manual run creates an Actions artifact without publishing.

## Runtime inputs

[`build/runtime-packages.json`](../build/runtime-packages.json) pins each included package from MacLauncher Builds by project, version, architecture, URL, size and SHA-256. The workflow downloads those packages without compiling game runtimes. Updating one runtime changes its package entry; unchanged packages remain reusable across app releases. No payload URL, checksum or architecture repository variables are needed.

Managed game runtimes, including Flash Player, download through the app after an explicit action. The app includes Python, 7-Zip, extraction helpers and the core graphics/internal-helper packages selected by the [distribution policy](runtimes/RUNTIME_DISTRIBUTION.md#distribution-policy).

MacLauncher requires macOS 13 or later. The lock records the highest deployment requirement among its selected native packages; this is a packaging check, not an upper limit on supported systems. The optional KosmicKrisp renderer requires macOS 27 or later and is unavailable on older systems. A runtime requiring 27.0 also accepts 27.1, 27.2 and later releases. Other runtimes check their own CPU and macOS minimums. Intel child processes retain their explicit Rosetta requirements.

## Build and download

The workflow initializes only the submodules in [`build/source-dependencies.json`](../build/source-dependencies.json), installs locked pnpm dependencies, downloads the selected included packages, builds the renderer and packages the app. Packaging verifies its source resources once; finalization verifies the assembled app and ZIP once. Repository-wide tests and publication audits are separate from the app build.

The Actions artifact contains `MacLauncher.app.zip`, its checksum, the build identity and release notes. The public GitHub release contains only **`MacLauncher.app.zip`**. Runtime catalogs stay in MacLauncher Builds; release tags identify their source commits. License notices remain inside the app.

Only the publishing job receives `contents: write`. It creates a draft at the built commit, uploads the app, verifies the uploaded size and checksum, and publishes the release. A retry reuses a matching draft and never moves an existing tag or replaces a published release. Semantic prereleases do not replace the latest stable release.

The default app uses ad hoc signing. Developer ID signing and notarization use the credentials described in [Development](DEVELOPMENT.md#packaging-macos).
