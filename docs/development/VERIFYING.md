# Verifying MacLauncher

This guide explains how MacLauncher's own builds are made and how anyone can check them. MacLauncher and the runtime packages compiled for it are built from public source code and public recipes on machines that GitHub runs (Mac or Linux), never on machines that the project's owner controls. For each release archive, GitHub signs a build record naming the exact source commit, workflow and build run. Checking that record confirms that a downloaded archive is the unchanged output of that build. The MacLauncher Builds verification table lists older, locally built packages and unchanged publisher files separately from these signed builds. Anyone with a Mac can also rebuild the app from the same source and compare the result.

## How an app release is built

Each MacLauncher release has two apps, one for Apple Silicon and one for Intel. GitHub Actions, GitHub's service for running build steps, builds both of them from a public list of steps, the [app workflow](../../.github/workflows/macos-app.yml) in this repository. For each CPU, the workflow packs the app into a ZIP archive and writes a build manifest next to it. A build manifest is a JSON file that names the app's version, CPU and source commit, the tools that built it, and the MacLauncher Builds packages inside it.

[MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds) is a separate repository that compiles engines, players and helpers for MacLauncher. Each compiled package comes from a recipe: the instructions, patches and source references in that repository that turn a project's source code into a Mac package. A few of these compiled packages ship inside the app itself, and this guide calls them included packages. Each one must have a build record of its own. MacLauncher Builds also hosts some publishers' files unchanged. Those are checked another way: every file is compared with a registered list of the publisher's original files and their exact checksums. A match shows that the files are unchanged, but it does not show that GitHub built them, and it does not prove who the publisher is. [Verifying MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/blob/main/VERIFYING.md) describes both kinds of check and how projects that newer ones replaced keep their history.

GitHub calls a signed build record an attestation, or more fully a build provenance attestation. One attestation covers both the app archive and its manifest, and it names the source commit, the workflow and the build run that produced them.

An attestation shows where a file came from. It does not show that a recipe is safe, and it does not show that a second build would produce the same bytes. Reading the source answers the first question, and rebuilding the app answers the second.

## Verify an app

The commands below use the GitHub CLI, `gh`.

1. The archive and its manifest are downloaded from the same release. This example uses the Apple Silicon app; the Intel app uses `MacLauncher-Intel.app.zip` and `MacLauncher-x64.build-manifest.json`.

   ```sh
   tag=v0.7.0
   gh release download "$tag" --repo procrastinine/maclauncher \
     --pattern MacLauncher.app.zip --pattern MacLauncher-arm64.build-manifest.json
   ```

2. The build record of both files is checked against the app workflow and the release's exact commit. Here `commit` is the full 40-character commit that the release tag's source link shows.

   ```sh
   commit=<40-character-app-source-commit>
   gh attestation verify MacLauncher.app.zip --repo procrastinine/maclauncher \
     --signer-workflow procrastinine/maclauncher/.github/workflows/macos-app.yml \
     --source-digest "$commit" --deny-self-hosted-runners
   gh attestation verify MacLauncher-arm64.build-manifest.json --repo procrastinine/maclauncher \
     --signer-workflow procrastinine/maclauncher/.github/workflows/macos-app.yml \
     --source-digest "$commit" --deny-self-hosted-runners
   shasum -a 256 MacLauncher.app.zip
   ```

   Each check succeeds only for a file that the app workflow built from that commit on a GitHub-hosted Mac; `--deny-self-hosted-runners` rejects builds on machines that the repository owner supplies. Because one attestation covers both files, both checks report the same build run and the same pair of files. The SHA-256 that `shasum` prints must equal `appArchiveSha256` in the manifest. In the manifest, `sourceCommit`, `arch` and `version` identify the app, and `toolchain` records the Node, pnpm, Xcode, macOS SDK and macOS versions on the build machine.

