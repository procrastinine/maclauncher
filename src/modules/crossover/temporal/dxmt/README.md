# DXMT camera transport

This adaptation carries game-provided camera metadata through DXMT's asynchronous
Direct3D 11 temporal-upscaling queue. Streamline camera constants are scoped to
one NGX evaluation. NGX copies them through an owned Direct3D context private-data
GUID; the context then captures the packet by value with its queued textures.
Camera values are never inferred from a rendered image or reused from another
viewport. Missing or invalid camera packets retain the original NGX behavior.

The Windows NGX library exports `MacLauncherSetTemporalCamera(const
RSTemporalCamera *)` and `MacLauncherClearTemporalCamera()`, both using the C
calling convention. Set returns 1 for a valid copied packet and 0 when it clears
an absent or invalid packet. The packet is defined in the shared
[`camera.h`](../../../shared/reshade/temporal/camera.h). Calls are scoped to the
evaluation thread; nested evaluations restore their caller's packet. The context
private-data value is also restored after synchronous submission.

DXMT's creation flags supply HDR, reversed-depth and jittered-motion semantics.
Its existing conversion of display-resolution motion vectors produces a
render-resolution motion texture, so the native packet describes that converted
texture. A provided NGX `FrameTimeDeltaInMsec` supplies the frame duration.

The native `winemetal.so` forwards the selected renderer's Unix call tables. Its
64-bit temporal entry binds the copied packet to the exact MetalFX scaler and
uncommitted command buffer using `rsSetTemporalCamera`, immediately before the
original encode. Other entries, including the 32-bit temporal entry, preserve
their original implementation. No GPU submission, wait, texture copy, camera
polling or shader compilation is added by this transport.

The adapted closure consists of matching 64-bit `d3d11.dll`, `dxgi.dll`,
`nvngx.dll` and the small native forwarding library. The original `winemetal.dll`
and native shader compiler remain required. `MACLAUNCHER_DXMT_BASE_LIBRARY` names a
private `maclauncher-dxmt-original.so` alias of the original native library. The
distinct filename avoids dynamic-library search paths resolving back to the
forwarder. The installer verifies its SHA-256 and the original
Windows thunk against `camera-bridge.json`. This source-specific adaptation is
separate from stock managed DXMT releases. Its Metal path requires macOS 14 or
later and 64-bit Wine on Apple Silicon through Rosetta.

`build.mjs DXMT_SOURCE DXMT_WINE_DIRECTORY LLVM_MINGW_BIN OUTPUT` creates an owned
source copy, applies the camera overlay, builds the Windows components with
LLVM-MinGW and builds the native forwarder with the macOS SDK. The selected
renderer's unchanged portable command library is reused from its D3D11 binary;
its digest is recorded. The build does not require rebuilding LLVM or the shader
compiler. Upstream checkouts remain unchanged.
The optional `--native-only` argument rebuilds the forwarding library and source
archive while retaining verified PE libraries from the same complete output.
It applies to native forwarding changes that leave the Windows adaptation
unchanged. The forwarding library can load on macOS 13; the selected DXMT
renderer retains its macOS 14 requirement.

DXMT source is pinned to
`7c8dee1c2d73415301ceb7d1fa810861cef4cd67`. Its `LICENSE`, `COPYING.LIB` and
`LICENSE.OLD` are retained with the adapted payload. `patch.mjs`,
`camera-transport.hpp` and `unix-forwarder.c` contain the owned adaptations;
`build.mjs` records source and binary identities in the payload manifest.
The payload's `source.tar.gz` includes the corresponding pinned source, owned
adaptations, shared headers and rebuild instructions. Compiler tools and the
unchanged managed renderer are separate build prerequisites.
