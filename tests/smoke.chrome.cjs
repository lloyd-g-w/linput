// Real Chromium smoke test. Run: nix shell nixpkgs#chromium -c node tests/smoke.chrome.cjs
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
  const extension = path.resolve('dist/chrome');
  const profile = mkdtempSync(path.join(tmpdir(), 'linput-smoke-'));
  const server = http.createServer((_, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><input id="target"><input id="other"><textarea id="notes"></textarea>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM || execFileSync('which', ['chromium'], {encoding:'utf8'}).trim(),
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    const errors = [];
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#name').fill('Smoke test');
    await options.locator('#items').fill('z5599988 z5599988\nz42');
    const writeScript = script => options.evaluate(value => window.LinputEditor.setValue(value), script);
    await writeScript('');
    await options.locator('#convert').click();
    const converted = await options.locator('#converted').inputValue();
    await options.locator('#insert-list').click();
    assert.equal(await options.locator('#script').inputValue(), converted);
    await writeScript(converted + `
assert(os == nil and io == nil and debug == nil and require == nil)
for _, item in ipairs(items) do
  linput.type(item)
  linput.enter()
  linput.delay(50)
end
`);
    await options.locator('#save').click();
    await options.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Saved'));
    const stored = await worker.evaluate(async () => Object.values(await chrome.storage.sync.get(null))[0]);
    assert.match(stored.script, /linput\.type\(item\)/);
    assert.equal(stored.items, undefined);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.inputs = []; window.enters = 0;
      document.querySelector('#target').addEventListener('input', e => window.inputs.push(e.target.value));
      document.querySelector('#target').addEventListener('keydown', e => { if (e.key === 'Enter') window.enters++; });
    });
    await page.locator('#target').click({button:'right'});
    // Headless Chromium does not expose native context-menu selection. Send the same
    // message that the menu handler sends; jsdom tests cover that handler's routing.
    const send = w => worker.evaluate(async w => {
      const tabs = await chrome.tabs.query({});
      // No tabs/history permission: URLs are intentionally unavailable.
      const tab = tabs.reduce((last, t) => !last || t.index > last.index ? t : last, null);
      return chrome.tabs.sendMessage(tab.id, {kind:'run', workflow:w}, {frameId:0});
    }, w);
    assert.deepEqual(await send(stored), {ok:true});
    await page.waitForFunction(() => document.documentElement.textContent.includes('linput finished'));
    assert.deepEqual(await page.evaluate(() => window.inputs), ['z5599988', 'z5599988', 'z42']);
    assert.equal(await page.evaluate(() => window.enters), 3);
    assert.equal(await page.locator('#target').inputValue(), 'z42');
    assert.equal(await page.locator('#other').inputValue(), '');
    assert.deepEqual(await send({...stored, script: `
assert(linput.value() == 'z42')
if linput.exists('#notes') then
  linput.focus('#notes')
  local function label(n) return string.upper('ok') .. '-' .. n end
  linput.type(label(2))
end
`}), {ok:true});
    await page.waitForFunction(() => document.querySelector('#notes').value === 'OK-2');
    await page.waitForFunction(() => document.documentElement.textContent.includes('linput finished'));
    assert.deepEqual(await send({...stored, script:'while true do end'}), {ok:true});
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})));
    await page.waitForFunction(() => document.documentElement.textContent.includes('linput stopped'));
    assert.deepEqual(errors, []);
    console.log('Real Chromium smoke test passed (Lua loops/functions/conditions, APIs, converter, sync, and runaway-loop cancellation).');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(profile, {recursive:true, force:true});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
