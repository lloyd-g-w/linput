#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Use the active OxCaml toolchain (including nix develop/build) without touching
# its library paths. An explicit switch wins; the desktop switch is a fallback.
activate_switch() {
  local switch="$1"
  if [[ ! -x "$switch/bin/ocamlc" ]]; then
    echo "OxCaml not found. Use nix develop, or set OXCAML_SWITCH to a switch prefix." >&2
    exit 1
  fi
  export PATH="$switch/bin:$PATH"
  export OCAMLLIB="$switch/lib/ocaml"
  export CAML_LD_LIBRARY_PATH="$switch/lib/stublibs:$switch/lib/ocaml/stublibs"
}
if [[ -n "${OXCAML_SWITCH:-}" ]]; then
  activate_switch "$OXCAML_SWITCH"
elif ! command -v ocamlc >/dev/null || [[ "$(ocamlc -version)" != *+ox* ]]; then
  activate_switch "${HOME:-/nonexistent}/.opam/5.2.0+ox"
fi
if [[ "$(ocamlc -version)" != *+ox* ]]; then
  echo "An OxCaml compiler is required. Use nix develop or set OXCAML_SWITCH." >&2
  exit 1
fi
if [[ ! -x node_modules/.bin/esbuild ]]; then
  echo "Run npm ci before building (local Lua VM bundler is required)." >&2
  exit 1
fi
mkdir -p _build
node_modules/.bin/esbuild node_modules/fengari/src/fengari.js --bundle --platform=browser \
  --format=iife --global-name=Fengari --define:process=undefined \
  --define:process.env.FENGARICONF=undefined --outfile=_build/fengari.js

node_modules/.bin/esbuild extension/editor-entry.js --bundle --platform=browser \
  --format=iife --minify --legal-comments=eof --outfile=_build/editor.js

dune build --profile release src/background.bc.js src/content.bc.js src/options.bc.js
dune runtest
for browser in chrome firefox; do
  mkdir -p "dist/$browser"
  cp extension/options.html extension/options.css extension/demo.html "dist/$browser/"
  cp "extension/manifest.$browser.json" "dist/$browser/manifest.json"
  install -m 644 _build/fengari.js "dist/$browser/fengari.js"
  install -m 644 _build/editor.js "dist/$browser/editor.js"
  install -m 644 node_modules/@codemirror/view/LICENSE "dist/$browser/CODEMIRROR-LICENSE.txt"
  install -m 644 node_modules/@lezer/highlight/LICENSE "dist/$browser/LEZER-LICENSE.txt"
  mkdir -p "dist/$browser/fonts"
  install -m 644 node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2 "dist/$browser/fonts/dm-sans.woff2"
  install -m 644 node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2 "dist/$browser/fonts/ibm-plex-mono.woff2"
  install -m 644 node_modules/@fontsource-variable/dm-sans/LICENSE "dist/$browser/fonts/DM-SANS-LICENSE.txt"
  install -m 644 node_modules/@fontsource/ibm-plex-mono/LICENSE "dist/$browser/fonts/IBM-PLEX-MONO-LICENSE.txt"
  install -m 644 node_modules/fengari/LICENSE "dist/$browser/FENGARI-LICENSE.txt"
  install -m 644 node_modules/sprintf-js/LICENSE "dist/$browser/SPRINTF-JS-LICENSE.txt"
  for entry in background content options; do
    install -m 644 "_build/default/src/$entry.bc.js" "dist/$browser/$entry.js"
  done
done
echo "Built dist/chrome and dist/firefox"
