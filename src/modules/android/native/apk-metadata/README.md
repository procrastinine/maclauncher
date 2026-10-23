# APK metadata helper

`android-apk-metadata` reads APK package names, localized labels, activity orientations and icons. It runs as a standalone macOS executable. Android system images, Java and game runtimes are not required.

The helper uses the complete AIM APK, binary XML, resource-table and drawable modules listed in `sources.json`. CoreGraphics and ImageIO render raster, vector and adaptive drawables into a 256 × 256 PNG. The owned adaptation adds a base-plus-split resource view and locale selection while retaining the original parser interfaces. Framework-only resources and drawables that the parser cannot render produce no icon; the helper does not run application code. Adaptive icon layers use Android's 72 dp visible viewport within their 108 dp drawing canvas. Legacy drawables retain their full image bounds. The launcher applies the Dock silhouette to the rendered image once.

## Protocol

The process reads one UTF-8 JSON object from standard input, followed by EOF:

```json
{"sourceApks":["/packages/base.apk","/packages/config.fr.apk"],"locale":"fr-FR","outputDirectory":"/private/output"}
```

The first source is the base APK. Additional sources must be splits of the same package. Their resource configurations and application declarations supplement the base. File lookup follows supplied asset order. Locale selection compares language, region and an explicitly supplied script, then falls back to the default configuration. Drawable selection retains the upstream density and platform-version preferences.

`outputDirectory` must already exist. The helper creates `icon.png` exclusively with mode `0600` when an icon is rendered. Its one-line JSON response contains `schemaVersion`, `label`, `packageName`, `activityWindows`, `iconFile`, `icon` and `locale`. `activityWindows` maps full activity and alias names to `{landscape:true|false|null}`; aliases inherit a declared target orientation. `iconFile` is an absolute path or `null`. An optional `iconDiagnostic` describes a drawable that could not be rendered. Invalid requests or packages exit with a nonzero status and a bounded error on standard error.

Requests and responses are limited to 1 MiB, source lists to 1024 APKs and encoded icons to 8 MiB. Archive entry limits and CRC checking remain those of the original parser.

## Build

`build.mjs` accepts `--aim-source`, `--dependencies`, `--rustc` and `--output`. It copies the original AIM parser sources, applies `adapt.mjs`, compiles the parser and executable, sets the macOS 13 deployment target and signs the result. The dependency JSON supplies checksum-pinned `aim_android_xml`, `android_image_extract`, `libc` and `serde_json` Rust archives plus `searchDirectories` for their transitive archives. The two AIM dependency libraries use their original source files; `android-image-extract` uses the pinned `crc32fast`, `flate2` Rust backend and `sha2` dependencies.

`dependencies.mjs --aim-source ... --archives ... --rustc ... --output ...` compiles those two original AIM libraries and emits the dependency JSON. Its archive input supplies checksum-pinned `libc`, `serde_json`, `crc32fast`, `flate2` and `sha2` archives plus their dependency search directories. Both producers remap source paths and retain source checksums.

`source.mjs` creates the corresponding-source archive and notices from the pinned AIM tree, its resolved Cargo lockfile, the supplied crate source cache and Rust distribution notices. These are developer build inputs; ordinary imports execute the included helper directly.
