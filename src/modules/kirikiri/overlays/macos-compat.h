#ifndef MACLAUNCHER_KIRIKIRI_MACOS_COMPAT_H
#define MACLAUNCHER_KIRIKIRI_MACOS_COMPAT_H

/* The pinned FreeType zconf.h assumes Apple's legacy Byte typedef exists when
 * MACOS is defined. Current SDKs no longer provide it. Keep the compatibility
 * typedef in our build overlay instead of changing the vendored FreeType. */
#ifdef __APPLE__
typedef unsigned char Byte;
#endif

#endif
