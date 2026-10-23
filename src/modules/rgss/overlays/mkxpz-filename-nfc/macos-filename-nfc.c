/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "macos-filename-nfc.h"
#include <CoreFoundation/CoreFoundation.h>
#include <limits.h>
#include <string.h>

enum MkxpzFilenameNfcResult
mkxpz_filename_nfc(const char *input, char *output, size_t capacity) {
  if (!input) return MKXPZ_FILENAME_NFC_INVALID;
  if (!output || capacity == 0 || capacity > (size_t)LONG_MAX)
    return MKXPZ_FILENAME_NFC_CAPACITY;
  const size_t inputSize = strlen(input);
  if (inputSize > (size_t)LONG_MAX) return MKXPZ_FILENAME_NFC_CAPACITY;
  CFStringRef source = CFStringCreateWithBytes(kCFAllocatorDefault, (const UInt8 *)input,
      (CFIndex)inputSize, kCFStringEncodingUTF8, false);
  if (!source) return MKXPZ_FILENAME_NFC_INVALID;
  CFMutableStringRef normalized = CFStringCreateMutableCopy(kCFAllocatorDefault, 0, source);
  if (!normalized) { CFRelease(source); return MKXPZ_FILENAME_NFC_MEMORY; }
  CFStringNormalize(normalized, kCFStringNormalizationFormC);
  // Never turn a platform truncation of a long combining sequence into a
  // different asset lookup.
  if (!CFEqual(source, normalized) &&
      CFStringCompare(source, normalized, kCFCompareNonliteral) != kCFCompareEqualTo) {
    CFRelease(normalized); CFRelease(source); return MKXPZ_FILENAME_NFC_INVALID;
  }
  CFRelease(source);
  const Boolean success = CFStringGetCString(normalized, output, (CFIndex)capacity, kCFStringEncodingUTF8);
  CFRelease(normalized);
  return success ? MKXPZ_FILENAME_NFC_OK : MKXPZ_FILENAME_NFC_CAPACITY;
}