3. Optionally, the same source can be rebuilt on a Mac with the same CPU, as [Rebuild the app](#rebuild-the-app) describes, and the two archives and the files inside them compared. The bytes can differ even when nothing was added: ZIP archives store timestamps, each build gets its own local (ad hoc) code signature, and a change of build tools changes the output. Any difference needs a closer look, because differing bytes alone cannot show whether the programs behave the same.

## Included packages

The manifest lists every included package under `publishedInputs.builds`. Each entry gives the package's project, version, CPU, download URL and SHA-256, together with the verified contents of the package's own build record, which name the MacLauncher Builds commit and build run that produced it. The app's source commit also contains [`build/runtime-packages.json`](../../build/runtime-packages.json), the file that fixes which package versions the app includes.

These records connect an app to public source code in four steps. The app's build record covers its manifest, the manifest gives the SHA-256 of each included package, each package's build record names the MacLauncher Builds workflow and commit that built it, and that commit holds the package's public recipe.

Checking an included package starts from the manifest: the package is downloaded from the URL listed there and its SHA-256 compared with the manifest's value, and the remaining checks follow [Verifying MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/blob/main/VERIFYING.md). Its build record must name `procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml`, the source commit given in the manifest and a GitHub-hosted runner.

The app workflow makes the same checks on its own. Before it assembles the app, it verifies the build record of each included package, and afterwards it compares the files taken from each package with the files in the finished app. GitHub signs the manifest together with the final ZIP only after the finished app and its ZIP pass these checks. Each release keeps both manifests next to the two app archives, and the build run keeps its complete output as downloadable Actions artifacts until GitHub's retention period ends.

## Files from other publishers

Besides its own builds, MacLauncher uses finished programs and data files from their publishers. These are checked in other ways. Several rely on a Developer ID signature, the code signature that Apple issues for software distributed outside the App Store; its team ID identifies the company that signed it.

| Component | How it is checked |
| --- | --- |
| Included Python | The checksum of the publisher's archive for each CPU, recorded in [embedded-python.json](../../src/modules/shared/runtime/embedded-python.json); the native files taken from that archive are then compared with it |
| Included 7-Zip | The checksums of the publisher's archive and of its executable, recorded in [source.json](../../src/resources/7zip/source.json); the executable in the app is then compared with it |
| Electron and pnpm dependencies | The release archive or package checksum fixed in the lock files; the app files taken from them are compared with those downloads |
| Prebuilt helpers with a `binary.json` | The publisher URL, size and SHA-256 recorded in the helper's `binary.json` |
| SteamCMD | Valve's Developer ID signature, team `MXGJJ98X76`, checked before SteamCMD runs; the download comes from Valve's HTTPS address |
| YoYo Games Igor and runners | Igor's Developer ID signature, team `C9E7J7HL3D`; for runtime downloads, the size listed in YoYo Games' feed and a SHA-256 recorded at download identify the files |
| NVIDIA model files | The size and SHA-256 of each selected file, recorded in the model declarations; each file taken from a Python wheel is checked against its own recorded hash |
| Publisher files hosted unchanged in MacLauncher Builds | The publisher's original archive, registered with its checksum, and a comparison of every file's SHA-256, size and permissions with that archive; a match shows that the files are unchanged but does not prove who the publisher is |
| Other components downloaded from their publishers | The publisher's digest or code signature when it supplies one; otherwise an HTTPS download from the publisher, a check that the files have the expected structure, and a SHA-256 recorded at installation |

Closed-source components cannot be rebuilt from source, so the rebuild comparison does not cover them, and a publisher's signature or checksum is not a MacLauncher build record. Components that MacLauncher downloads from their publishers follow each publisher's current releases, with no fixed version or checksum across the app; [Runtime distribution](../runtimes/RUNTIME_DISTRIBUTION.md) describes which components are included in the app and which are downloaded.

## Rebuild the app

A rebuild needs a Mac with the same CPU as the app being compared, a checkout of the commit named in the app's build record, and the Node and pnpm versions that the app workflow uses. Dependencies come from the lock files in that commit. These commands follow the [Build macOS app workflow](../../.github/workflows/macos-app.yml):

```sh
git clone https://github.com/procrastinine/maclauncher.git
cd maclauncher
git checkout --detach <40-character-app-source-commit>
export MACLAUNCHER_APP_ARCH=arm64
node scripts/ci-macos.cjs sources
pnpm install --frozen-lockfile
node scripts/ci-macos.cjs configure
node scripts/ci-macos.cjs fetch
pnpm run package:mac -- --dir --arm64 \
  --runtime-maximum-macos <maximumMacOS-from-configure> \
  --runtime-inventory dist/ci/native-payload-inventory.json
node scripts/ci-macos.cjs finalize
```

The Intel app is rebuilt the same way with an Intel build of Node, `MACLAUNCHER_APP_ARCH=x64` and `--x64`. A local build checks the build records of the included packages just as the app workflow does, and it writes an archive and manifest under `dist/ci/`. Only a build running on GitHub Actions can obtain a signed build record from GitHub, so a local rebuild produces none.

The app ZIP is not designed to come out byte for byte identical from every build. The ZIP format keeps file metadata such as timestamps, and code signatures and build tools can vary between builds. A rebuilt archive that differs therefore casts no doubt on the original's build record. A build record, in turn, cannot explain why an executable changed; that takes a comparison of the source, compiler, SDK, dependencies and the files that differ.
