# Upstream sources

| Submodule | Source | Commit | License |
| --- | --- | --- | --- |
| ReShade | https://github.com/crosire/reshade | `7bf9de8b33bcc76c3177007e65d73c72dd0f34c0` | BSD-3-Clause |
| SPIRV-Headers, nested under ReShade | https://github.com/KhronosGroup/SPIRV-Headers | `7845730cab6ebbdeb621e7349b7dc1a59c3377be` | MIT |
| SPIRV-Cross | https://github.com/KhronosGroup/SPIRV-Cross | `300681bbcb8365a8d1eacdacdbdd0249bbf1d6b1` | Apache-2.0 or MIT |
| ReShade shader headers | https://github.com/crosire/reshade-shaders | `fd0022170615ce0d8162d219bff07232fa6dd84f` | Per-file notices; ReShade.fxh and ReShadeUI.fxh are CC0-1.0 |
| SweetFX | https://github.com/CeeJayDK/SweetFX | `93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361` | Root MIT notice; per-file licenses also apply |
| MAKO model reader, validators, LS1 translation and temporal graph | https://github.com/eugeniosegala/MAKO | `522cccbee6caafc643d2ccfa4ee5c06e4c5ba533` | GPL-3.0-or-later |
| AMD FidelityFX FSR1 | https://github.com/GPUOpen-Effects/FidelityFX-FSR | `a21ffb8f6c13233ba336352bdff293894c706575` | MIT |
| vkd3d-shader | https://codeberg.org/vkd3d/vkd3d | `fb7f9ff3c1f8d972ee6f1b8c6a92caf6c8ba1e10` | LGPL-2.1-or-later |
| qUINT, optional shader source | https://github.com/martymcmodding/qUINT | `98fed77b26669202027f575a6d8f590426c21ebd` | Copyright Pascal Gilcher / Marty McFly; all rights reserved notices |

SweetFX's `CRT.fx` carries a **GPL-2.0-or-later** notice naming cgwg, Themaister
and DOLLS. The root MIT notice does not replace that shader's license. Shader
distribution must retain the applicable source and notices. Shader packs are
runtime-loaded data and are not compiled into the native library.

The optional qUINT checkout is used to load an external bloom shader. Its notices
do not grant a general open-source redistribution license. The native library does
not embed qUINT shader code. Distribution of that shader pack requires terms that
permit the intended distribution.

Only the portable ReShadeFX expression, lexer, parser, preprocessor, symbol table
and SPIR-V generation sources are compiled. The Windows injector and renderers
are excluded. The owned `compat/malloc.h` include shim supplies macOS `alloca`
headers. The intrinsic symbol table uses `-O0` to avoid excessive compiler
optimization time. Other source files retain the selected build optimization.

CMake generates a lexer copy in the build directory that replaces the floating
`std::from_chars` call with `compat/float_literal.hpp`. The bounded C-locale parser
uses `strtof_l` to keep the macOS 13 deployment target; Apple libc++ provides the
floating `from_chars` overload only from macOS 26. The upstream file is unchanged.

Owned adapters implement resource reflection, stage-interface naming, Metal color
output padding, alpha preservation, frame interception and native launch behavior.
There are no patches inside upstream submodules. Pins must be updated deliberately
with compiler and GPU execution checks.

The CPU-only Lossless resource inspector compiles MAKO's bounded PE reader,
resource validators and hash implementation into `fx-compile`. A generated
macOS compatibility overlay maps stat timestamps, removes the unused Vulkan
error class and reuses the resource reader for optional PE version metadata.
The upstream sources remain unchanged. No proprietary DLL code is loaded and
no model resources are embedded. The combined compiler is distributed under
GPL-3.0-or-later with the MAKO notice. Complete consumed source and owned patches are available
in the tagged repository and its exact upstream Gitlinks.

The native library also compiles MAKO's temporal shader graph through an owned
Metal resource adapter. The graph source remains unchanged. The adapter performs
in-memory SPIR-V translation, explicit resource binding, opaque SDR coverage
resolution and bounded temporal-history ownership. Both the combined native
library and compiler retain GPL-3.0-or-later notices and corresponding sources.

LS1 spatial processing consumes MAKO's unchanged resource extraction, DXBC
translation interface and SPIR-V compatibility transformations. An owned loader
overlay resolves only the adjacent `libvkd3d-shader.dylib`; it does not search
Steam installations or use an environment-selected translator. The model remains
an explicitly supplied local DLL, read as data. GPU border replication and feature
cropping preserve edge pixels without modifying the model resources.

The separate vkd3d-shader 2.1 library builds the binary shader frontends from its
pinned source. Unused HLSL, effect and texture authoring frontends are excluded.
Owned frontend stubs and the generated-header provenance are recorded under
`compat/vkd3d`. That shared library retains LGPL-2.1-or-later notices and complete
corresponding source, and can be replaced by a compatible implementation.

The open MAKO spatial reconstruction shader is consumed from its pinned generated
SPIR-V header. Its original GLSL, generated header and identity hashes accompany
the native library under GPL-3.0-or-later. SPIRV-Cross translates that shader to
Metal in memory without changing its reconstruction or sharpening arithmetic.

Owned generated overlays bound the upstream process-wide archive and translated
LS1 caches by entry count and retained bytes. The parsing, file-identity checks,
model validation and translation arithmetic remain unchanged.

FSR1 consumes AMD’s unchanged EASU/RCAS headers and constant setup from the pinned
FidelityFX-FSR source. Owned GLSL supplies clamped borders, exact alpha interpolation,
resource bindings and output bounds. Its generated SPIR-V is embedded and translated
by the existing SPIRV-Cross adapter. The AMD MIT notice accompanies the headers and
generated shader array. Scratch images use a three-frame owner limit and a shared
256 MiB allocation budget; unsupported storage or capacity preserves the source.
