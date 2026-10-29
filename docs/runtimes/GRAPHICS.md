# Shared graphics processing

The [graphics guide](../GRAPHICS.md) describes the single chain editor, shared
shader library, resizing, neural models and output controls. The
[pipeline reference](../GRAPHICS_PIPELINE.md) documents module and frame APIs.
This reference describes renderer-specific controls and acquisition.

The included CRT effect's parameters are CRT strength, Simulated content height,
Scanline beam width, Scanline darkness, Pixel softness, Phosphor glow, Screen
curvature, Rounded corners, Edge shading and Screen edge fade. The default
simulated content height of 240 retains 240-row spacing as the window changes
size; 0 follows the render target. Shader parameters preserve their original
labels, ranges and defaults per row.

## Scene depth

Depth effects use the depth texture corresponding to the displayed image. Native
Metal captures a stored, shader-readable attachment from the same command buffer;
hardware OpenGL uses the window's depth buffer. Renderers that discard depth or
keep it in a separate scene path use an explicit depth integration.

`rsProcessFrameWithDepth` and `rsSubmitFramePresenterWithDepth` accept matching
R32Float or Depth32Float textures with the color frame's device, dimensions,
identity and origin. Depth32Float converts on the GPU. The effect's projection,
reverse-Z, logarithmic depth and orientation settings follow the game. Custom
ReShade effects can override the compiler's forward-depth definitions.

## Presentation

Native Metal, hardware OpenGL and Core Animation publishers use the shared window
adapter. Browser hosts, iOS layers and explicit runtime textures use their
corresponding adapters. The effects pipeline keeps textures on the GPU and
preserves native window, resizing and fullscreen controls. Completed Quartz
bitmaps upload once before processing.

