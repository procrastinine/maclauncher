#pragma once
#include <cstdio>
#include <cwchar>
#include <cstring>
#include <cstdlib>
#include <cstdint>
#define _countof(array) (sizeof(array)/sizeof((array)[0]))
#ifndef sprintf_s
#define sprintf_s std::snprintf
#endif
template<size_t N> inline int wcscpy_s(wchar_t (&target)[N],const wchar_t *source){if(!source||std::wcslen(source)>=N){target[0]=0;return 1;}std::wcscpy(target,source);return 0;}
