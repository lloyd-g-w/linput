# Linput

A Chrome/Firefox extension written in **OxCaml**, compiled with the OxCaml-compatible `js_of_ocaml`. Right-click an editable field → **linput → workflow name** to run a saved Lua script. The editor and browser API remain OxCaml; the bundled **Fengari** interpreter executes Lua 5.3 locally without JavaScript evaluation.

## Build with Nix

```sh
nix build
# Outputs: result/chrome/ and result/firefox/

nix build .#chrome -o result-chrome
nix build .#firefox -o result-firefox
nix flake check
```

The flake pins the OxCaml compiler, patched `js_of_ocaml`, Dune, Nixpkgs and opam repositories, following `prigh`'s toolchain setup. npm dependencies are fetched from `package-lock.json` using a fixed hash, then installed/bundled offline inside the Nix sandbox. Builds run the OCaml and DOM/API integration tests, and `nix flake check` also verifies the installed browser manifests and assets. No local opam switch, `node_modules`, or previously compiled files are used.

The flake offers the same `prigh.cachix.org` binary cache as `prigh`. To explicitly accept its cache URL/public key:

```sh
nix build --accept-flake-config
```

Cache acceptance is optional; without it, missing toolchain packages build from source. The first uncached OxCaml build can take a while. Linux x86-64 is verified; other default flake systems are defined but unverified.

### Chrome Web Store package

```sh
nix build .#chrome-zip -o result-chrome-zip
# Upload result-chrome-zip/linput-chrome.zip in the Web Store developer dashboard.
```

The ZIP contains the Chrome bundle with `manifest.json` at its root, including 16/32/48/128px extension and toolbar icons. File order, timestamps and permissions are normalized for reproducibility; `nix flake check` verifies archive contents and metadata. The 128px listing icon is also available at `result/chrome/icons/icon-128.png` after `nix build`. Store screenshots, promotional artwork and privacy disclosures still need to be supplied separately.

The icon's editable source is `extension/icons/linput.svg`. Regenerate its checked-in PNGs with `nix develop --command bash scripts/generate-icons.sh`.

### Develop with Nix

```sh
nix develop
npm ci
bash scripts/build.sh     # Outputs: dist/chrome/ and dist/firefox/
npm test
```

The build script uses the active Nix OxCaml toolchain without replacing its library paths. If your login shell automatically runs `opam env`, enter a clean shell instead:

```sh
nix develop --ignore-environment --keep HOME --keep TERM \
  --command bash --noprofile --norc
```

### Existing opam switch (optional)

The same script can use your active OxCaml switch, or fall back to `~/.opam/5.2.0+ox` when no OxCaml compiler is on PATH:

```sh
npm ci
bash scripts/build.sh
OXCAML_SWITCH=/path/to/oxcaml/switch bash scripts/build.sh
```

Dependencies for this non-Nix path: Node/npm, OxCaml, Dune ≥ 3.17, and OxCaml-compatible `js_of_ocaml` ≥ 6. All editor/Lua assets are bundled locally; nothing downloads at extension runtime.

When updating `package-lock.json`, update `npmDepsHash` in `flake.nix` with `prefetch-npm-deps package-lock.json` from the pinned Nixpkgs, or use Nix's reported fixed-output hash mismatch.

## Install

- **Chrome/Chromium:** open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select `result/chrome` after `nix build` (or `dist/chrome` for a development build).
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, select `result/firefox/manifest.json` (or `dist/firefox/manifest.json` for a development build). Temporary installs disappear on restart; permanent standard Firefox installation requires Mozilla signing. The port shares all OCaml sources, with only the manifest differing.

Click the extension toolbar icon to manage workflows. Give a workflow a name, write Lua, and save. **The entire script runs once**; loops, variables, functions, conditions and tables are ordinary Lua:

```lua
local items = {"apple", "apple", "banana"}
for _, item in ipairs(items) do
  linput.type(item)
  linput.enter()
  linput.delay(250)
end
```

### Editor

The workspace uses a locally bundled CodeMirror editor with Lua syntax highlighting, line numbers, bracket matching, automatic indentation, undo/redo, search, and inline syntax diagnostics. Syntax checks compile Lua but never execute it.

