# FSR 4 Metal provider

The provider records FSR 4.1.1 upscaling into an existing Metal command buffer.
`rsGetTemporalProvider(1)` exposes the shared temporal frame API. Native apps and
Wine translation layers use the same provider when color, depth, motion vectors,
sampling jitter and exposure are available. Inputs use MetalFX coordinate
conventions, including motion-vector scale and optional texture regions.

The exact network uses the upstream Exact Fast profile: unchanged model weights
with relaxed arithmetic in PRE and POST. Apple GPU family 10 uses native integer
matrix operations; earlier Apple Silicon GPUs use SIMD half matrices with float
accumulation. The source includes the scalar fallback. RCAS sharpening accepts
values from zero to one. Color inputs are linear; output classes extend through
7680 × 4320. The Ultra Performance model is selected at ratios of three or above.

Resources belong under the graphics runtime's `temporal/fsr4` directory.
`provider.json` declares the ABI, source revision and completed shader variants.
The provider loads packaged Metal source, model weights and binding descriptions.
Metal creates pipelines on first use and retains them for subsequent frames.
Games do not run Python, DXC, SPIRV-Cross, Xcode tools or shell commands. The
provider has no separate panel, settings-file polling or diagnostic capture loop.
Frame identifiers are consecutive per owner. Gaps and repeated identifiers reset
temporal history; explicit reset flags also cover camera cuts and discarded
frames. Completed classic Metal command-buffer errors retire their resources and
reset history. Metal 4 queue owners report submission failures with the reset
flag because queue completion belongs to the caller.

`FSR4_ROOT` identifies the resource directory, `FSR4_BUILD_DIR` its shader/model
cache and `RESHADE_FSR4_LIBRARY` its provider library. These variables apply only
to the launched process. The library contains arm64 and x86_64 slices. Loading the
library preserves the graphics runtime's macOS 13 minimum; encoding FSR 4 requires
macOS 26 and an Apple Silicon GPU.

Developer builds use `node build.mjs <pinned-source> <output>`. The script copies
read-only upstream sources into the output directory, translates shader variants
with the upstream binary tools and builds both host architectures. A local `uv`
Python runtime and Xcode command-line compiler are required for this source build.
`--quick` emits one shader variant and marks the payload incomplete. Source pins,
the upstream release identity and nested source identities are in `source.json`.
The AMD and shader-reimplementation MIT notices accompany model resources.
