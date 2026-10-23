# RPGMakerDecrypter

The app includes an Apple Silicon command-line build of [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) for its extraction actions. Users do not install the [.NET SDK](https://github.com/dotnet/sdk) or this tool separately.

The pinned source and toolchain are listed in [`decrypter-source.json`](../../modules/rgss/runtime/decrypter-source.json): upstream commit `465c88c304cac0b1516a3fbfb0b2a87fb0517736`, .NET SDK `8.0.426`, runtime `8.0.32`, and individual archive checksums. `build.json` records the actual bundled executable and build identities. Native Intel builds require a separately pinned toolchain and artifact.

The [owned build recipe](../../modules/rgss/runtime/decrypter-build.js) copies the unchanged upstream CLI projects into a new build directory. [MSBuild properties](../../modules/rgss/runtime/decrypter-build.props) disable private debug records, map source paths to `/_/RPGMakerDecrypter`, and explicitly bind the version to upstream instead of any enclosing Git repository. [MSBuild targets](../../modules/rgss/runtime/decrypter-build.targets) select Newtonsoft.Json 13.0.4 without changing upstream source. NuGet lockfiles and complete archive hashes pin compiler, framework and library packages. Runtime and library license notices are included beside the executable.

To rebuild, download the source and SDK archives at the URLs in the pin file and verify their listed checksums. Store them in a build-input directory outside the checkout; no global SDK installation is needed. Use a new output directory on the Mac’s native filesystem for compilation:

```sh
node src/modules/rgss/runtime/decrypter-build.js \
  --source-archive /path/to/source.tar.gz \
  --sdk-archive /path/to/dotnet-sdk.tar.gz \
  --output /path/to/new-native-build
```

The explicit developer command restores the pinned NuGet packages. For an offline rebuild, add `--offline --packages /path/to/verified-nuget-cache`. The recipe verifies source/toolchain and package archives before compilation. The output includes the executable, runtime and library notices, and `build.json`.
