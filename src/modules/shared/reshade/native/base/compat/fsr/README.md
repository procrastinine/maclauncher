# FSR1 shader generation

The spatial encoder uses AMD FidelityFX FSR1 EASU and RCAS from the pinned
`third_party/fsr` submodule. The owned GLSL wrapper defines resource bindings,
clamped edge reads, exact alpha interpolation and output bounds. It leaves the
upstream headers unchanged.

Ordinary builds use `fsr1-shaders.hpp`; no shader compiler is downloaded or run.
To regenerate after a shader change, use glslang 16.6.0:

```sh
node compat/fsr/generate.mjs --glslang /path/to/glslang
node compat/fsr/generate.mjs --glslang /path/to/glslang --check
```

The script runs offline, removes its temporary files and records source and
SPIR-V hashes in `fsr1-shaders.json`. The generated arrays retain AMD's MIT
notice. The Metal adapter translates these arrays through SPIRV-Cross at setup.

The native pixel tests compare reconstruction and sharpening against an
independent scalar reference, including clamped borders, alpha, odd dimensions
and both CPU architectures. The reference uses explicit fused coordinate
arithmetic to select the same integer tap grid as the GPU across architectures.
