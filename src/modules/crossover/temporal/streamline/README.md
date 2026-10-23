# Streamline camera adapter

The 64-bit Windows adapter preserves Streamline's complete interposer export
interface and forwards calls to a private copy of the game's original library.
The original remains in the same directory, preserving relative plugin lookup.
Import files are unchanged. Disabling game temporal integration restores the
private original; incompatible export interfaces retain their existing library.

The adapter copies validated perspective camera constants from `slSetConstants`
and selects them by the exact frame token and viewport passed to
`slEvaluateFeature(sl::kFeatureDLSS)`. Streamline's DLSS feature identifier is 0;
NGX uses a separate feature numbering scheme. Orthographic, oblique and shifted
projections are not submitted. Near and far distances and vertical field of view
must agree with the game's unjittered projection matrix. An unspecified far
plane is accepted only when the matrix describes an infinite perspective plane.

The selected packet is scoped to one NGX evaluation through the adapted DXMT
library's `MacLauncherSetTemporalCamera` and `MacLauncherClearTemporalCamera`
exports. Nested evaluations restore their caller's camera. Failed, missing or
mismatched constants clear the packet while retaining the original Streamline
call and return value. Camera capture adds no rendering passes or GPU waits.

The launcher detects compatible interposers beside the selected executable or
in the supported Streamline plugin directories. FSR2/3 camera availability also
requires a matching installed DXMT native library and Windows thunk, a 64-bit
Windows executable, Apple Silicon and macOS 14 or later. Game temporal
integration prepares this closure before launch, including when Game default
is selected for temporal scaling. A different renderer or an unprepared launch
does not acquire camera support through a live setting change.

CrossOver and Sikarugir retain their selected Wine engine and use matching graphics libraries
in a private view. Existing Sikarugir support libraries can supply the native
carrier and thunk. Otherwise the shared runtime download flow acquires the
selected compatible Template support archive after consent and retains only the required
DXMT libraries and notices. The runtime use lease protects this dependency
throughout play. No source compilation or second Wine engine is required.
Each engine has a DXMT support runtime section with an independent version
default and a per-game override. `../catalog.js` records compatible versions,
archive identities and exact native/thunk hashes; new rows must preserve the
complete adapter command, parameter, export and portable shader ABI. An equal
function-table length alone does not establish compatibility.

The proxy uses the official MIT-licensed Streamline 2.9.0 headers at commit
`b998246a3d499c08765c5681b229c9e6b4513348`. `build.mjs` accepts `--source`,
`--compiler`, `--reference` and `--out`; the reference is the official 64-bit
`sl.interposer.dll`. It generates forwarding entry points for every reference
export, including Direct3D, DXGI and Vulkan functions, retaining export ordinals.
Only the three typed Streamline hooks alter call handling. The source checkout
remains unchanged. The built payload includes the proxy, `provider.json` with
source and binary identities, and `Streamline-LICENSE.txt`.

`camera-test.cpp` checks perspective projection validation using the pinned
headers. `test-forwarders.mjs PAYLOAD CLANGXX OUTPUT` builds a Windows executable
and an original-library substitute to check every forwarding entry point,
ordinal and mixed register/stack argument transport.
