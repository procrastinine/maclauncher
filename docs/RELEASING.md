# Releases

MacLauncher Android contains the Android runtime implementation. MacLauncher Builds contains runtime producers, pinned upstream sources and patches, with independent version tags for each runtime. MacLauncher contains the launcher and its runtime managers, which read the published Builds and upstream catalogs.

## Runtime versions

A MacLauncher Builds tag has the form `<project>/v<version>/<architecture>`. Each release downloads that runtime's binary archive. The tag identifies the source commit; source code and build instructions are available from that commit. The repository's per-project catalogs contain the version, download URL, checksum, size and CPU/macOS requirements used by the launcher.

Runtime projects release independently. A change to one or two runtimes does not rebuild the other projects. Existing binary versions remain available, and new catalogs retain their immutable download identities. Refresh in MacLauncher reads the relevant project catalog; installation and version selection are explicit actions.

Android producer updates are pinned in MacLauncher Builds before the matching Android runtime packages are released. MacLauncher uses the published runtime catalogs and pins the packages that its application includes.

## App versions

`package.json` records the semantic app version. `docs/releases/<version>.md` describes that version's features and fixes. A version increase on the default branch starts the app workflow and publishes the matching `v<version>` tag. Matching version tags also run the workflow. Manual workflow runs produce an unpublished Actions artifact.

[`build/runtime-packages.json`](../build/runtime-packages.json) supplies the included package versions. App builds reuse those downloads, install locked dependencies, build the renderer and package `MacLauncher.app`. The [workflow reference](CI.md) describes its inputs and signing behavior.

The public app release has one attachment: **`MacLauncher.app.zip`**. Release notes begin with its download link and opening instructions. Source and license links appear in a collapsed section. Build records stay in the Actions artifact.

The publisher verifies the app's uploaded size and checksum before making the release public. A retry can finish a matching draft. Published releases and their tags are preserved. Prerelease app versions remain separate from the latest stable release.
