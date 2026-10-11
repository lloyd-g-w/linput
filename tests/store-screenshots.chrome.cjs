// Capture actual extension UI at Chrome Web Store's 1280×800 size.
// Run: nix develop --command node tests/store-screenshots.chrome.cjs
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'linput-store-'));
  const extension = path.resolve(process.env.LINPUT_EXTENSION_DIR || 'result/chrome');
  const output = path.resolve('screenshots/store');
  mkdirSync(output, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
      headless: true,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const workflow = {
      id: 'store-list', name: 'Add a list of items',
      script: '-- Add each item to the selected field.\nlocal items = {"apple", "banana", "cherry", "peach"}\n\nfor _, item in ipairs(items) do\n  linput.type(item)\n  linput.enter()\n  linput.delay(250)\nend\n\nlinput.log("All items added.")\n',
    };
    await worker.evaluate(async w => chrome.storage.sync.set({ ['workflow:' + w.id]: w }), workflow);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.locator('#workflows option[value="store-list"]').waitFor({ state: 'attached' });
    await page.locator('#workflows').selectOption(workflow.id);
    await page.locator('.cm-editor').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#items').fill('apple banana\ncherry peach');
    await page.locator('#convert').click();
    await page.locator('#validate').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('valid'));
    assert.equal(await page.locator('#script').inputValue(), workflow.script);
    await page.locator('#editor-title').click();
    await page.screenshot({ path: path.join(output, '01-workflow-studio.png'), fullPage: false });

    // Trigger completions inside valid saved code, rather than staging an error.
    await page.locator('.utility-section').filter({ has: page.locator('#items') }).locator('summary').click();
    await page.getByText('API reference', { exact: true }).click();
    await page.locator('.cm-content').click();
    await page.evaluate(script => {
      const cursor = script.indexOf('linput.type') + 'linput.'.length;
      window.LinputEditor.select(cursor, cursor);
    }, workflow.script);
    await page.keyboard.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor();
    await page.screenshot({ path: path.join(output, '02-lua-autocomplete.png'), fullPage: false });
    assert.deepEqual(errors, []);
    for (const file of ['01-workflow-studio.png', '02-lua-autocomplete.png']) {
      const png = readFileSync(path.join(output, file));
      assert.equal(png.readUInt32BE(16), 1280);
      assert.equal(png.readUInt32BE(20), 800);
    }
    console.log(`Two real 1280×800 app screenshots saved in ${output}`);
  } finally {
    if (context) await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
