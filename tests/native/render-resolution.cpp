#include "resolution-scale.hpp"
#include <cstdio>
#include <exception>

int main() {
    try {
        const auto initial=macfx::renderSourceSize(1920,1080,1280,720);
        const auto resized=macfx::renderSourceSize(1280,720,1280,720);
        const auto fullscreen=macfx::renderSourceSize(3840,2160,3840,2160);
        const auto small=macfx::renderSourceSize(320,240,320,240);
        const auto pending=macfx::renderSourceSize(0,0,1280,720);
        std::printf("%d %.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f\n",macfx::resolutionRequested(),
            initial.width,initial.height,resized.width,resized.height,fullscreen.width,fullscreen.height,
            small.width,small.height,pending.width,pending.height);
        return 0;
    } catch(const std::exception &error) {std::fprintf(stderr,"%s\n",error.what());return 1;}
}
