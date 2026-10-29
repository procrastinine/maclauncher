# FidelityFX API adapter

The proxy preserves the five FidelityFX API 1.0.1 exports and original context,
descriptor, callback and return-code behavior. The declared SDK is 1.1.4;
the original DLL's embedded file version is 1.0.1.41314. These are separate versions.

The build uses the exact SDK and SDL commits declared in `source.json`:

```sh
node build.mjs --sdk-source SDK_CHECKOUT --vulkan-source SDL_CHECKOUT \
  --compiler MINGW_CLANGXX --backend vk --out OUTPUT_DIRECTORY
```

The default original is read from the pinned SDK's Git object at its declared
relative path and verified against its SHA-256. A sparse checkout needs no
separately installed reference DLL. `--reference ORIGINAL_DLL` accepts an explicit
original with the same five-export interface and preserves its ordinals. SDK
source correspondence is recorded only when those bytes match the declared
original; other explicit references retain their own checksum identity.

The output contains the proxy, a byte-preserved renamed original, original
licenses and a universal native scene-source archive. `provider.json` records
the original export table, checksums and source identities. The additional
observation-table export does not replace an SDK export.

The managed package version is declared separately in `source.json`. Its API
version is checked against the original DLL's recorded file-version profile.
`payload/` contains the runtime manifest, consumed provider descriptor, proxy,
preserved reference and notices. `runtime-package.json` is the standard package
declaration for `tools/runtime-package.mjs` in MacLauncher Builds. Compiler
inputs, object files and the native source archive remain outside `payload/`.

The native producer requires unwrapped Vulkan handles and a prepared consumer
for the recorded scene-operation API. Windows Vulkan handles and callbacks
remain in their original ABI. Original SDK GPU work is retained. D3D12 resource
and command-list interop requires its own implementation-side adapter.
