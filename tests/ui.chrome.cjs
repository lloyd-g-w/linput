// Screenshot-driven UI/editor checks against the actual extension.
// Run: nix shell nixpkgs#chromium -c node tests/ui.chrome.cjs [--before]
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const before = process.argv.includes('--before');
  const profile = mkdtempSync(path.join(tmpdir(), 'linput-ui-'));
  const extension = path.resolve(process.env.LINPUT_EXTENSION_DIR || 'dist/chrome');
  mkdirSync('screenshots', {recursive: true});
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM || execFileSync('which', ['chromium'], {encoding:'utf8'}).trim(),
      headless: true, viewport: {width:1440, height:1000},
      args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const demo = {id:'demo', name:'Add items to search', script:`-- One entry at a time, at your own pace.\nlocal items = {"apple", "banana", "cherry"}\n\nfor _, item in ipairs(items) do\n  linput.type(item)\n  linput.enter()\n  linput.delay(250)\nend\n\nlinput.log("All done.")\n`};
    await worker.evaluate(async w => chrome.storage.sync.set({['workflow:' + w.id]: w}), demo);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.locator('#workflows option[value="demo"]').waitFor({state:'attached'});
    await page.locator('#workflows').selectOption('demo');
    await page.locator('#items').fill('apple banana\ncherry');
    await page.locator('#convert').click();
    await page.screenshot({path:`screenshots/${before ? 'before' : 'after'}-desktop.png`, fullPage:true});
    if (!before) {
      await page.locator('.cm-editor').waitFor();
      assert.equal(await page.locator('#script').inputValue(), demo.script);
      assert.ok(await page.locator('.cm-content span').count() > 5, 'Lua tokens are syntax-highlighted');
      assert.ok(await page.evaluate(() => {
        const number = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(el => el.textContent.trim() === '1');
        return Math.abs(number.getBoundingClientRect().top - document.querySelector('.cm-line').getBoundingClientRect().top) < 2;
      }), 'Line numbers align with their code lines');
      assert.match(await page.locator('#editor-state').textContent(), /saved/i);
      // Completion appears on a namespace and contains the full browser API.
      await page.evaluate(() => window.LinputEditor.setValue(''));
      await page.locator('.cm-content').click();
      await page.keyboard.type('linput.');
      await page.locator('.cm-tooltip-autocomplete').waitFor();
      assert.ok(await page.getByRole('option', {name:/delay/}).count());
      await page.screenshot({path:'screenshots/autocomplete-desktop.png', fullPage:true});
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.LinputEditor.setValue('linput.ent'));
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Control+Space');
      await page.getByRole('option', {name:/enter/}).click();
      assert.match(await page.locator('#script').inputValue(), /^linput\.enter\(\)/);
      assert.match(await page.locator('#editor-state').textContent(), /unsaved/i);
      // Validation must not execute the script.
      await page.evaluate(() => window.LinputEditor.setValue('local broken ='));
      await page.locator('#validate').click();
      assert.match(await page.locator('#status').textContent(), /workflow\.lua|syntax/i);
      await page.locator('.cm-lintRange-error').waitFor();
      await page.screenshot({path:'screenshots/syntax-error-desktop.png', fullPage:true});
      await page.evaluate(script => window.LinputEditor.setValue(script), demo.script);
      assert.equal(await page.locator('.cm-lintRange-error').count(), 0, 'Opening a valid script clears stale diagnostics immediately');
      await page.locator('.cm-content').click();
      await page.keyboard.press('Control+s');
      await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Saved'));
      // Converter operates on actual CodeMirror selections, not a stale hidden textarea.
      await page.evaluate(() => { window.LinputEditor.setValue('before\nold\nafter'); window.LinputEditor.select(7, 10); });
      await page.locator('#insert-list').click();
      assert.equal(await page.locator('#script').inputValue(), 'before\n' + await page.locator('#converted').inputValue() + '\nafter');
      await page.evaluate(script => window.LinputEditor.setValue(script), demo.script);
      await page.locator('#validate').click();
      assert.equal(await page.locator('.cm-lintRange-error').count(), 0, 'Successful syntax check clears editor diagnostics');
      await page.setViewportSize({width:1024, height:900});
      await page.screenshot({path:'screenshots/after-tablet.png', fullPage:true});
    }
    await page.setViewportSize({width:390, height:844});
    await page.screenshot({path:`screenshots/${before ? 'before' : 'after'}-mobile.png`, fullPage:true});
    if (!before) {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow at 390px');
      assert.equal(await page.locator('#library-disclosure').getAttribute('open'), null, 'Mobile library tools start collapsed');
      assert.ok(await page.evaluate(() => {
        const editor = document.querySelector('.cm-scroller');
        return editor.scrollWidth <= editor.clientWidth + 1;
      }), 'Long Lua lines wrap within the mobile editor');
      assert.deepEqual(errors, []);
      console.log('UI/editor checks passed; desktop, tablet, mobile, autocomplete and error screenshots saved in screenshots/.');
    } else console.log('Baseline screenshots saved in screenshots/.');
  } finally {
    if (context) await context.close();
    rmSync(profile, {recursive:true, force:true});
  }
})().catch(e => {console.error(e); process.exitCode = 1;});