- Type `linput.` for API completions and signature/help text, or press **Ctrl+Space**.
- Complete sandbox-supported Lua functions, `string`/`table`/`math`/`utf8` members, local variables, and snippets for loops/functions/conditions.
- **Ctrl/Cmd+S** saves; **Ctrl/Cmd+Enter** checks syntax; **Ctrl/Cmd+F** searches within the editor.
- **Tab** indents or advances a snippet placeholder; **Escape then Tab** leaves the editor for keyboard navigation.
- Saved/unsaved indicators and a storage-size meter make changes visible; switching workflows asks before discarding edits.

Fonts (DM Sans and IBM Plex Mono), editor assets, and Lua runtime are bundled locally; no CDN or remote font requests are needed.

### Paste-to-list converter

Paste space/tab/newline-separated values into **Convert items to a Lua list**, then click **Convert**. The output is a safely quoted `local items = {...}` declaration, preserving duplicates and Unicode. Copy it, or select your existing list declaration in the script editor and click **Insert list into script**. Insertion replaces the selected text (or inserts at the caret); conversion alone does not change/save your script.

You can also paste directly inside a Lua long string and split it:

```lua
local items = linput.split([[apple apple
banana]])
```

### Lua API

Call these with dots, not colons. Action calls suspend Lua and resume after the browser action/delay; you do not need promises or callbacks.

| Function | Behavior |
| --- | --- |
| `linput.type(text)` | Replace the target with a string; emit beforeinput/input/change events. |
| `linput.enter()` | Dispatch synthetic Enter keydown/keypress/keyup. |
| `linput.delay(ms)` | Wait an integer 0–60000 milliseconds. |
| `linput.click(selector)` | Click the first matching element in the same frame; update target if an editable field receives focus. |
| `linput.tab()` | Approximate forward focus traversal; update target if the destination is editable. |
| `linput.submit()` | Call `requestSubmit()` on the target's form (validates and may navigate). |
| `linput.focus(selector)` | Explicitly select/focus an editable target, including after the original is removed. |
| `linput.value()` | Return the current target's text as a string. |
| `linput.exists(selector)` | Return whether a CSS selector matches an element. |
| `linput.log(text)` | Show a string in the status panel and developer console. |
| `linput.split(text)` | Return a whitespace-separated table of strings; preserve duplicates. |

For example:

```lua
local function add(value)
  if linput.exists("#search") then
    linput.focus("#search")
    linput.type(string.upper(value))
    linput.enter()
    linput.delay(300)
  end
end
for _, value in ipairs(linput.split("one two three")) do add(value) end
linput.log("Done: " .. linput.value())
```

A 30 ms yield follows ordinary API calls. Right-click captures the exact field and frame. Target-dependent actions stop if it disappears; use explicit `focus` to select a replacement. **Escape**, clicking the status panel, or **Stop all workflows** cancels a run, including a Lua-only infinite loop. Only one run per frame is allowed. Navigation ends the run; scripts do not resume on another page.

Existing step-based workflows and v1 exports are automatically translated into equivalent Lua when loaded, preserving IDs, names, duplicates and step ordering. Save the migrated workflow to persist its Lua representation. New exports use v2; both v1 and v2 imports are supported. Syntax errors are rejected before save/import; execution errors show a Lua filename and line where available.

### Sandbox and budgets

Scripts get Lua base functions and `table`, `string`, `math`, `utf8`, plus `linput`. No JavaScript interop, `require`, `package`, `io`, `os`, `debug`, public `coroutine`, dynamic `load`/`loadfile`/`dofile`, or direct network API is exposed. Clicking links/submitting forms can still navigate or send page data intentionally.

Lua yields every 10000 instructions so the page can handle cancellation. Each run is limited to **5 million VM instructions**, **10000 API calls**, and **5 minutes** (subject to browser timer throttling). API arguments have size/type checks. `string.rep` is bounded to 100000 bytes; `string.format` is deliberately disabled because Fengari's `sprintf-js` dependency has a precision-based denial-of-service advisory (still reported by npm audit). Use concatenation and `tostring` instead.

