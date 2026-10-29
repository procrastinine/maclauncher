#!/bin/bash
set -euo pipefail

native_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$native_root/../../../../../.." && pwd)"
build_root="${MACLAUNCHER_NEURAL_BUILD_ROOT:-$HOME/Library/Caches/maclauncher/neural-provider/build}"
cache_root="${MACLAUNCHER_NEURAL_CACHE_ROOT:-$HOME/Library/Caches/maclauncher/neural-provider/swiftpm}"
destination="${1:-$build_root/arm64-apple-macosx/release}"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$(dirname "$build_root")/neural-provider-clang}"
export SWIFTPM_MODULECACHE_OVERRIDE="${SWIFTPM_MODULECACHE_OVERRIDE:-$(dirname "$build_root")/neural-provider-swift}"
# SwiftPM writes Package.resolved and its Packages/ edit links beside the
# manifest, so it builds a synchronized copy of this package outside the source tree.
package_root="${MACLAUNCHER_NEURAL_PACKAGE_ROOT:-$(dirname "$build_root")/neural-provider-package}"
mkdir -p "$cache_root/config" "$cache_root/security" "$CLANG_MODULE_CACHE_PATH" "$SWIFTPM_MODULECACHE_OVERRIDE" "$destination" "$package_root"
for entry in Package.swift Package.resolved; do
  cmp -s "$native_root/$entry" "$package_root/$entry" || cp -p "$native_root/$entry" "$package_root/$entry"
done
for entry in Sources Tests; do /usr/bin/rsync -a --delete "$native_root/$entry/" "$package_root/$entry/"; done
if [[ -z "${MACLAUNCHER_MLX_DLSS_SOURCE:-}" && -f "$repo_root/src/external/MLX-DLSS/Package.swift" ]]; then
  export MACLAUNCHER_MLX_DLSS_SOURCE="$repo_root/src/external/MLX-DLSS"
fi
if [[ -z "${MACLAUNCHER_MLX_DLSS_SOURCE:-}" ]]; then
  echo 'The neural provider build requires its registered source checkout' >&2
  exit 1
fi
export MACLAUNCHER_MLX_DLSS_SOURCE="$(node "$native_root/prepare-upstream.mjs" "$MACLAUNCHER_MLX_DLSS_SOURCE" "$build_root")"
package_options=(--disable-sandbox --package-path "$package_root" --scratch-path "$build_root"
  --cache-path "$cache_root" --config-path "$cache_root/config" --security-path "$cache_root/security" --skip-update)
owned_mlx_source="$build_root/owned-source/mlx-swift"
# SwiftPM removes its original checkout when selecting an external edit. Restore
# that exact pinned checkout before materializing a changed owned adaptation.
if [[ -f "$build_root/workspace-state.json" ]]; then
  current_edit="$(node --input-type=module - "$build_root/workspace-state.json" "$owned_mlx_source" "$native_root/prepare-mlx-timing.mjs" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const row=JSON.parse(fs.readFileSync(process.argv[2])).object.dependencies.find(row=>row.packageRef.identity==='mlx-swift');
if(row?.state.name==='edited'){
  if(row.state.path!==process.argv[3]&&row.state.unmanagedPath!==process.argv[3])throw new Error('The MLX dependency has a different source edit.');
  try{
    const {verifyTimingReceipt}=await import(pathToFileURL(process.argv[4]));
    const receipt=JSON.parse(fs.readFileSync(path.join(process.argv[3],'maclauncher-gpu-timing.json')));
    verifyTimingReceipt(receipt);
    for(const[file,sha]of Object.entries(receipt.applied))if(crypto.createHash('sha256').update(fs.readFileSync(path.join(process.argv[3],file))).digest('hex')!==sha)throw new Error('Changed applied source');
    process.stdout.write('ready');
  }catch{process.stdout.write('restore');}
}
JS
)"
  if [[ "$current_edit" == restore ]]; then swift package "${package_options[@]}" unedit mlx-swift; fi
fi
swift package "${package_options[@]}" resolve
if [[ "${current_edit:-}" == ready ]]; then mlx_source="$owned_mlx_source";
else mlx_source="$(node "$native_root/prepare-mlx-timing.mjs" "$build_root/checkouts/mlx-swift" "$build_root")"; fi
edit_state="$(node --input-type=module - "$build_root/workspace-state.json" "$mlx_source" <<'JS'
import fs from 'node:fs';
const row=JSON.parse(fs.readFileSync(process.argv[2])).object.dependencies.find(row=>row.packageRef.identity==='mlx-swift');
if(!row)throw new Error('The pinned MLX dependency is unavailable.');
if(row.state.name==='edited'){
  if(row.state.path!==process.argv[3]&&row.state.unmanagedPath!==process.argv[3])throw new Error('The MLX dependency has a different source edit.');
  process.stdout.write('ready');
}else if(row.state.name==='sourceControlCheckout')process.stdout.write('prepare');
else throw new Error('The MLX dependency state is unsupported.');
JS
)"
if [[ "$edit_state" == prepare ]]; then
  swift package "${package_options[@]}" edit --path "$mlx_source" mlx-swift
