# FSR1 shader generation

For FSR1 spatial upscaling, the spatial encoder uses AMD's EASU (upscaling) and
RCAS (sharpening) shaders, which are compiled to SPIR-V arrays. CMake generates
these arrays in the build directory from MacLauncher's GLSL wrapper and the AMD
FSR1 headers at their recorded commit. The glslang 16.6.0 compiler used for this
is built from commit `e1b562a8bed273a02f30b59b66a5d499793cede5` of the public
KhronosGroup repository; `FSR_GLSLANG_EXECUTABLE` can instead select an existing
glslang 16.6.0 compiler on the host.

The generated header must match the original SHA-256 value recorded in
`fsr1-shaders.json`, and a mismatch stops the build before the native graphics
core compiles. The generated arrays retain AMD's MIT notice. At setup, the Metal
adapter translates them through SPIRV-Cross.
