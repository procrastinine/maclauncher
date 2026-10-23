# MacLauncher offline Steam API

This MIT-licensed library supplies a finite local client API. It builds from the included C++ source without Steamworks SDK headers, SDK libraries, or emulator source. ARM64 and x86_64 slices require macOS 13 or newer.

Implemented behavior includes client initialization, local application identity and language, disconnected online and overlay status, local statistics and achievements, opaque local storage, and bounded native or manual callbacks. Factories use the declared client initializers and exact interface versions. A missing virtual implementation returns exit code 78; a version mismatch returns null. The export table declares each flat function. The encrypted-ticket loader is a separate component.

The managed client uses exact assembly checksums and import tables. Client context version021 and callback packing are distinct from the native virtual-interface consumers. Manual callback messages contain20bytes; completion703 contains16bytes. Local player-count results report unavailable and zero. Pending events and retained manual results share a limit of256; payload pointers remain valid only until release. Local storage records use maclauncher-offline-api-v1 beneath the configured application directory.

Source builds use Node.js and Apple command-line developer tools on macOS. The tools can be installed from Terminal with `xcode-select --install`. Prebuilt app users need no compiler or command-line tools. A fresh absolute output directory is required:

```sh
node build.cjs /absolute/new-output
```

The build records source and native SHA-256 identities and produces an ad-hoc signed universal library. It sets deployment13.0 explicitly and links only system libraries.