fi
prefix_flags=()
# The package copy maps to its source location. Swift uses the first matching
# prefix and Clang the last, so the specific mapping surrounds the general ones.
package_mapping="$package_root=MacLauncher/${native_root#"$repo_root"/}"
for mapping in "$package_mapping" "$repo_root=MacLauncher" "$build_root=MacLauncherBuild" "$package_mapping"; do
  prefix_flags+=(-Xcc "-ffile-prefix-map=$mapping" -Xcxx "-ffile-prefix-map=$mapping"
    -Xswiftc -file-prefix-map -Xswiftc "$mapping" -Xswiftc -debug-prefix-map -Xswiftc "$mapping")
done

# Fast arm64 selector stubs load objc_msgSend from one of two equivalent GOT
# slots chosen by linker threads; small stubs branch directly. Debug-map object
# paths and dates feed LC_UUID, so they are made location- and time-independent.
ZERO_AR_DATE=1 swift build --build-system native --disable-sandbox --package-path "$package_root" \
  --scratch-path "$build_root" --cache-path "$cache_root" \
  --config-path "$cache_root/config" --security-path "$cache_root/security" \
  --configuration release --jobs "${MACLAUNCHER_NEURAL_BUILD_JOBS:-4}" "${prefix_flags[@]}" \
  -Xlinker -objc_stubs_small -Xlinker -oso_prefix -Xlinker "$build_root/"
binary_root="$build_root/arm64-apple-macosx/release"
xcrun clang++ -std=c++17 -arch arm64 -mmacosx-version-min=14.0 -fobjc-arc -O2 \
  -DMACLAUNCHER_NEURAL_SERVICE_MAIN=1 -Wno-deprecated-declarations \
  -ffile-prefix-map="$repo_root=MacLauncher" \
  "$native_root/../../native/neural-service.mm" -framework Foundation -framework Metal \
  -framework CoreVideo -framework IOSurface -o "$destination/maclauncher-neural-service"
if [[ "$(cd "$destination" && pwd)" != "$(cd "$binary_root" && pwd)" ]]; then
  cp "$binary_root/libMacLauncherNeural.dylib" "$binary_root/maclauncher-neural-video" "$destination/"
fi
for binary in libMacLauncherNeural.dylib maclauncher-neural-video maclauncher-neural-service; do
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
cp -f "$mlx_source/LICENSE" "$destination/notices/MLX-Swift-LICENSE"
cp -f "$mlx_source/Source/Cmlx/mlx/LICENSE" "$destination/notices/MLX-LICENSE"
cp -f "$build_root/checkouts/swift-numerics/LICENSE.txt" "$destination/notices/Swift-Numerics-LICENSE"
cp -f "$build_root/checkouts/swift-argument-parser/LICENSE.txt" "$destination/notices/Swift-Argument-Parser-LICENSE"
cp "$native_root/REAL-ESRGAN-BSD-3-CLAUSE.txt" "$destination/notices/Real-ESRGAN-BSD-3-CLAUSE.txt"
cp "$native_root/SRVGG-SWIFT-MIT.txt" "$destination/notices/SRVGG-Swift-MIT.txt"
for notice in REAL-CUGAN-MIT.txt NAFNET-SWIFT-MIT.txt NAFNET-NOTICE.txt RIFE-NCNN-MIT.txt RIFE-MIT.txt NCNN-BSD-3-CLAUSE.txt NAFNET-ORIGINAL-MIT.txt; do
  cp "$native_root/$notice" "$destination/notices/$notice"
done
cp "$native_root/DEPTH-ANYTHING-APACHE-2.0.txt" "$destination/notices/DEPTH-ANYTHING-APACHE-2.0.txt"
cp "$native_root/DEPTH-ANYTHING-NOTICE.txt" "$destination/notices/DEPTH-ANYTHING-NOTICE.txt"
cp "$native_root/upstream.json" "$destination/upstream.json"
cp "$upstream_root/maclauncher-adaptation.json" "$destination/adaptation.json"
cp "$mlx_source/maclauncher-gpu-timing.json" "$destination/timing-adaptation.json"
printf '%s\n' "$destination"