Only run scripts you trust and review imports before running them. This is a restricted API, **not hardened resource isolation**: there is no enforced Lua heap quota, and instruction hooks cannot interrupt a single long native library call. Large allocations/pathological string operations can still consume memory or stall the page.

## Sync and privacy

Saved workflows and lists use `storage.sync`: Chrome's browser-account sync or Firefox Sync, when enabled for extensions. This is **not Google Drive** and does **not sync across Chrome and Firefox**. Export/import JSON moves workflows between browser families or provides a backup.

Install the extension on each machine/profile yourself. The Chrome manifest includes a fixed public key (and Firefox a fixed add-on ID) so installations use the same sync namespace regardless of directory. Keep these IDs unchanged. Account-to-account/device sync requires browser sign-in and sync enabled; this cannot be verified in an unsigned local test.

Storage limit: 20 workflows and ~7 KB per workflow (name + script + JSON overhead). The converter accepts 1000 items, but scripted loops have no separate item-count limit; execution budgets apply instead. The browser's overall quota/write limits may be lower; errors are shown in options. Names and scripts, including embedded lists, are synced: avoid passwords or sensitive data. There is no extension server, analytics, or external network request.

## Browser limitations

- Synthetic keys are not trusted physical keystrokes. Some sites ignore them, and Enter does not inherently trigger a browser's native form submission. Use a deliberate `linput.click()` or `linput.submit()` call if appropriate, testing safely first.
- Typing replaces rather than appends. Contenteditable typing replaces its text, not rich-editor internal state. Common framework-controlled inputs use the native value setter, but compatibility with every site's custom editor cannot be guaranteed.
- A `click` is programmatic and may not focus the clicked control as a physical click would. CSS selectors cannot cross shadow roots. Tab traversal is an approximation, not native keyboard traversal.
- Works on HTTP/HTTPS pages and matching frames, not browser-internal pages, store pages, PDFs, or local files. Permissions allow content scripts on HTTP/HTTPS pages so right-click targets can be captured; no browsing history permission is used.
- Timers can run slower in background tabs. No promise of exact timing.

## Verify

```sh
nix flake check            # reproducible build, OCaml/DOM tests, installed assets
nix develop
npm ci
bash scripts/build.sh       # builds both bundles and runs pure OCaml tests
npm test                    # DOM/API integration tests against compiled OCaml
nix shell nixpkgs#chromium -c node tests/smoke.chrome.cjs
nix shell nixpkgs#chromium -c node tests/ui.chrome.cjs # editor checks + screenshots
```

The Chromium smoke test loads the actual extension and checks the converter, sync storage, Lua loops/functions/conditions, DOM API actions, and cancellation of a Lua-only infinite loop. Native menu selection is not exposed in headless Chromium; integration tests cover the menu handler's frame routing. Firefox uses the same generated JavaScript but has not been tested in a live Firefox session.

Manual practice: serve the static practice page on HTTP:

```sh
nix shell nixpkgs#python3 -c python -m http.server 8000 --directory extension --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/demo.html` and try the example Lua workflow (`linput.type` / `linput.delay(1000)`) on any field. The practice page linked from options includes these instructions, but content scripts cannot run directly on an extension page.

## Source layout

- `src/workflow.ml`: model, Lua quoting/list conversion, legacy migration and validation.
- `src/web.ml`: JavaScript/browser API bindings and storage serialization.
- `src/lua_runtime.ml`: Fengari VM bindings, Lua sandbox and instruction scheduler.
- `src/background.ml`: context menu and exact-frame dispatch.
- `src/content.ml`: target capture, execution and cancellation.
- `src/options.ml`: editor, sync, export/import and stop-all.
- `extension/`: HTML/CSS, the two browser manifests, and the thin CodeMirror UI adapter.
- `tests/ui.chrome.cjs`: real-browser editor checks and desktop/tablet/mobile screenshots (written to `screenshots/`).
- `flake.nix`, `flake.lock`, `nix/`: pinned toolchain, cached npm dependencies, packages, checks and dev shell.
