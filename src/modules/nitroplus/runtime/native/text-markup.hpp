#pragma once
#include "TextParser.hpp"

namespace NativeText {
// NSS PRE blocks have their own text and click/voice markup, rather than XML.
// Unknown controls fail explicitly; parsing never aborts the native process.
TextParser::Text parse(const std::string& input);
}
