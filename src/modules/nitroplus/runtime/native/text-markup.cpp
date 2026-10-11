#include "text-markup.hpp"
#include <algorithm>
#include <cctype>
#include <map>
#include <stdexcept>

namespace NativeText {
namespace {
using Attributes = std::map<std::string, std::string>;
std::string lower(std::string value) {
    for (char& c : value) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
    return value;
}
bool space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }
std::string trim(std::string value) {
    auto first = value.find_first_not_of(" \t\r\n"), last = value.find_last_not_of(" \t\r\n");
    return first == std::string::npos ? "" : value.substr(first, last - first + 1);
}
[[noreturn]] void fail(const std::string& detail) {
    throw std::runtime_error("Unsupported NSS text markup: " + detail);
}
struct Tag { std::string name, raw; bool closing = false; Attributes attributes; };
Tag tag(const std::string& input, size_t& at) {
    const size_t end = input.find('>', at);
    if (end == std::string::npos || end - at > 4096) fail("unterminated or oversized tag");
    Tag result; result.raw = input.substr(at, end - at + 1);
    std::string body = trim(input.substr(at + 1, end - at - 1)); at = end + 1;
    size_t i = 0;
    if (!body.empty() && body.front() == '/') { result.closing = true; i++; }
    size_t begin = i;
    while (i < body.size() && std::isalpha(static_cast<unsigned char>(body[i]))) i++;
    result.name = lower(body.substr(begin, i - begin));
    if (result.name.empty()) fail("missing tag name");
    // PRE's positional box handle belongs to the NSS VM, not the text renderer.
    if (result.name == "pre" && !result.closing) return result;
    while (i < body.size()) {
        while (i < body.size() && space(body[i])) i++;
        if (i == body.size()) break;
        begin = i;
        while (i < body.size() && (std::isalnum(static_cast<unsigned char>(body[i])) || body[i] == '_')) i++;
        std::string key = lower(body.substr(begin, i - begin));
        while (i < body.size() && space(body[i])) i++;
        if (key.empty() || result.closing || i == body.size() || body[i++] != '=') fail("invalid " + result.name + " attribute");
        while (i < body.size() && space(body[i])) i++;
        if (i == body.size() || body[i++] != '"') fail("unquoted " + result.name + " attribute");
        begin = i;
        while (i < body.size() && body[i] != '"') i++;
        if (i == body.size()) fail("unterminated attribute");
        if (result.attributes.size() >= 16 || !result.attributes.emplace(key, body.substr(begin, i++ - begin)).second) fail("duplicate or excessive attributes");
    }
    return result;
}
}

