# Releases

MacLauncher releases come from three repositories:

- [MacLauncher Android](https://github.com/procrastinine/maclauncher-android) contains the Android runtime implementation.
- [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) provides binary builds, version history and patches for the runtimes and tools that MacLauncher downloads. Each build is made from exact upstream commits with MacLauncher's patches and build recipes, and each runtime's versions are tagged independently.
- MacLauncher contains the launcher and its runtime managers, which read the published Builds and upstream catalogs.

A new MacLauncher Android commit is recorded in MacLauncher Builds before the matching Android runtime packages are released. MacLauncher then uses the published runtime catalogs and records the exact packages that the app includes.

## Runtime releases

A MacLauncher Builds tag has the form `<project>/v<version>/<architecture>`. Each release holds the runtime's binary archive. The tag identifies the source commit, which contains the source code and build instructions. The repository's per-project catalogs record the version, download URL, checksum, size and CPU and macOS requirements that the launcher uses.

Runtime projects release independently, so a change to one or two runtimes does not rebuild the other projects. Existing binary versions stay available, and a published version's download URL and checksum never change in later catalogs. **Refresh** in MacLauncher reads the relevant project catalog.

## App releases

`package.json` records the semantic app version, and `docs/releases/<version>.md` describes that version's features and fixes. Raising the version on the default branch publishes the matching `v<version>` release through the [app workflow](CI.md), which builds the app with the included package versions from [`build/runtime-packages.json`](../../build/runtime-packages.json). The workflow page also describes the other triggers, the build inputs and signing.

A public app release has two app archives: `MacLauncher.app.zip` for Macs with Apple Silicon and `MacLauncher-Intel.app.zip` for Macs with an Intel processor. Each has an attested `MacLauncher-<arch>.build-manifest.json` attachment with its included-package chain; [verification](VERIFYING.md) describes the checks. The Apple Silicon asset keeps the name that earlier releases used, so existing links to the latest release still lead to it. The app's **Check for Updates…** reads the build manifest for its CPU to find the archive and its SHA-256; [app updates](../UPDATES.md) describes the checks. The release notes begin with a download link for each build and opening instructions, followed by source and license links in a collapsed section. Additional build outputs stay in the Actions artifacts.

The app is verified after upload and before the release becomes public, and a published release and its tag are never changed; [publication](CI.md#artifacts-and-publication) describes the steps. Prerelease app versions stay separate from the latest stable release.
