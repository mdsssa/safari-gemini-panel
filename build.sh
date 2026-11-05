#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

: "${TEAM_ID:?Usage: TEAM_ID=ABCDE12345 BUNDLE_ID=com.yourname.geminipanel ./build.sh}"
BUNDLE_ID="${BUNDLE_ID:-com.example.geminipanel}"
APP="Gemini Panel"
OUT=".build-xcode"
PROJ="$OUT/$APP/$APP.xcodeproj"

rm -rf "$OUT" && mkdir -p "$OUT"

xcrun safari-web-extension-converter extension \
  --project-location "$OUT" --app-name "$APP" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only --copy-resources --no-open --no-prompt

# The converter derives a wrong app bundle id; make it the parent of the extension id
sed -i '' -E "s/(PRODUCT_BUNDLE_IDENTIFIER = )\"?[^\";]*Gemini-Panel\"?;/\1${BUNDLE_ID};/" "$PROJ/project.pbxproj"

# Custom app icon
if [ -d icons/AppIcon.appiconset ]; then
  rm -rf "$OUT/$APP/$APP/Assets.xcassets/AppIcon.appiconset"
  cp -R icons/AppIcon.appiconset "$OUT/$APP/$APP/Assets.xcassets/"
fi

xcodebuild -project "$PROJ" -scheme "$APP" -configuration Debug \
  -derivedDataPath "$OUT/derived" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="Apple Development" build

rm -rf "/Applications/$APP.app"
cp -R "$OUT/derived/Build/Products/Debug/$APP.app" /Applications/
open "/Applications/$APP.app"
echo "Done. Enable it in Safari > Settings > Extensions."
