#pragma once
#include <cwchar>
#include <cstring>
#include <cstdlib>
#include <cstdint>
#define _countof(array) (sizeof(array) / sizeof((array)[0]))
#if RS_FSR3
#include <FidelityFX/host/ffx_util.h>
#endif
// Windows CRT spelling used only for bounded diagnostic/binding name arrays.
template <size_t N> inline int wcscpy_s(wchar_t (&dst)[N], const wchar_t *src) {
    if (!src || std::wcslen(src) >= N) { dst[0] = 0; return 1; }
    std::wcscpy(dst, src); return 0;
}
