# Streamline camera

MacLauncher's FSR 2 and FSR 3 upscalers need the game's camera data. A game
that calls DLSS through NVIDIA Streamline passes this data to Streamline in
`slSetConstants`; Streamline's DLSS plugin gives NGX no camera.

MacLauncher never replaces a game's Streamline interposer
(`sl.interposer.dll`). A game can check the interposer's NVIDIA signature with
`sl::security::verifyEmbeddedSignature` before loading it, and a game whose
check fails turns Streamline off, including DLSS and Reflex.

## DXVK and vkd3d-proton DLSS route

On the Vulkan DLSS route (`../vulkan-dlss.js`), with DXVK or vkd3d-proton on a
carrier driver, the camera is captured inside the game process by MacLauncher's
NGX core, which the game's own Streamline DLSS plugin loads. When the core
initializes, it installs in-memory detours on the game's interposer, the loaded
module that exports Streamline's application API (`slInit`,
`slGetNewFrameToken`, `slSetConstants` and `slEvaluateFeature`). The file on
disk stays unchanged.

- `slSetConstants` copies validated perspective camera constants for its exact
  frame token and viewport.
- `slEvaluateFeature(sl::kFeatureDLSS)` selects the copy of its frame token and
  viewport as the camera of the NGX evaluations it makes on its thread, calls
  the original function and restores the previous camera, so nested evaluations
  keep their caller's camera. Streamline's DLSS feature identifier is 0,
  whereas NGX uses a separate feature numbering scheme.
- Both detours return the original result unchanged. Capture adds one 64-byte
  copy per call under a short reader-writer lock, no rendering pass and no GPU
  wait.

The core adds the selected camera to that evaluation's temporal frame. The
detours, the validation and the pinned MinHook library that installs them are
part of the core's source in MacLauncher Builds
(`producers/vkd3d-proton/ngx_streamline.cpp` and `streamline_camera.hpp`).

Orthographic, oblique and shifted projections are not submitted. For other
projections, the near and far distances and the vertical field of view must
agree with the game's unjittered projection matrix, and an unspecified far
plane is accepted only when the matrix describes an infinite perspective plane.
Constants that fail validation, are missing or do not match the evaluation's
frame and viewport leave that evaluation without a camera.

`index.js` `interposer()` identifies the game's interposer by its application
API exports, beside the selected executable or in the supported Streamline
plugin directories. `../index.js` `resolveVulkanCameraPlan` then declares camera
projection whenever the route forwards, without a setting, and the game starts
from its own folder.

## DXMT and D3DMetal

On DXMT and D3DMetal, DLSS through Streamline runs without a camera. DXMT's
adapted NGX and D3DMetal's own NGX receive the game's DLSS evaluations, so
MetalFX Temporal is available through game temporal integration, and FSR 2 and
FSR 3 are not.

## Interposer proxy sources

`proxy.cpp`, `camera.hpp`, `resources.hpp`, `snapshots.hpp`,
`snapshot-budget.hpp` and `camera-test.cpp` are the sources of the interposer
proxy that graphics packages up to 0.3.13 include. No launch route places the
proxy. It is built from the official MIT-licensed Streamline 2.9.0 headers at
commit `b998246a3d499c08765c5681b229c9e6b4513348`.
