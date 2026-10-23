#include "macos-filename-nfc.h"
#include <assert.h>
#include <limits.h>
#include <string.h>
#include <stdio.h>
#include <stack>
#include <stdexcept>
#include <string>
#include <vector>

// The real engine has a global Rect type before including the NFC API.
// Framework types must remain confined to the separate C implementation.
struct Rect { int engineMember; };

struct FileSystemPrivate {};
struct Exception : std::runtime_error {
  enum Type { PHYSFSError };
  Exception(Type, const char *message) : std::runtime_error(message) {}
};

// Extracted from the actual patched upstream unit by the test driver.
#include "cache-enum-data.inc"

int main() {
  const struct { const char *name; const char *input; const char *expected; } cases[] = {
    {"ASCII", "Graphics/Actors/Hero.png", "Graphics/Actors/Hero.png"},
    {"accent", "Cafe\xcc\x81.png", "Caf\xc3\xa9.png"},
    {"Japanese", "\xe3\x81\x8b\xe3\x82\x99.png", "\xe3\x81\x8c.png"},
    {"Hangul", "\xe1\x84\x80\xe1\x85\xa1\xe1\x86\xa8.png", "\xea\xb0\x81.png"},
    {"emoji", "\xf0\x9f\x91\xa9\xe2\x80\x8d\xf0\x9f\x92\xbb.png", "\xf0\x9f\x91\xa9\xe2\x80\x8d\xf0\x9f\x92\xbb.png"},
    {"canonical order", "a\xcc\x95\xcc\x80.png", "\xc3\xa0\xcc\x95.png"},
    {"canonical singleton", "\xe2\x84\xab.png", "\xc3\x85.png"},
    {"empty", "", ""}
  };
  FileSystemPrivate state;
  CacheEnumData cache(&state);
  for (const auto &item : cases) {
    char output[512], original[512];
    assert(mkxpz_filename_nfc(item.input, output, sizeof(output)) == MKXPZ_FILENAME_NFC_OK);
    assert(strcmp(output, item.expected) == 0);
    strcpy(original, item.input);
    cache.toNFC(original);
    assert(strcmp(original, item.expected) == 0);
    printf("PASS %s\n", item.name);
  }

  const char *invalid[] = {"\xff", "\x80", "\xc0\xaf", "\xe3\x81", "\xed\xa0\x80", "\xf4\x90\x80\x80"};
  for (const char *input : invalid) {
    char output[512], original[512];
    assert(mkxpz_filename_nfc(input, output, sizeof(output)) == MKXPZ_FILENAME_NFC_INVALID);
    strcpy(original, input);
    bool rejected = false;
    try { cache.toNFC(original); } catch (const Exception &error) {
      rejected = true;
      assert(strstr(error.what(), "UTF-8") != nullptr);
    }
    assert(rejected && strcmp(original, input) == 0);
  }
  puts("PASS malformed UTF-8 rejected without replacing the path");

  struct { char before; char output[4]; char after; } bounded = {'A', {}, 'Z'};
  assert(mkxpz_filename_nfc("long", bounded.output, sizeof(bounded.output)) == MKXPZ_FILENAME_NFC_CAPACITY);
  assert(bounded.before == 'A' && bounded.after == 'Z');
  assert(mkxpz_filename_nfc("abc", bounded.output, sizeof(bounded.output)) == MKXPZ_FILENAME_NFC_OK);
  assert(strcmp(bounded.output, "abc") == 0);
  assert(mkxpz_filename_nfc("", bounded.output, 1) == MKXPZ_FILENAME_NFC_OK && bounded.output[0] == 0);
  assert(mkxpz_filename_nfc("x", bounded.output, 0) == MKXPZ_FILENAME_NFC_CAPACITY);
  assert(mkxpz_filename_nfc("x", nullptr, 4) == MKXPZ_FILENAME_NFC_CAPACITY);
  assert(mkxpz_filename_nfc(nullptr, bounded.output, sizeof(bounded.output)) == MKXPZ_FILENAME_NFC_INVALID);
  assert(mkxpz_filename_nfc("x", bounded.output, (size_t)LONG_MAX + 1) == MKXPZ_FILENAME_NFC_CAPACITY);

  // U+0344 expands under NFC; its valid input fits but normalized path does not.
  std::string expanding;
  for (int i = 0; i < 120; ++i) expanding += "x\xcd\x84";
  char expanded[1024], original[512];
  assert(mkxpz_filename_nfc(expanding.c_str(), expanded, sizeof(expanded)) == MKXPZ_FILENAME_NFC_OK);
  assert(strlen(expanded) == 600);
  assert(mkxpz_filename_nfc(expanding.c_str(), original, sizeof(original)) == MKXPZ_FILENAME_NFC_CAPACITY);
  strcpy(original, expanding.c_str());
  bool rejected = false;
  try { cache.toNFC(original); } catch (const Exception &error) {
    rejected = true;
    assert(strstr(error.what(), "511-byte") != nullptr);
  }
  assert(rejected && expanding == original);
  puts("PASS capacity, terminator, boundary guards and NFC expansion");

  // Long combining runs must be preserved canonically or rejected, never cut.
  for (int count : {31, 32, 33, 200}) {
    std::string combining, expected;
    for (int i = 0; i < count; ++i) { combining += "\xcd\x84"; expected += "\xcc\x88\xcc\x81"; }
    const auto result = mkxpz_filename_nfc(combining.c_str(), expanded, sizeof(expanded));
    assert(result == MKXPZ_FILENAME_NFC_INVALID || result == MKXPZ_FILENAME_NFC_OK);
    if (count <= 32) assert(result == MKXPZ_FILENAME_NFC_OK);
    if (result == MKXPZ_FILENAME_NFC_OK) assert(expected == expanded);
    printf("PASS combining sequence count=%d result=%d\n", count, (int)result);
    strcpy(original, combining.c_str()); rejected = false;
    try { cache.toNFC(original); } catch (const Exception &) { rejected = true; }
    if (count == 200 || result == MKXPZ_FILENAME_NFC_INVALID)
      assert(rejected && combining == original);
    else assert(!rejected && expected == original);
  }
  puts("PASS canonical-equivalence guard for long combining sequences");
}
