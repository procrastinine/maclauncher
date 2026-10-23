# Encrypted-ticket loader ABI

Version: maclauncher-ticket-unavailable-0.1.0-universal. Native architectures: ARM64 and Intel. Minimum macOS: 13.0. License: MIT.

The library supplies five exact encrypted-ticket exports required at library load. Every ticket check and decryption request returns false. App ID and issue time are zero; identity output is an invalid eight-byte zero value. No input ticket or key bytes are read. The four-byte decrypted-length output is set to zero and the destination remains unchanged. Null outputs are accepted.

The independent implementation uses standard C++ fixed-width types and system libraries. No Valve SDK, emulator code, ticket parser, assets, key material, account or network client is included.

## Build

Building from source requires Node.js and the macOS command line compiler. The compiler is installed through `xcode-select --install`; Node.js is available from [nodejs.org](https://nodejs.org/). These tools are needed only to rebuild the supplied native library.

`node build.cjs /absolute/path/to/new/output` builds the library on macOS. The output directory must be new. The script explicitly compiles ARM64 and Intel for deployment target13.0, uses only system SDK/libraries, combines slices, signs ad hoc and writes build.json. No Steam SDK, Homebrew, gh or network request is used.

The loader contract is used by [Greenworks](https://github.com/greenheartgames/greenworks). The loader is an independent implementation and contains no Greenworks code.
