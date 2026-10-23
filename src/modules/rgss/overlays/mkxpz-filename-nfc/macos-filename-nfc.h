/* SPDX-License-Identifier: GPL-2.0-or-later
 * macOS filename normalization for MKXP-Z's UTF-8 path cache.
 */
#pragma once

#include <stddef.h>

enum MkxpzFilenameNfcResult {
  MKXPZ_FILENAME_NFC_OK = 1,
  MKXPZ_FILENAME_NFC_INVALID = 0,
  MKXPZ_FILENAME_NFC_CAPACITY = -1,
  MKXPZ_FILENAME_NFC_MEMORY = -2
};

/* input is NUL-terminated UTF-8; capacity includes output's NUL terminator.
 * Only an OK result permits using output. The caller retains its original path
 * until normalization succeeds, including when NFC expands its UTF-8 length.
 */
#ifdef __cplusplus
extern "C" {
#endif
enum MkxpzFilenameNfcResult mkxpz_filename_nfc(const char *input, char *output, size_t capacity);
#ifdef __cplusplus
}
#endif
