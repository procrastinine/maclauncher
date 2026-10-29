# FSR4 Metal provider

The provider records FSR4.1.1 temporal upscaling into borrowed Metal commands.
`rsGetTemporalProvider(1)` exposes the common temporal frame API. Native scene
producers and translated renderers use the same color, depth, motion, jitter,
exposure and ROI contract. Camera FOV, view and projection matrices are not inputs
to this provider. The source color is linear RGB.

Three profiles select distinct upstream models and execution policies:

| Profile | Model and execution |
| --- | --- |
| Exact Fast | Original AMD coefficients with relaxed PRE/POST arithmetic; inference every frame. This is the default. |
| Lite | Upstream folded coefficients, rounding and guarded inference reuse. |
| Lite2 | Lite execution with six trained integer-weight layers for the normal model family. Ultra Performance retains the unchanged Lite model. |

Profile selection uses `RSTemporalFrame.reserved`: zero or one selects Exact Fast,
two selects Lite and three selects Lite2. The optional
`rsTemporalProviderProfiles(method)` returns the supported-index bitmask. Earlier
immutable Exact Fast payloads retain their original source identity and expose
only that profile. A missing profile never silently selects another model.

Apple GPU family 10 uses native integer matrix operations on macOS26 or later; earlier Apple Silicon
GPUs use SIMD half matrices with float accumulation. A GPU scalar implementation
remains available when the SIMD path cannot be created. No CPU inference path is
used. RCAS sharpening accepts zero to one. Output extends through 7680 × 4320.
Ratios of three or above use the upstream Ultra Performance model family.

`rsPrepareTemporalResources` requests bounded background resource preparation
without consuming source frame IDs, encoding pixels or advancing history. Encode
also starts preparation if needed and returns BUSY until the matching resources
are ready. An accepted resource set remains independent while another profile or
geometry prepares. Render calls use prepared pipelines, images and a bounded
constant-slot pool; they do not start compilers or wait for preparation. Original
network RGB is composed with GPU-resized source alpha into the actual output ROI.

Frame IDs are consecutive per owner. Gaps, repeated IDs, explicit resets and
profile changes reset temporal history. Classic command-buffer failures retire
their resources and reset history. Metal4 owners report submission failures with
a reset because queue completion belongs to the caller. Resource retirement uses
the exact GPU completion token; missing completion does not free in-flight work.

Resources live in the selected graphics payload's `temporal/fsr4` directory.
`provider.json` records supported profiles, source/model identities, owned source
hashes and the runtime file inventory. `FSR4_ROOT`, `FSR4_BUILD_DIR` and
`RESHADE_FSR4_LIBRARY` bind that installed closure to the launched process. The
provider contains arm64 and x86_64 slices. Library loading supports macOS13;
encoding requires macOS15 and an Apple Silicon GPU, independently of process ISA.

A source build uses `node build.mjs SOURCE OUTPUT --tools TOOLS --lite2-weights
WEIGHTS --lite2-license LICENSE`. The recipe copies the pinned read-only source,
applies owned adaptations, translates portable MSL and builds both architectures.
An existing local `uv` Python3.12 runtime and Xcode command-line compiler are build
dependencies. `--quick` builds one shader-input variant per profile and marks the
output incomplete. `--base-payload` can reuse the declared earlier Exact Fast
shader identity; native model blobs are regenerated from the pinned source.

Lite2's original GPL-2.0-or-later archive remains in `OUTPUT/source-inputs` for
source delivery. Only consumed generated model binaries and the original license
enter the runtime. AMD, shader-reimplementation and Lite2 notices retain their
separate identities. Their exact sources are declared in `source.json`.

`--repackage` rebuilds the provider from owned source while retaining an existing
complete shader/model closure. It checks the prior file hashes, source pin,
translation inputs and profile contracts; model or shader adaptations require a
full build. The macOS15 floor follows the guarded shader-math API and Metal3 SIMD
path. Metal4 tensors, argument tables and residency APIs retain macOS26 guards.
