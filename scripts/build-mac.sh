#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Build on an Apple Silicon Mac.' >&2; exit 1; }
release=false
if [[ "${1:-}" == --release ]]; then release=true; fi
if $release; then
  [[ "${MAC_SIGNING_IDENTITY:-}" == 'Developer ID Application: '* && -n "${MAC_NOTARY_PROFILE:-}" ]] || {
    echo 'Release build requires MAC_SIGNING_IDENTITY and MAC_NOTARY_PROFILE.' >&2; exit 1;
  }
fi
version="$(node -p 'require("./package.json").version')"
node -e 'const fs=require("fs"),v=require("./package.json").version;if(JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json")).version!==v || !fs.readFileSync("src-tauri/Cargo.toml","utf8").includes(`version = "${v}"`))throw Error("Version mismatch")'
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_KEY -u APPLE_SIGNING_IDENTITY \
  npx --no-install tauri build --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
mkdir -p dist
bundle="$PWD/dist/PetLink.app"
rm -rf "$bundle"
ditto src-tauri/target/release/bundle/macos/PetLink.app "$bundle"
cp LICENSE "$bundle/Contents/Resources/LICENSE"
if $release; then
  signing_args=(--force --sign "$MAC_SIGNING_IDENTITY" --options runtime --timestamp)
  if [[ -n "${MAC_SIGNING_KEYCHAIN:-}" ]]; then signing_args+=(--keychain "$MAC_SIGNING_KEYCHAIN"); fi
  codesign "${signing_args[@]}" "$bundle"
else
  codesign --force --sign - "$bundle"
  echo 'Local ad-hoc build; not Apple notarized.' >&2
fi
codesign --verify --deep --strict "$bundle"
notarize() {
  local artifact="$1"
  local notary_args=(--keychain-profile "$MAC_NOTARY_PROFILE")
  if [[ -n "${MAC_SIGNING_KEYCHAIN:-}" ]]; then notary_args+=(--keychain "$MAC_SIGNING_KEYCHAIN"); fi
  local result
  result="$(xcrun notarytool submit "$artifact" "${notary_args[@]}" --wait --timeout 20m --output-format json)"
  printf '%s' "$result" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{if(JSON.parse(s).status!=="Accepted")throw Error("Apple notarization failed")})'
}
if $release; then
  submission="$PWD/dist/PetLink-notarization.zip"
  ditto -c -k --sequesterRsrc --keepParent "$bundle" "$submission"
  notarize "$submission"
  rm "$submission"
  xcrun stapler staple "$bundle"
  xcrun stapler validate "$bundle"
  spctl --assess --type execute --verbose=4 "$bundle"
fi
archive="$PWD/dist/PetLink-$version-mac-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
staging="$(mktemp -d "$PWD/dist/dmg-stage-XXXXXX")"
trap 'rm -rf "$staging"' EXIT
ln -s /Applications "$staging/Applications"
ditto "$bundle" "$staging/PetLink.app"
dmg="$PWD/dist/PetLink-$version-mac-arm64.dmg"
hdiutil create -volname PetLink -srcfolder "$staging" -ov -format UDZO "$dmg"
if $release; then
  codesign "${signing_args[@]}" "$dmg"
  notarize "$dmg"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
fi
(cd dist && shasum -a 256 "PetLink-$version-mac-arm64.dmg" "PetLink-$version-mac-arm64.zip" > "PetLink-$version-SHA256SUMS.txt")
ls -lh "$dmg" "$archive"
