# FSR4 Metal provider

The provider records FSR4.1.1 and FSR4.1.2 temporal upscaling into borrowed Metal commands.
`rsGetTemporalProvider(1)` exposes the common temporal frame API. Native scene
producers and translated renderers use the same color, depth, motion, jitter,
exposure and ROI contract. Camera FOV, view and projection matrices are not inputs
to this provider. The source color is linear RGB.

Profiles select distinct upstream models and execution policies:

| Profile | Model and execution |
| --- | --- |
| Exact Fast | Original AMD coefficients with relaxed PRE/POST arithmetic; inference every frame. This is the default. |
| Lite | Upstream folded coefficients, rounding and guarded inference reuse. |
| Lite2 | Lite execution with six trained integer-weight layers for the normal model family. Ultra Performance retains the unchanged Lite model. |

Additional profiles are FSR 4.1.2 Lite, FSR 4.1.2 Lossy and FSR 4.1.2 Lite Lossy.

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
`provider.json` records supported profiles, source/model identities and the
runtime file inventory. `FSR4_ROOT`, `FSR4_BUILD_DIR` and `RESHADE_FSR4_LIBRARY`
bind that installed closure to the launched process. The provider contains arm64
and x86_64 slices. Library loading supports macOS13;
encoding requires macOS15 and an Apple Silicon GPU, independently of process ISA.

MacLauncher Builds builds the provider with its
[FSR4 recipe](https://github.com/procrastinine/maclauncher-builds/tree/main/producers/package-support/src/modules/shared/reshade/temporal/fsr4).

The build keeps Lite2's original GPL-2.0-or-later archive with its source inputs
for source delivery. Only consumed generated model binaries and the original license
enter the runtime. AMD, shader-reimplementation and Lite2 notices retain their
separate identities. Their exact sources are declared in `source.json`.

The macOS15 floor follows the guarded shader-math API and Metal3 SIMD
path. Metal4 tensors, argument tables and residency APIs retain macOS26 guards.

FSR 4.1.2 profiles use additional reserved indices: `int8-lite` (4),
`lossy2-412` (5), and `int8-lite-lossy` (6). Legacy Exact Fast, Lite and Lite2
retain indices 0/1, 2 and 3, their saved IDs and model coefficients. The updated
Lossy model uses the October 29 trained weights and depth-edge speck clamp in a
separate profile. Legacy Lite2 resources use a separate build namespace.

AMD's 4.1.2 Lite data and 170 translated shaders come from the original
fsr4-native-macos v3.2 release zip. Installation follows explicit consent or a
local import and prepares the data in the launcher profile with the included
interpreter in isolated mode. Preparation never uses system Python, PATH, a user virtual environment or development tools. The provider package contains the MIT preparation code. It does
not contain the restricted Lite initializers or translated shaders. Lite Lossy
also uses the separately pinned GPL training release, read statically with the
upstream macOS DXC helper from the verified kit. No Windows DLL is executed.
A matching local `fsr412_model` folder and sibling `fsr412_lossy` data can be
imported without a download. A usable installed profile never asks for consent.

The shared frame API serves native MetalFX, Godot, DXMT, NGX, FidelityFX and
explicit scene producers. The provider has no Wine-specific input path.
M1–M4 SIMD uses exact Winograd for eligible CNB16/FNB32 kernels, vector integer
epilogues and shared CT2D weights. Lite POST uses upstream's shared color tile.
Per-subpixel trained biases, conditional first-tap biases and native/shader cache
revision checks follow the v3.2 source. Original/tiled experimental profiles and
optional pixelization/new-look controls are separate upstream options.

Archive import checks the selected release archive digest and extracts it with path and size limits. The model directory and installed file record are derived from the archive contents. The app contains no per-file download hash inventory. Local directory imports are checked for the initializer/Metal-source interfaces consumed by preparation.
