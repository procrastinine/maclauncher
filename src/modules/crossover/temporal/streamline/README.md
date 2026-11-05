# Streamline camera adapter

MacLauncher's FSR 2 and FSR 3 upscalers need the game's camera data. A game
that calls DLSS through NVIDIA Streamline already passes this data to
Streamline, so this adapter hands it on. The adapter is a 64-bit Windows library
that preserves Streamline's complete interposer export interface and forwards
calls to a private copy of the game's original library. That original stays in
the same directory, so relative plugin lookup keeps working, and import files
are unchanged. Disabling game temporal integration restores the private
original, while a game whose export interface is incompatible keeps its existing
library.

The adapter copies validated perspective camera constants from `slSetConstants`
and selects them by the exact frame token and viewport passed to
`slEvaluateFeature(sl::kFeatureDLSS)`. Streamline's DLSS feature identifier is 0,
whereas NGX uses a separate feature numbering scheme. Orthographic, oblique and
shifted projections are not submitted. For other projections, the near and far
distances and the vertical field of view must agree with the game's unjittered
projection matrix, and an unspecified far plane is accepted only when the matrix
describes an infinite perspective plane.

The selected constants then travel to DXMT as one camera packet. The adapted
DXMT library's `MacLauncherSetTemporalCamera` and
`MacLauncherClearTemporalCamera` exports limit the packet to one NGX evaluation,
and nested evaluations restore their caller's camera. When constants fail
validation, are missing or do not match, the packet is cleared, but the original
Streamline call and its return value are kept. Camera capture adds no rendering
passes or GPU waits.

The launcher detects compatible interposers beside the selected executable or
in the supported Streamline plugin directories. Camera data for FSR2/3 also
requires a matching installed DXMT native library and Windows thunk, a 64-bit
Windows executable, Apple Silicon and macOS 14 or later. Game temporal
integration prepares these components before launch, including when Game
default is selected for temporal scaling. A live setting change, however, does
not add camera support to a launch that uses a different renderer or was not
prepared this way.

CrossOver and Sikarugir keep their selected Wine engine and use matching graphics
libraries in a private view. The native library and thunk can come from existing
Sikarugir support libraries. Otherwise, after consent, the shared runtime
download flow acquires the selected compatible Template support archive and
keeps only the required DXMT libraries and notices. Throughout play, a runtime
use lease marks this dependency as in use and protects it. No source compilation
or second Wine engine is required.

Each engine has a DXMT support runtime section with an independent version
default and a per-game override. `../catalog.js` records the compatible
versions, archive identities and exact native/thunk hashes. A new row must
preserve the complete adapter command, parameter, export and portable shader
ABI, because an equal function-table length alone does not establish
compatibility.

The proxy is built from the official MIT-licensed Streamline 2.9.0 headers at
commit `b998246a3d499c08765c5681b229c9e6b4513348`. `build.mjs` accepts
`--source`, `--compiler`, `--reference` and `--out`, where the reference is the
official 64-bit `sl.interposer.dll`. The build generates forwarding entry points
for every reference export, including Direct3D, DXGI and Vulkan functions, and
retains the export ordinals. Only the three typed Streamline hooks alter call
handling. The source checkout remains unchanged, and the build output includes
the proxy, `provider.json` with source and binary identities, and
`Streamline-LICENSE.txt`.

`camera-test.cpp` checks perspective projection validation with the same
Streamline headers.
