// Verify installed browser bundles, not the source manifest templates.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[2] || 'dist';
for (const browser of ['chrome', 'firefox']) {
  const dir = path.join(root, browser);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Linput');
  assert.deepEqual(manifest.permissions, ['storage', 'contextMenus']);
  const scripts = [
    ...(manifest.background.scripts || [manifest.background.service_worker]),
    ...manifest.content_scripts.flatMap(entry => entry.js),
  ];
  for (const file of [...scripts, manifest.options_ui.page, 'demo.html', 'options.css', 'editor.js']) {
    assert.ok(fs.statSync(path.join(dir, file)).size > 0, `${browser}: ${file} is missing/empty`);
  }
  const html = fs.readFileSync(path.join(dir, manifest.options_ui.page), 'utf8');
  for (const [, file] of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    assert.ok(fs.statSync(path.join(dir, file)).size > 0, `${browser}: HTML references missing ${file}`);
  }
  const css = fs.readFileSync(path.join(dir, 'options.css'), 'utf8');
  for (const [, file] of css.matchAll(/url\("([^"]+)"\)/g)) {
    assert.ok(fs.statSync(path.join(dir, file)).size > 0, `${browser}: CSS references missing ${file}`);
  }
  if (browser === 'chrome') assert.ok(manifest.key, 'Chrome needs a stable ID for sync');
  else assert.ok(manifest.browser_specific_settings.gecko.id, 'Firefox needs a stable ID for sync');
}
console.log('Installed Chrome/Firefox manifests and assets verified.');
