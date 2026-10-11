# MacLauncher offline Steam API

This MIT-licensed library supplies a finite local client API. It builds from the included C++ source without Steamworks SDK headers, SDK libraries, or emulator source. ARM64 and x86_64 slices require macOS 13 or newer.

Implemented behavior includes client initialization, local application identity and language, disconnected online and overlay status, local statistics and achievements, opaque local storage, and bounded native or manual callbacks. Other interface factories are available for the listed client initializers; unimplemented virtual methods terminate with exit code 78, unrecognized versions return null, and unimplemented flat functions have no export. Authentication, game servers, online player counts, multiplayer, overlays, and encrypted tickets are unavailable. The encrypted-ticket loader is a separate component.

The managed client uses exact assembly checksums and import tables. Its lazy declarations do not imply that all declared methods are implemented. Client context version021 and callback packing are distinct from the native virtual-interface consumers. Manual callback messages contain20bytes; completion703 contains16bytes. Local player-count results report unavailable and zero. Pending events and retained manual results share a limit of256; payload pointers remain valid only until release. Local storage records use maclauncher-offline-api-v1 beneath the configured application directory.

Build with Node.js and Apple command-line developer tools on macOS. The tools can be installed from Terminal with `xcode-select --install`. Prebuilt app users need no compiler or command-line tools. A fresh absolute output directory is required:

```sh
node build.cjs /absolute/new-output
```

The build records source and native SHA-256 identities and produces an ad-hoc signed universal library. It sets deployment13.0 explicitly and links only system libraries.

The independent C++ fixtures load a library path and an absolute temporary state directory. No Steam SDK is needed to compile or run them:

```sh
xcrun clang++ -std=c++17 -arch arm64 -mmacosx-version-min=13.0 contract-probe.cpp -o /absolute/core-probe
xcrun clang++ -std=c++17 -arch arm64 -mmacosx-version-min=13.0 manual-contract-probe.cpp -o /absolute/manual-probe
mkdir /absolute/new-core-state /absolute/new-manual-state
/absolute/core-probe /absolute/new-output/libsteam_api.dylib /absolute/new-core-state
/absolute/manual-probe /absolute/new-output/libsteam_api.dylib /absolute/new-manual-state
```

Use x86_64 for the Intel fixture. The core fixture accepts a third argument `unsupported` to exercise the exit78 behavior. The fixtures cover callback widths, cancellation and shutdown, local record bounds, null and incompatible arguments, queue capacity and output canaries.
