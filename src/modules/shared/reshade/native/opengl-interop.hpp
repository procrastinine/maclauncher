#pragma once
#include <OpenGL/OpenGL.h>
#include <memory>
namespace macfx {
// The caller binds and locks the context, saves GL state and owns presentation.
class OpenGLInterop {
public:
    explicit OpenGLInterop(CGLContextObj context,bool presentation=false);
    ~OpenGLInterop();
    void render(unsigned width, unsigned height);
    void clear();
    void resetHistory();
    // A destroyed or unbindable context owns reclamation of its GL names.
    // Release the independent host resources without touching another context.
    void abandon() noexcept;
private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};
}
