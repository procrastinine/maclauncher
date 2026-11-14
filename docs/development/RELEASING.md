# Releases

MacLauncher is released from three repositories:

- [MacLauncher Android](https://github.com/procrastinine/maclauncher-android) holds the source of the Android runtime.
- [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) compiles the runtimes and tools that MacLauncher downloads, and keeps their patches and version history. Each build is made from exact upstream commits with MacLauncher's patches and build recipes, and each runtime is tagged with its own versions.
- MacLauncher holds the launcher and its runtime managers, which read the version catalogs published by MacLauncher Builds and by upstream projects.

Android changes reach a release in that order. A new MacLauncher Android commit is recorded in MacLauncher Builds before the matching Android runtime packages are released, and MacLauncher then reads the published runtime catalogs and records the exact packages that the app includes.

## Runtime releases

A MacLauncher Builds tag has the form `<project>/v<version>/<architecture>`, and the release under each tag holds that runtime's binary archive. The tag also identifies the source commit, which contains the source code and build instructions. For the launcher, the repository publishes one catalog per project, recording each version's download URL, checksum, size and CPU and macOS requirements.

Because runtime projects are released independently, a change to one or two runtimes does not rebuild the other projects. Existing binary versions stay available, and later catalogs never change a published version's download URL or checksum. **Refresh** in MacLauncher reads the catalog of the project concerned.

## App releases

The semantic app version is recorded in `package.json`, and `docs/releases/<version>.md` describes that version's features and fixes. Raising the version on the default branch publishes the matching `v<version>` release through the [app workflow](CI.md), which builds the app with the package versions listed in [`build/runtime-packages.json`](../../build/runtime-packages.json). The workflow page also describes the other triggers, the build inputs and signing.

A public app release has two app archives: `MacLauncher.app.zip` for Macs with Apple Silicon and `MacLauncher-Intel.app.zip` for Macs with an Intel processor. Next to each archive is a `MacLauncher-<arch>.build-manifest.json` file, which lists the packages included in that app and where each one was built. One GitHub build attestation, a signed record of the build, covers both the archive and its manifest; [verification](VERIFYING.md) describes the checks. The Apple Silicon asset keeps the name that earlier releases used, so existing links to the latest release still lead to it. To find a new archive and its SHA-256, **Check for Updates…** in the app reads the build manifest for the Mac's CPU, and [app updates](../UPDATES.md) describes what it checks.

The release notes begin with a download link for each build and instructions for opening it, followed by source and license links in a collapsed section. Other build outputs remain in the Actions artifacts.

Before a release becomes public, the uploaded app is verified, and once published, neither the release nor its tag ever changes; [publication](CI.md#artifacts-and-publication) describes the steps. Prerelease app versions are kept separate from the latest stable release.
