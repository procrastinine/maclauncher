# Release procedure

A release combines the Apple Silicon launcher, exact runtime packages, source references and license notices. Runtime formats, child-process CPU architectures and minimum macOS requirements remain explicit in the catalogs and guides.

## Version and payloads

Increase the app version in `package.json` using semantic versioning. Pushing that change to the repository's default branch starts the build and publishes `v<version>` automatically after all checks and asset uploads succeed. Complete documentation changes before pushing the version increment. A prerelease suffix produces a GitHub prerelease.

Reuse the complete verified native payload while runtime versions are unchanged. When they change, export the new payload using [runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md). Each package must contain its declared runtime files, native dependencies, fonts, plugins and license notices. Architecture mappings and each dependency's macOS floor are checked independently of the launcher's minimum.

Publish the payload at an HTTPS asset URL. Configure its exact SHA-256, launcher architecture and permitted runtime floor in the [macOS workflow](CI.md). Missing packages, changed identities or incomplete supplemental resources stop the build.

## Checks and source distribution

```sh
pnpm check
node scripts/audit-public-repo.cjs --history
pnpm package:check -- source --arch arm64 --maximum-macos 13.0
```

The public audit also accepts `--packaged-root /path/to/app/resources`. Source and app artifacts exclude local configuration, game files, caches and diagnostic output. Author credit and upstream notices remain intact.

Include the project license, [attributions](ATTRIBUTIONS.md), exact source pins and the corresponding sources and build instructions required by each component's license. Vendor SDKs and proprietary components retain separate distribution terms; an upstream mirror does not grant additional rights.

## App build and publication

1. Configure the native payload URL, checksum, Apple Silicon architecture and runtime floor once, as described in [CI setup](CI.md). Update these variables when the payload changes.
2. Complete source, documentation and privacy checks, then push the version increment to the default branch. A manual workflow run can build an unpublished app first when needed.
3. The workflow installs locked dependencies, runs tests, builds the app and runs the final [packaging checks](runtimes/RUNTIME_DISTRIBUTION.md#deterministic-packaging-checks). Native packages are signed before their manifest checksums are finalized; the outer app must preserve those bytes.
4. The workflow creates the matching tag and release, attaching the app zip, launcher and runtime source archives, build manifest, distribution plan, packaging results, payload inventory, checksums and license notices. Failed uploads leave an unpublished draft that a workflow rerun can complete.

Explicit version tags also run this workflow and must match `package.json.version`. Manual workflow runs never create releases. Local [packaging commands](DEVELOPMENT.md#packaging-macos) remain available for development.

Ad hoc signing supports unsigned distribution. Developer ID signing and notarization require the credentials described in the [development guide](DEVELOPMENT.md#packaging-macos). Runtime installation, source archives and the launcher remain subject to their respective licenses.
