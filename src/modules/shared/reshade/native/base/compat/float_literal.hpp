#pragma once
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <locale.h>
#include <xlocale.h>
#include <string>

namespace macfx {
// ReShade's decimal tokens need an explicit C locale. Floating from_chars in
// Apple's libc++ requires macOS 26; strtof_l preserves the older system floor.
// Bound the input and leave the destination unchanged for invalid/overflowing
// values, matching the from_chars call used by the lexer. Representable
// subnormal floats remain valid even when libc reports an underflow warning.
inline bool parseFloatLiteral(const char *begin,const char *end,float &output) {
    if(begin==end || *begin=='+' || (*begin!='-' && *begin!='.' && (*begin<'0' || *begin>'9'))) return false;
    static const locale_t decimalLocale=newlocale(LC_NUMERIC_MASK,"C",nullptr);
    if(!decimalLocale) return false;
    const std::string text(begin,end); char *tail=nullptr;
    const int previousError=errno;errno=0;
    const float value=strtof_l(text.c_str(),&tail,decimalLocale);
    const int error=errno;errno=previousError;
    if(tail==text.c_str() || (error==ERANGE && (value==0 || !std::isfinite(value)))) return false;
    output=value;return true;
}
}
