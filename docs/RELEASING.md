# Release procedure

A release combines the Apple Silicon launcher, exact runtime packages, source references and license notices. Runtime formats, child-process CPU architectures and minimum macOS requirements remain explicit in the catalogs and guides.

## Version and payloads

Increase the app version in `package.json` using semantic versioning. Write the changes for that version in `docs/releases/<version>.md`, describing new features, fixes and useful compatibility information. Pushing the version change to the repository's default branch starts the build and publishes `v<version>` automatically after all checks and the app upload succeed. A prerelease suffix produces a GitHub prerelease.

Reuse the complete verified native payload while runtime versions are unchanged. When they change, export the new payload using [runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md). Each package must contain its declared runtime files, native dependencies, fonts, plugins and license notices. Architecture mappings and each dependency's macOS floor are checked independently of the launcher's minimum.

Publish and configure the exported payload with `pnpm payload:publish --archive <payload.tar.gz>`. The command publishes the complete sources once, creates a smaller runtime-only download for app builds, and updates its URL, checksum, architecture and macOS requirement automatically. Repeat it when bundled runtimes change; ordinary app updates reuse the current payload. Details are in the [macOS workflow guide](CI.md). Missing packages, changed identities or incomplete supplemental resources stop the build.

## Checks and source distribution

```sh
pnpm check
node scripts/audit-public-repo.cjs --history
pnpm package:check -- source --arch arm64 --maximum-macos 13.0 --inventory dist/ci/native-payload-inventory.json
```

The public audit also accepts `--packaged-root /path/to/app/resources`. Source and app artifacts exclude local configuration, game files, caches and diagnostic output. Author credit and upstream notices remain intact.

The app retains required license notices. Git history provides the launcher source, owned patches and submodule pins. Complete runtime sources and build instructions remain available in the separately published native payload, linked from each app release. They are not downloaded or repackaged during app builds. Vendor SDKs and proprietary components retain separate distribution terms; an upstream mirror does not grant additional rights.

## App build and publication

1. Run `pnpm payload:publish --archive <payload.tar.gz>` for the initial payload or a changed payload, as described in [CI setup](CI.md).
2. Complete source, documentation and privacy checks, then push the version increment to the default branch. A manual workflow run can build an unpublished app first when needed.
3. The workflow installs locked dependencies, runs tests, builds the app and runs the final [packaging checks](runtimes/RUNTIME_DISTRIBUTION.md#deterministic-packaging-checks). Native packages are signed before their manifest checksums are finalized; the outer app must preserve those bytes.
4. The workflow creates the matching tag and release with **`MacLauncher.app.zip` as its only attachment**. GitHub adds its source-code links automatically. Release notes begin with the app download and opening instructions, followed by the version's highlights. Source links are under a collapsed section. Build manifests, inventories and check results stay in the Actions artifact. Failed uploads leave an unpublished draft that a workflow rerun can complete.

Explicit version tags also run this workflow and must match `package.json.version`. Manual workflow runs never create releases. Local [packaging commands](DEVELOPMENT.md#packaging-macos) remain available for development.

Publication uses GitHub CLI on the GitHub-hosted runner with the job's temporary `GITHUB_TOKEN`; local GitHub CLI installation or login is not required. Metadata lookups retry transient connection and server failures up to three times. A failed publication can be resumed by rerunning the failed release job: matching uploaded sizes and SHA-256 digests are reused, and only missing or changed draft assets are uploaded. The release becomes public after every asset's checksum matches. Published releases are never replaced.

Ad hoc signing supports unsigned distribution. Developer ID signing and notarization require the credentials described in the [development guide](DEVELOPMENT.md#packaging-macos). Runtime installation, source archives and the launcher remain subject to their respective licenses.
