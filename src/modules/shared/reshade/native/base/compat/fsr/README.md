# FSR1 shader generation

CMake generates the SPIR-V arrays for FSR1 EASU and RCAS in the build directory,
from MacLauncher's GLSL wrapper and the pinned AMD FSR1 headers. The glslang
16.6.0 compiler it uses is built from commit
`e1b562a8bed273a02f30b59b66a5d499793cede5` of the public KhronosGroup
repository. `FSR_GLSLANG_EXECUTABLE` selects an existing glslang 16.6.0 compiler
on the host instead.

Generation requires the SHA-256 of the generated header to match the original
value recorded in `fsr1-shaders.json`. A mismatch stops the build before the
native graphics core compiles. The generated arrays retain AMD's MIT notice. At
setup, the Metal adapter translates them through SPIRV-Cross.
