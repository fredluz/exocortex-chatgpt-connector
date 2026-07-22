#!/bin/zsh
set -euo pipefail

APP="$HOME/Applications/ExocortexChatGPTDaemon.app"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MACOS="$APP/Contents/MacOS"
RESOURCES="$APP/Contents/Resources"
LAUNCHER_SOURCE="$ROOT/scripts/ExocortexChatGPTDaemonLauncher.m"
HELPER_SOURCE="$ROOT/build/native/chatgpt-ax-helper"

mkdir -p "$MACOS" "$RESOURCES"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>ExocortexChatGPTDaemon</string>
  <key>CFBundleIdentifier</key>
  <string>com.macx.exocortex.chatgpt-daemon</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Exocortex ChatGPT Daemon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Controls the ChatGPT desktop app for Exocortex agent requests.</string>
</dict>
</plist>
PLIST

clang -framework Foundation -framework ApplicationServices -fobjc-arc \
  -o "$MACOS/ExocortexChatGPTDaemon" \
  "$LAUNCHER_SOURCE"
"$ROOT/scripts/build-native-helper.sh" >/dev/null
cp "$HELPER_SOURCE" "$MACOS/chatgpt-ax-helper"
chmod 755 "$MACOS/chatgpt-ax-helper"
codesign --force --deep --sign - "$APP" >/dev/null
touch "$APP"

echo "$APP"
