#!/bin/bash
set -euo pipefail

native_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$native_root/../../../../../.." && pwd)"
build_root="${MACLAUNCHER_NEURAL_BUILD_ROOT:-$HOME/Library/Caches/maclauncher/neural-provider/build}"
cache_root="${MACLAUNCHER_NEURAL_CACHE_ROOT:-$HOME/Library/Caches/maclauncher/neural-provider/swiftpm}"
destination="${1:-$build_root/arm64-apple-macosx/release}"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$(dirname "$build_root")/neural-provider-clang}"
export SWIFTPM_MODULECACHE_OVERRIDE="${SWIFTPM_MODULECACHE_OVERRIDE:-$(dirname "$build_root")/neural-provider-swift}"
mkdir -p "$cache_root/config" "$cache_root/security" "$CLANG_MODULE_CACHE_PATH" "$SWIFTPM_MODULECACHE_OVERRIDE" "$destination"
if [[ -z "${MACLAUNCHER_MLX_DLSS_SOURCE:-}" && -f "$repo_root/src/external/MLX-DLSS/Package.swift" ]]; then
  export MACLAUNCHER_MLX_DLSS_SOURCE="$repo_root/src/external/MLX-DLSS"
fi
if [[ -z "${MACLAUNCHER_MLX_DLSS_SOURCE:-}" ]]; then
  echo 'The neural provider build requires its registered source checkout' >&2
  exit 1
fi
export MACLAUNCHER_MLX_DLSS_SOURCE="$(node "$native_root/prepare-upstream.mjs" "$MACLAUNCHER_MLX_DLSS_SOURCE" "$build_root")"
prefix_flags=()
for mapping in "$repo_root=MacLauncher" "$build_root=MacLauncherBuild"; do
  prefix_flags+=(-Xcc "-ffile-prefix-map=$mapping" -Xcxx "-ffile-prefix-map=$mapping"
    -Xswiftc -file-prefix-map -Xswiftc "$mapping" -Xswiftc -debug-prefix-map -Xswiftc "$mapping")
done

swift build --build-system native --disable-sandbox --package-path "$native_root" \
  --scratch-path "$build_root" --cache-path "$cache_root" \
  --config-path "$cache_root/config" --security-path "$cache_root/security" \
  --configuration release --jobs "${MACLAUNCHER_NEURAL_BUILD_JOBS:-4}" "${prefix_flags[@]}"
binary_root="$build_root/arm64-apple-macosx/release"
if [[ "$(cd "$destination" && pwd)" != "$(cd "$binary_root" && pwd)" ]]; then
  cp "$binary_root/libMacLauncherNeural.dylib" "$binary_root/maclauncher-neural-video" "$destination/"
fi
for binary in libMacLauncherNeural.dylib maclauncher-neural-video; do
  while IFS= read -r toolchain_rpath; do
    [[ -z "$toolchain_rpath" ]] || /usr/bin/install_name_tool -delete_rpath "$toolchain_rpath" "$destination/$binary"
  done < <(/usr/bin/otool -l "$destination/$binary" | awk '/cmd LC_RPATH/{rpath=1;next} rpath && /path /{if ($2 ~ /^\/Applications\/.*\.xctoolchain\//) print $2;rpath=0}')
  xcrun strip -S "$destination/$binary"
  /usr/bin/codesign --force --sign - --timestamp=none "$destination/$binary"
done

metal_hash="4cb8ef6cbb43e43f4c07d466fe0944801987a45b1354324cf4810ec131278bf5"
if [[ ! -f "$destination/mlx.metallib" || "$(shasum -a 256 "$destination/mlx.metallib" | cut -d ' ' -f 1)" != "$metal_hash" ]]; then
  archive="$cache_root/Cmlx-0.31.6.xcframework.zip"
  archive_hash="a202bf1dcfe1e64404adabfeb5eb363332e3a6221d18e4289ca0663fa3ab86c9"
  if [[ ! -f "$archive" ]]; then
    curl --fail --location --retry 2 --output "$archive.download" \
      https://github.com/ml-explore/mlx-swift/releases/download/0.31.6/Cmlx.xcframework.zip
    mv "$archive.download" "$archive"
  fi
  [[ "$(shasum -a 256 "$archive" | cut -d ' ' -f 1)" == "$archive_hash" ]] || { echo 'MLX artifact checksum mismatch' >&2; exit 1; }
  unzip -p "$archive" Cmlx.xcframework/macos-arm64_x86_64/Cmlx.framework/Versions/A/Resources/default.metallib \
    > "$destination/mlx.metallib.download"
  [[ "$(shasum -a 256 "$destination/mlx.metallib.download" | cut -d ' ' -f 1)" == "$metal_hash" ]] || { echo 'MLX Metal library checksum mismatch' >&2; exit 1; }
  mv "$destination/mlx.metallib.download" "$destination/mlx.metallib"
fi

upstream_root="${MACLAUNCHER_MLX_DLSS_SOURCE:-$build_root/checkouts/MLX-DLSS}"
mkdir -p "$destination/notices"
cp -f "$upstream_root/LICENSE" "$destination/notices/MLX-DLSS-LICENSE"
cp -f "$upstream_root/NOTICE" "$destination/notices/MLX-DLSS-NOTICE"
cp -f "$build_root/checkouts/mlx-swift/LICENSE" "$destination/notices/MLX-Swift-LICENSE"
cp -f "$build_root/checkouts/mlx-swift/Source/Cmlx/mlx/LICENSE" "$destination/notices/MLX-LICENSE"
cp -f "$build_root/checkouts/swift-numerics/LICENSE.txt" "$destination/notices/Swift-Numerics-LICENSE"
cp -f "$build_root/checkouts/swift-argument-parser/LICENSE.txt" "$destination/notices/Swift-Argument-Parser-LICENSE"
cp "$native_root/upstream.json" "$destination/upstream.json"
cp "$upstream_root/maclauncher-adaptation.json" "$destination/adaptation.json"
printf '%s\n' "$destination"
