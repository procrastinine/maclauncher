# Split metadata packages

The fixture preparation helper links the retained XML and resource sources with the checksum-pinned publisher aapt2 and Android API archive. `base.apk` contains the generated metadata manifest. `resources.apk` contains the same resource definitions and `resources.xml` split activities. The foreign-package APK is generated with the existing binary XML and ZIP writers in its temporary test directory.

`legacy-vector.apk` links the foreground vector as the launcher drawable itself, while the metadata APK uses the adaptive icon. This preserves the comparison between the legacy viewport and the adaptive 72 dp viewport. Generated archives are ignored. CI fetches the pinned tools; local tests use the cache and report an offline skip when those tools are absent.