TextParser::Text parse(const std::string& input) {
    if (input.size() > 4 * 1024 * 1024 || input.find('\0') != std::string::npos) fail("invalid text size");
    size_t at = 0;
    while (at < input.size() && space(input[at])) at++;
    if (at == input.size() || input[at] != '<') fail("missing PRE header");
    const auto opening = tag(input, at);
    if (opening.name != "pre" || opening.closing) fail("missing PRE header");
    while (at < input.size() && space(input[at])) at++;
    if (at == input.size() || input[at++] != '[') fail("missing text label");
    const auto labelEnd = input.find(']', at);
    if (labelEnd == std::string::npos || labelEnd - at > 1024) fail("invalid text label");
    at = labelEnd + 1;
    TextParser::Text output;
    TextParser::Line line;
    std::string text;
    struct Style { std::string tag, ruby, inColor, outColor; };
    std::vector<Style> styles;
    auto flush = [&] {
        if (!text.empty()) {
            TextParser::StringSegment segment; segment.Segment = text;
            for (const auto& style : styles) {
                if (!style.ruby.empty()) segment.Ruby = style.ruby;
                if (!style.inColor.empty()) segment.InColor = style.inColor;
                if (!style.outColor.empty()) segment.OutColor = style.outColor;
            }
            line.StringSegs.push_back(segment); text.clear();
        }
    };
    auto finish = [&] {
        flush();
        if (!line.StringSegs.empty()) {
            auto& first = line.StringSegs.front().Segment;
            const auto begin = first.find_first_not_of(" \t\r\n"); first = begin == std::string::npos ? "" : first.substr(begin);
            auto& last = line.StringSegs.back().Segment;
            const auto end = last.find_last_not_of(" \t\r\n"); last = end == std::string::npos ? "" : last.substr(0, end + 1);
            if (std::any_of(line.StringSegs.begin(), line.StringSegs.end(), [](const auto& segment) { return !segment.Segment.empty(); })) {
                // Preserve the ordering expected by upstream Text::Advance.
                std::reverse(line.StringSegs.begin(), line.StringSegs.end()); output.Lines.push_back(std::move(line));
            }
            line = {};
        }
    };
    bool closed = false;
    while (at < input.size()) {
        const char c = input[at];
        if (c == '<') {
            const auto control = tag(input, at);
            if (control.name == "pre" && control.closing) {
                if (!styles.empty()) fail("unclosed text style");
                finish(); closed = true; break;
            }
            if (control.name == "k" && !control.closing && control.attributes.empty()) { finish(); continue; }
            if (control.name == "font" || control.name == "ruby") {
                flush();
                if (control.closing) {
                    if (styles.empty() || styles.back().tag != control.name) fail("mismatched text style");
                    styles.pop_back(); continue;
                }
                if (styles.size() >= 16) fail("text styles exceed nesting limit");
                Style style; style.tag = control.name;
                if (control.name == "ruby") {
                    if (control.attributes.size() != 1) fail("RUBY requires one reading attribute");
                    style.ruby = control.attributes.begin()->second;
                } else {
                    for (const auto& item : control.attributes) {
                        if (item.second.size() != 7 || item.second.front() != '#' ||
                            !std::all_of(item.second.begin() + 1, item.second.end(), [](unsigned char c) { return std::isxdigit(c); })) fail("invalid FONT color");
                        if (item.first == "color" || item.first == "incolor") style.inColor = item.second;
                        else if (item.first == "outcolor") style.outColor = item.second;
                        else fail("unknown FONT attribute");
                    }
                    if (style.inColor.empty() && style.outColor.empty()) fail("FONT has no colors");
                }
                styles.push_back(style); continue;
            }
            if (control.name == "i" && !control.closing && control.attributes.empty()) {
                // Older NSS sources emit an empty initialization marker at the
                // start of a newly created text object. Nonempty variants need
                // a separately reviewed profile rather than discarded content.
                size_t end = at; while (end < input.size() && space(input[end])) end++;
                if (end == input.size() || input[end] != '<') fail("nonempty I control");
                const auto close = tag(input, end);
                if (close.name != "i" || !close.closing) fail("nonempty I control");
                at = end; continue;
            }
            if (control.name == "voice" && !control.closing) {
                if (!trim(text).empty() || !line.StringSegs.empty()) finish();
                for (const auto& item : control.attributes) if (item.first != "name" && item.first != "class" && item.first != "src" && item.first != "mode") fail("unknown voice attribute");
                const auto src = control.attributes.find("src");
                if (src == control.attributes.end() || src->second.empty()) fail("voice has no source");
                const auto value = [&](const std::string& key) { const auto it = control.attributes.find(key); return it == control.attributes.end() ? std::string() : it->second; };
                line.VoiceAttrs = { value("name"), value("class"), value("src"), value("mode") }; continue;
            }
            fail(control.raw);
        }
        if (c == '&') {
            ++at;
            // Authored dialogue also contains literal ampersands, including
            // deliberately garbled words. Only punctuation is escaped.
            if (at == input.size() || !std::ispunct(static_cast<unsigned char>(input[at])) || input[at] == '<' || input[at] == '>') {
                text.push_back('&'); continue;
            }
            text.push_back(input[at++]); continue;
        }
        if (c == '\r' || c == '\n') {
            if (c == '\r' && at + 1 < input.size() && input[at + 1] == '\n') at++;
            at++;
            size_t next = at; while (next < input.size() && (input[next] == ' ' || input[next] == '\t')) next++;
            if (next < input.size() && (input[next] == '\r' || input[next] == '\n')) { finish(); at = next; }
            else if (!text.empty() && static_cast<unsigned char>(text.back()) < 128 && next < input.size() && static_cast<unsigned char>(input[next]) < 128 && input[next] != '<') text.push_back(' ');
            continue;
        }
        text.push_back(c == '\t' ? ' ' : c); at++;
    }
    if (!closed) fail("missing closing PRE");
    while (at < input.size() && space(input[at])) at++;
    if (at != input.size()) fail("content after PRE");
    return output;
}
}
