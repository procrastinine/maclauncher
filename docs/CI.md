# macOS app builds

[Build macOS app](../.github/workflows/macos-app.yml) builds `MacLauncher.app`, verifies its signatures and complete native payloads, and publishes a GitHub Release when `package.json.version` increases on the repository's default branch. The release includes a zip that preserves executable modes and framework symlinks. No local app build or manual tag creation is required.

The version comparison uses the commit before the push, including pushes with multiple commits. Unchanged versions and other branches do not build or publish. Decreasing versions and changes only to semantic-version build metadata fail. A new repository root can create its first release. The workflow also accepts an explicit `v<version>` tag matching `package.json.version`; mismatches fail before dependency installation. Manual runs build downloadable Actions artifacts without publishing.

Release builds target **Apple Silicon** and use [GitHub's `macos-26` ARM runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Manual builds default to `arm64`; an explicit `x64` manual build uses `macos-26-intel` and requires its own complete payload. Automatic release builds reject an Intel launcher configuration before dependency installation. An ARM launcher can include an Intel child runtime only when its module declares that mapping and handles Rosetta separately.

[checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node), [upload-artifact](https://github.com/actions/upload-artifact), [download-artifact](https://github.com/actions/download-artifact) and [pnpm setup](https://github.com/pnpm/action-setup) are pinned to exact commits. The workflow uses [Node.js](https://github.com/nodejs/node) 24 and [pnpm](https://github.com/pnpm/pnpm) 12.10.1. After validating build configuration, [the shared source initializer](../scripts/init-submodules.cjs) acquires pinned build inputs according to `.gitmodules`: required nested dependencies are included, ONScripter-Yuri uses only its primary tree, and reference-only sources remain uninitialized. It then runs `pnpm install --frozen-lockfile`, typechecking and repository tests. Existing dependency age, trust and build-script policies remain enforced.

## Required payload configuration

Native runtime binaries are generated release inputs and are absent from a fresh Git checkout. CI requires a real, separately published archive produced by [native-payload.cjs](../scripts/native-payload.cjs), with its exact SHA-256. It does not guess a release URL, build an arbitrary runtime version, or omit missing managers. A backend that fails to load into the registry also stops release verification.

| Manual input | Repository variable for automatic releases |
| --- | --- |
| `native_payload_url` | `MACLAUNCHER_NATIVE_PAYLOAD_URL` |
| `native_payload_sha256` | `MACLAUNCHER_NATIVE_PAYLOAD_SHA256` |
| `arch` (default `arm64`; manual `x64` optional) | `MACLAUNCHER_NATIVE_PAYLOAD_ARCH` (`arm64` for releases) |
| `maximum_native_macos` (for example `13.0` or `27.0`) | `MACLAUNCHER_NATIVE_MAXIMUM_MACOS` |

All four are required. The URL must identify an actual HTTPS asset, and the checksum must be its exact lowercase SHA-256. Configuration fails before dependency installation when a value is absent or invalid. CPU selection determines the runner; genuine Intel artifacts can be included in an ARM launcher only through the module's explicit architecture mapping. A module's explicit empty target list declares that backend unavailable for that launcher CPU; missing mappings still fail. Unavailable backends must retain the matching host-architecture gate in their catalog metadata.

The native macOS value is the maximum permitted **runtime** requirement, independent of the launcher's minimum. A `13.0` limit rejects native dependencies requiring a newer system. A higher value permits a development package with those dependencies; every runtime still enforces its actual host requirements. Intel selection requires genuine packages for its declared managers; an ARM binary cannot stand in for them.

## Preparing the archive

Use the existing verified payload while its declared runtime versions remain unchanged. Upload it once to a stable HTTPS asset location and set the four repository variables. An auxiliary GitHub Release can host this build input; use a non-`v` tag and leave it out of the latest app release designation. This setup does not require rebuilding the included runtimes for each app release.

When included runtime versions change, stage the packages following [runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md), then export the complete set for an explicit launcher architecture and allowed floor:

```sh
node scripts/native-payload.cjs required --arch arm64 --maximum-macos 13.0
node scripts/native-payload.cjs export \
  --arch arm64 --maximum-macos 13.0 \
  --output .local/runtime-distribution/native-payload-arm64.tar.gz
```

The exporter verifies actual signatures, load commands, source revisions, whole-file inventories, checksums, notices and modes. The shared [distribution model](../scripts/distribution-model.cjs) selects each manager's declared `distributionVersions`, or its existing offline recommendation when no finite list is declared. Other locally available versions are excluded from the build input and app. Modules also declare pinned supplemental native resources, including the offline API and JNI/Lua bridges with their sources and licenses. Missing required versions or supplemental files stop export. Resources restricted to local use cannot be exported or packaged. The output reports the real archive checksum and its embedded inventory.

The portable tar.gz contains `native-payload.json` followed by sealed manifests and their exact regular files. Supplemental resources retain their module-declared directory layout, exact file hashes, CPU slices and deployment floors. It contains no source build directories, game files or diagnostic output. Sealed metadata must already be public: retained private diagnostic fields stop export/import and require restaging instead of rewriting sealed manifest bytes. Source/version identity stays in the manifests and inventory. Publishing this archive is a separate release-maintainer action; the workflow supplies no placeholder destination or upload operation for native payloads.

The same fetch command accepts a local archive for offline payload import:

```sh
node scripts/native-payload.cjs fetch \
  --archive .local/runtime-distribution/native-payload-arm64.tar.gz \
  --sha256 <the-exported-64-character-checksum> \
  --arch arm64 --maximum-macos 13.0 \
  --resources .local/runtime-distribution/payload-roundtrip
```

CI uses the explicit URL instead. The fetcher verifies the complete downloaded archive before extraction, requires matching architecture/floor, every current required version and every declared supplemental resource, rejects links, traversal, duplicate/unlisted files and malformed archives, and bounds compressed/expanded sizes. It verifies native signatures and dependency load commands again before publishing resources in one transaction; a final signature failure restores both manager packages and supplemental resources. HTTPS redirects retain the same transport and checksum requirements.

## Build artifacts

The workflow runs the mandatory [packaging checks](runtimes/RUNTIME_DISTRIBUTION.md#deterministic-packaging-checks) before building, builds through `pnpm run package:mac -- --dir`, and validates the final app and zip with the same checker. This checks app identity/version, actual launcher CPU/macOS floor, signatures, archive/resource filters and the complete native inventory. Every zip file and symlink is compared with the verified app by streaming its contents; no extracted app copy is needed. Extra native versions, source archives inside the app and excluded files stop artifact creation. Uploads select named release files explicitly. Its zip is ad hoc signed, without Developer ID signing or notarization; the Developer ID signing process remains in [runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md).

The app includes its archive tools, Python runtime and declared native players. Ordinary Included playback and binary runtime installs use the app's payloads and macOS utilities rather than Homebrew or Apple developer tools. Rosetta is a separate, prompted prerequisite for Intel child processes. Optional authenticated MKXP-Z Actions updates still use `gh`; its Included player does not.

The downloadable artifact includes:

- The app zip, with native license notices and sealed runtime manifests.
- `build-manifest.json`, the exact payload inventory and `SHA256SUMS.txt`.
- `distribution-plan.json` and `packaging-checks.json`, generated from the selected source and final app.
- The project `LICENSE`, [attributions](ATTRIBUTIONS.md) and distribution guide.
- `MacLauncher-source.tar.gz`, containing the committed launcher and module-owned overlays, plus `source-pins.json`.
- `MacLauncher-runtime-sources.tar.gz`, containing the corresponding-source archives declared by the included runtimes, with its source inventory and checksum.

The source archive uses the exact checked-out Git commit and excludes untracked/local files. Changed or uncommitted public source/build files stop artifact creation, including the dependency lockfile and root package, pnpm, Vite and TypeScript configuration. Accidentally committed private workspace files, local configuration, game directories and diagnostics are rejected before an archive is created. Submodule sources are referenced by their pins and `.gitmodules`; the archive does not include their checkouts. Native manifests retain exact source revisions and dependency notice locations. This scope preserves source references and owned adaptations without claiming to bundle every upstream source tree or granting rights to proprietary components.

Committed source symlinks must be relative and resolve within the exported tree. Source creation rejects missing targets, cycles, escapes and links into excluded submodule checkouts, then checks archive membership so Git export rules cannot leave a dangling link. App zips preserve framework aliases and executable modes; final checks compare the stored link text and file contents with the verified app.

The release job downloads the build artifact and independently checks its version, source commit, exact asset list and archive checksums. [GitHub CLI](https://cli.github.com/manual/gh_release_create) creates `v<version>` at the exact built commit, uploads all assets to a draft, and publishes only after GitHub reports every asset uploaded. Semantic prereleases such as `0.4.0-beta.1` are marked as prereleases and do not replace the latest stable release. Stable releases use GitHub's semantic-version selection for Latest. A retry can complete a matching draft; it never moves an existing tag or replaces a published release. Runs for the same commit are serialized; separate version increments retain separate builds.

Only the release job receives `contents: write`, through the workflow's `GITHUB_TOKEN`; no personal access token is required. Tests and builds retain read-only repository access. Branch protection can govern when version changes reach the default branch. Follow the [release procedure](RELEASING.md) before merging a version increment.
