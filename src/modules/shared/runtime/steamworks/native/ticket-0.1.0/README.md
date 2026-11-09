# Encrypted-ticket loader ABI

Version: maclauncher-ticket-unavailable-0.1.0-universal. Native architectures: ARM64 and Intel. Minimum macOS: 13.0. License: MIT.

The library supplies five exact encrypted-ticket exports required at library load. Every ticket check and decryption request returns false. App ID and issue time are zero; identity output is an invalid eight-byte zero value. No input ticket or key bytes are read. The four-byte decrypted-length output is set to zero and the destination remains unchanged. Null outputs are accepted.

The independent implementation uses standard C++ fixed-width types and system libraries. No Valve SDK, emulator code, ticket parser, assets, key material, account or network client is included.

## Build

[MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/helper-builds/steam-ticket-loader.json) compiles the [source](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/shared/runtime/steamworks/native/ticket-0.1.0/source/ticket.cpp) for ARM64 and Intel with deployment target 13.0, uses only system SDK libraries, combines the slices and signs the result ad hoc. No Steam SDK or network request is used.

The loader contract is used by [Greenworks](https://github.com/greenheartgames/greenworks). The loader is an independent implementation and contains no Greenworks code.
