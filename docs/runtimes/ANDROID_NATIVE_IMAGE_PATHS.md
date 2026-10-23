# Android native image pathnames

For a loaded guest image, `dladdr` reports the canonical pathname admitted by
the Android filesystem namespace. The image retains that pathname with its
load-time identity. Subsequent filesystem renames or namespace alias changes
preserve the name and its storage while the image remains loaded.

Canonical physical targets are matched through the existing namespace aliases,
including symbolic-link targets. Host preparation directories are not published
as guest image pathnames. An image without an admitted guest pathname retains
its registry name. Native provider addresses retain the platform linker's
original metadata, and format providers retain their existing image operations.

Path storage is allocated when image identity is captured and released with
the image. Address queries reuse the stored name without path allocation or
temporary string storage.
