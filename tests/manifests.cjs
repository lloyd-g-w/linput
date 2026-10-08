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
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(path.join(dir, file));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${browser}: ${file} is not PNG`);
    assert.equal(png.subarray(12, 16).toString(), 'IHDR');
    assert.equal(png.readUInt32BE(16), Number(size), `${browser}: wrong icon width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${browser}: wrong icon height`);
  }
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
