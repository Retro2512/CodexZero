#!/bin/sh
# Swaps a prepared CodexZero.app in after the running app quits, then reopens
# it. Usage: complete-desktop-update-macos.sh BUNDLE BUILD PARENT_PID
set -u

bundle="$1"
build="$2"
parent="$3"
stage="$(dirname "$build")"
failure="$HOME/Library/Caches/CodexZero/update-failed.txt"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

case "$bundle" in *.app) ;; *) exit 1 ;; esac
case "$build" in */.stage-*/CodexZero.app) ;; *) exit 1 ;; esac
mkdir -p "$(dirname "$failure")"

# Never force the app to quit. Give up after two minutes and keep it as it is.
waited=0
while kill -0 "$parent" 2>/dev/null; do
  if [ "$waited" -ge 1200 ]; then
    echo "CodexZero update failed." > "$failure"
    exit 1
  fi
  waited=$((waited + 1))
  sleep 0.1
done

previous="$(dirname "$bundle")/.$(basename "$bundle" .app)-previous-$$.app"
if mv "$bundle" "$previous"; then
  if mv "$build" "$bundle"; then
    rm -rf "$previous"
  else
    mv "$previous" "$bundle"
    echo "CodexZero update failed." > "$failure"
  fi
else
  echo "CodexZero update failed." > "$failure"
fi
"$lsregister" -f "$bundle" >/dev/null 2>&1 || true
open "$bundle"
# Remove the staging folder last; this script runs from inside it.
exec rm -rf "$stage"