The native frame encoder accepts source/output textures, frame identity and color
metadata. Callers retain GPU ordering, resource lifetime and presentation.
Runtime declarations and programmatic controls are described in the
[pipeline reference](../GRAPHICS_PIPELINE.md#runtime-and-frame-adapters).

### Spatial scaling

**MetalFX Spatial**, **FSR 1**, LS1 and standard filters process the current image.
FSR1 uses AMD EASU reconstruction and RCAS sharpening, with **Sharpness** from
0 to 1. Each FSR1 pass handles perceptual SDR scaling of up to twice the source
dimensions per axis and preserves alpha. Larger spatial ratios run as successive
passes of the same method, each at most 2× per axis. MAKO supplies sharpened cubic; neither it nor FSR1
needs model files. LS1 uses imported Lossless Scaling models.

Auto preserves game rendering size. **Game resolution** requests a smaller
source through the renderer's source adapter while retaining the output window.
For example, a 50% source for 1920 × 1080 renders at 960 × 540. Explicit **Downsample** rows reduce completed images before subsequent effects.
Row **Output size** sizes each row independently. Retina, resizing and
fullscreen follow the current physical output dimensions.

The Godot adapter changes root 3D render scale with Forward+ or Mobile outside
XR, retaining the window drawable and 2D interface. **Source filter** chooses
Game original, Bilinear, MetalFX Spatial or FSR 1 before interface composition.
While its temporal integration owns the source scaler, source filtering uses Game original. Compatibility retains the game's
existing scale.

### Temporal upscaling

Temporal implementations share matching scene color, depth, motion vectors and
jitter. Camera and other extra inputs follow the selected algorithm's contract.
The [provider reference](../graphics/PROVIDERS.md) maps MetalFX, FSR, ASR, SGSR2,
XeSS and neural reconstruction to their inputs and outputs.
**Game default** retains the original scaler. FSR3 here selects upscaling;
frame generation is a separate row.

Native MetalFX integrations and the shared temporal frame API supply these inputs
directly. FSR 4.1 runs on macOS 15 or later with an Apple GPU family 7 or newer
device; its Metal Performance Primitives path requires macOS 26 and Apple GPU
family 10 or newer. Temporal rows use matching scene inputs supplied by the active renderer integration.

The Godot Metal compositor supplies its actual root-scene textures through the
shared scene API. Perspective projection adds near/far/FOV metadata; guide
submission is separate from that optional camera description. Compatibility,
viewport selection and multiview behavior follow the helper's declared source
contract. Camera preparation retains the game's render scale. Other engines can
publish the same shared scene contract through their own adapters.

CrossOver and Sikarugir use DXMT or D3DMetal NVAPI/NGX integration. Selecting a
shared temporal method enables that integration at launch; the game's DLSS option
also supplies its inputs. **Game temporal integration** enables MetalFX Temporal
with later live method selection. These paths run the selected Metal scaler.
Streamline camera constants are supplied by the included DXMT camera integration
with matching DXMT components. The game controls temporal rendering resolution.
Compatible providers and their settings change live through an existing scene
connection. Establishing a different game-facing interception API can require
a new process; the selected algorithm alone does not impose that condition.

### Frame generation

An LSFG row's **Frame multiplier** selects 2×, 3×, 4× or 5×; turning the row off
stops generation. For example, 3× requests two generated
images per real frame, taking a 30 fps source toward 90 fps. Quality or
Performance, 16-bit or 32-bit precision, and motion-estimation scale tune workload.
Adaptive pacing varies generation up to the chosen multiplier and a 30–240 fps
target, bounded by display refresh. Smooth cadence favors even presentation.
These controls change delivered images independently of game simulation.

LSFG works with native windows, browser surfaces, iOS layers and explicit frame
presenters. It uses opaque frames with display-driven timing. Ordinary 8-bit
sRGB input uses the original SDR kernels; HDR and wide-gamut input use the
original HDR generation kernel, as described in the
[provider reference](../graphics/PROVIDERS.md#frame-generation). An application's
explicit presentation timestamps retain its real-frame path. Model selections,
scaling and frame-generation controls update during play.

## Lossless Scaling setup

Runtimes → Graphics → **Upscaling** manages LS1 and LSFG models from a
purchased [Lossless Scaling](https://store.steampowered.com/app/993090/Lossless_Scaling/)
copy. MetalFX, FSR, sharpened cubic and ordinary shaders operate independently.

- **Import Lossless Scaling DLL…** reads a local DLL without executing or changing
  it, including a copy installed through CrossOver.
- **Find in Steam / CrossOver** searches conventional libraries, recorded Steam
  libraries, Steam depot downloads and standard CrossOver bottles. This stays
  offline; other locations use Import.
- **Download from Steam…** requests the Windows depot through the installed Mac
  Steam client and imports its models when complete. The signed-in account owns
  Lossless Scaling. Steam keeps its download; cancelling stops waiting and
  automatic import. A later local search can import the completed download.
- **Use SteamCMD…** obtains Valve's macOS SteamCMD and opens Terminal for sign-in
  and Steam Guard. This is the automatic route without Mac Steam. Its sign-in is
  separate, and Rosetta is requested if needed. Models import automatically;
  temporary downloads and sign-in files are removed on completion or cancellation.

MacLauncher receives neither the Steam password nor Steam Guard code. Acquisition
needs no Wine installation and starts only from the selected download action.
Imported labels include a short hash to distinguish DLLs with the same publisher
version. The first import becomes default; later imports preserve an explicit
default. Each game and effect row can select a different installed version.

## Local model storage

Models are shared across games and work offline. Reload reads local storage.
Importing another version during play makes it available immediately. Active
copies remain reserved until their game releases them; removal preserves the
original DLL. Reimporting repairs an incomplete stored copy.

`src/modules/shared/reshade/models.js` provides `importModel`, `listInstalled`,
`resolveModel` and `removeModel`. Acquisition uses `model-sources.js` and
`steam-models.js`, followed by the same import validation. Owned copies are
verified by SHA-256 before use. Neural `.dlssmodel` packages have a separate
library under Runtimes → Graphics → **Neural models**, described in the
[graphics guide](../GRAPHICS.md#neural-models).
