// Generic NSS choice-state traversal for the pinned LGPL libnpengine host.
// State containers can contain arbitrary named textures, nested groups and
// nonvisual callbacks. No authored child name or game identity is assumed.
#ifndef MACLAUNCHER_NATIVE_CHOICE_STATE_HPP
#define MACLAUNCHER_NATIVE_CHOICE_STATE_HPP

#include "Choice.hpp"
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace NativeChoiceState {
constexpr std::size_t MaxDepth = 32;
constexpr std::size_t MaxObjects = 4096;

template<class F>
void visit(ObjectHolder_t& holder, const F& function, std::size_t depth, std::size_t& objects) {
    if (depth > MaxDepth) throw std::runtime_error("NSS choice state exceeds its nesting limit");
    holder.Execute("*", [&](Object** entry) {
        if (!entry || !*entry) return;
        if (++objects > MaxObjects) throw std::runtime_error("NSS choice state exceeds its object limit");
        if (auto texture = dynamic_cast<Texture*>(*entry)) function(texture);
        else if (auto group = dynamic_cast<Name*>(*entry)) visit(*group, function, depth + 1, objects);
    });
}

template<class F>
void each(Choice& choice, const std::string& state, const F& function) {
    auto container = dynamic_cast<Name*>(choice.Read(state));
    if (!container) return;
    std::size_t objects = 0;
    visit(*container, function, 0, objects);
}

inline void fade(Choice& choice, const std::string& state, int opacity) {
    each(choice, state, [opacity](Texture* texture) { texture->Fade(0, opacity); });
}

inline bool hasTextures(Choice& choice, const std::string& state) {
    bool present = false;
    each(choice, state, [&](Texture*) { present = true; });
    return present;
}

inline bool contains(Choice& choice, int x, int y) {
    bool selected = false;
    each(choice, "MouseUsual", [&](Texture* texture) {
        const auto left = texture->GetX(), top = texture->GetY();
        const auto width = texture->GetWidth(), height = texture->GetHeight();
        if (width > 0 && height > 0 && x >= left && y >= top &&
            int64_t(x) < int64_t(left) + width && int64_t(y) < int64_t(top) + height) selected = true;
    });
    return selected;
}

inline bool center(Choice& choice, int& x, int& y) {
    bool found = false;
    int64_t left = 0, top = 0, right = 0, bottom = 0;
    each(choice, "MouseUsual", [&](Texture* texture) {
        const auto width = texture->GetWidth(), height = texture->GetHeight();
        if (width <= 0 || height <= 0) return;
        const int64_t a = texture->GetX(), b = texture->GetY(), c = a + width, d = b + height;
        if (!found) { left = a; top = b; right = c; bottom = d; found = true; }
        else { left = std::min(left, a); top = std::min(top, b); right = std::max(right, c); bottom = std::max(bottom, d); }
    });
    if (found) { x = static_cast<int>(left + (right - left) / 2); y = static_cast<int>(top + (bottom - top) / 2); }
    return found;
}

inline Choice* containingChoice(ObjectHolder_t& root, std::string handle) {
    for (std::size_t depth = 0; depth <= MaxDepth && !handle.empty(); ++depth) {
        if (auto choice = dynamic_cast<Choice*>(root.Read(handle))) return choice;
        const auto slash = handle.rfind('/');
        if (slash == std::string::npos) return nullptr;
        handle.resize(slash);
    }
    return nullptr;
}
}
#endif
