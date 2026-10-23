# Split metadata packages

`base.apk` retains the compiled manifest from `../android-package-metadata/metadata.apk`. `resources.apk` contains its unmodified resource table and drawable files, with a matching split manifest declaring landscape, portrait and alias activities. `foreign.apk` declares a different package. Split manifests and ZIP records use the binary XML and archive writers in `tests/android-apk.test.js`.

`legacy-vector.apk` retains the complete metadata package and resource table from `../android-package-metadata/metadata.apk`. Its launcher drawable contains the original compiled foreground vector directly instead of wrapping it in an adaptive icon. This distinguishes legacy bounds from the adaptive 72 dp viewport without changing the vector's original geometry.
