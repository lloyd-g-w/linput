'use strict';

// Build first: npm run build (includes the Fengari runtime bundle).
// Run with: node --test tests/browser.test.cjs
// These tests execute the compiled extension, not a reimplementation of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 1500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(`Timed out waiting for ${description}`);
    await sleep(10);
  }
}
function eventHook() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map(listener => listener(...args)); },
  };
}
function mockApi(initial = {}) {
  const data = copy(initial);
  const calls = { sets: [], removes: [], menus: [], removeAll: 0, sends: [], options: 0 };
  const api = {
    runtime: {
      onMessage: eventHook(),
      openOptionsPage() { calls.options++; return Promise.resolve(); },
    },
    storage: {
      onChanged: eventHook(),
      sync: {
        get(key) {
          return Promise.resolve(copy(key == null ? data : (key in data ? { [key]: data[key] } : {})));
        },
        set(values) {
          const snapshot = copy(values);
          calls.sets.push(snapshot);
          Object.assign(data, snapshot);
          api.storage.onChanged.emit({}, 'sync');
          return Promise.resolve();
        },
        remove(key) {
          calls.removes.push(key);
          delete data[key];
          api.storage.onChanged.emit({}, 'sync');
          return Promise.resolve();
        },
      },
    },
    contextMenus: {
      onClicked: eventHook(),
      removeAll() { calls.removeAll++; calls.menus = []; return Promise.resolve(); },
      create(properties, callback) { calls.menus.push(copy(properties)); callback?.(); },
    },
    action: { onClicked: eventHook() },
    tabs: {
      query() { return Promise.resolve([{ id: 7 }]); },
      sendMessage(tabId, message, options) {
        calls.sends.push({ tabId, message: copy(message), options: options && copy(options) });
        return Promise.resolve({ ok: true });
      },
    },
  };
  return { api, data, calls };
}
function harness(t, entry, html = '<input id="target"><input id="other"><button id="button">Go</button>', initial = {}, apiName = 'chrome', setup = () => {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only' });
  t.after(() => dom.window.close()); // also clears any pending workflow timers
  const mock = mockApi(initial);
  dom.window[apiName] = mock.api;
  const errors = [];
  dom.window.console.error = (...args) => errors.push(args.join(' '));
  dom.window.confirm = () => true;
  const filename = path.join(root, '_build/default/src', `${entry}.bc.js`);
  assert.ok(fs.existsSync(filename), `Missing ${filename}; build the extension before running tests`);
  if (entry !== 'background') {
    const fengari = path.join(root, '_build/fengari.js');
    assert.ok(fs.existsSync(fengari), `Missing ${fengari}; build the extension before running tests`);
    vm.runInContext(fs.readFileSync(fengari, 'utf8'), dom.getInternalVMContext(), { filename: fengari });
  }
  setup(dom.window);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  return { ...mock, dom, window: dom.window, document: dom.window.document, errors };
}
function luaQuote(value) {
  return '"' + value.replace(/["\\\x00-\x1f\x7f]/g, c => c === '"' ? '\\"' : c === '\\' ? '\\\\' : `\\${c.charCodeAt(0).toString().padStart(3, '0')}`) + '"';
}
function scriptWorkflow(script, extra = {}) {
  return { id: 'test', name: 'Test workflow', script, ...extra };
}
// Keep action regression cases readable, but execute real Lua loops/variables.
function workflow(items = ['alpha'], steps = ['type'], extra = {}) {
  const calls = steps.map(step => {
    if (step === 'type') return 'linput.type(item)';
    if (step.startsWith('click ')) return `linput.click(${luaQuote(step.slice(6))})`;
    if (step.startsWith('delay ')) return `linput.delay(${step.slice(6)})`;
    return `linput.${step}()`;
  });
  return scriptWorkflow(`local items = {${items.map(luaQuote).join(',')}}\nfor _, item in ipairs(items) do\n${calls.join('\n')}\nend\n`, extra);
}
function choose(h, el) {
  el.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, composed: true }));
}
function run(h, w) {
  let response;
  const results = h.api.runtime.onMessage.emit({ kind: 'run', workflow: w }, {}, value => { response = copy(value); });
  assert.deepEqual(results, [false], 'message listener responds synchronously');
  assert.ok(response, 'run message must get a response');
  return response;
}
const status = h => h.document.querySelector('[role="status"]')?.textContent || '';
const finished = h => until(() => /finished/.test(status(h)), 'workflow completion');

for (const apiName of ['chrome', 'browser']) {
  test(`content (${apiName}): contextmenu target, duplicate items, input/change, Enter and click`, async t => {
    const h = harness(t, 'content', undefined, {}, apiName);
    const target = h.document.getElementById('target');
    const other = h.document.getElementById('other');
    const seen = { before: [], input: [], change: [], keys: [], clicks: [] };
    target.addEventListener('beforeinput', e => seen.before.push([e.data, e.inputType, e.bubbles, e.cancelable]));
    target.addEventListener('input', e => seen.input.push([target.value, e.data, e.inputType, e.bubbles]));
    target.addEventListener('change', e => seen.change.push([target.value, e.bubbles]));
    for (const name of ['keydown', 'keypress', 'keyup']) {
      target.addEventListener(name, e => seen.keys.push([name, e.key, e.code, e.keyCode, e.which, e.bubbles]));
    }
    h.document.getElementById('button').addEventListener('click', () => seen.clicks.push(target.value));
    target.addEventListener('contextmenu', e => e.stopPropagation()); // capture survives page handlers
    choose(h, target);
    other.focus(); // the message must not use document.activeElement instead
    assert.deepEqual(run(h, workflow(['one', 'two', 'one'], ['type', 'enter', 'click #button'])), { ok: true });
    await finished(h);
    assert.equal(other.value, '');
    assert.equal(target.value, 'one');
    assert.deepEqual(seen.before, ['one', 'two', 'one'].map(item => [item, 'insertText', true, true]));
    assert.deepEqual(seen.input, ['one', 'two', 'one'].map(item => [item, item, 'insertText', true]));
    assert.deepEqual(seen.change, ['one', 'two', 'one'].map(item => [item, true]));
    assert.deepEqual(seen.keys, Array.from({ length: 3 }, () => ['keydown', 'keypress', 'keyup'].map(name => [name, 'Enter', 'Enter', 13, 13, true])).flat());
    assert.deepEqual(seen.clicks, ['one', 'two', 'one']);
    assert.match(status(h), /3 items/);
  });
}

test('content: Escape cancels a pending delay and a new run is not affected by its stale timer', async t => {
  const h = harness(t, 'content');
  const target = h.document.getElementById('target');
  const values = [];
  target.addEventListener('input', () => values.push(target.value));
  choose(h, target);
  assert.deepEqual(run(h, workflow(['first', 'never'], ['type', 'delay 200', 'click #button'])), { ok: true });
  await sleep(50); // first type has finished and delay is pending
  assert.match(run(h, workflow()).error, /Already running/);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.match(status(h), /stopped/);
  assert.deepEqual(run(h, workflow(['new'])), { ok: true });
  await finished(h);
  await sleep(230);
  assert.deepEqual(values, ['first', 'new']);
  assert.equal(target.value, 'new');
  assert.match(status(h), /finished: 1 items/);
});

test('content: removing the target stops instead of typing into another field', async t => {
  const h = harness(t, 'content');
  const target = h.document.getElementById('target');
  let clicks = 0;
  h.document.getElementById('button').addEventListener('click', () => clicks++);
  choose(h, target);
  run(h, workflow(['first', 'second'], ['type', 'delay 100', 'click #button']));
  await sleep(50);
  target.remove();
  h.document.getElementById('other').focus();
  await until(() => /removed/.test(status(h)), 'removed-target error');
  await sleep(100);
  assert.equal(clicks, 0);
  assert.equal(h.document.getElementById('other').value, '');
  assert.equal(target.value, 'first');
});

test('content: textarea uses its native value setter', async t => {
  const h = harness(t, 'content', '<textarea id="target"></textarea>');
  const el = h.document.getElementById('target');
  // Simulate a framework overriding the instance setter; use the prototype setter.
  Object.defineProperty(el, 'value', {
    get() { return Object.getOwnPropertyDescriptor(h.window.HTMLTextAreaElement.prototype, 'value').get.call(this); },
    set() { assert.fail('instance setter must not be used'); },
  });
  choose(h, el);
  run(h, workflow(['first', 'last']));
  await finished(h);
  assert.equal(el.value, 'last');
});

test('content: a contextmenu on a contenteditable descendant selects its editable ancestor', async t => {
  const h = harness(t, 'content', '<div id="target" contenteditable="true"><span id="child">old</span></div>');
  const el = h.document.getElementById('target');
  // jsdom does not implement isContentEditable (a real browser does).
  Object.defineProperty(el, 'isContentEditable', { value: true });
  Object.defineProperty(h.document.getElementById('child'), 'isContentEditable', { value: true });
  const changes = [];
  el.addEventListener('change', () => changes.push(el.textContent));
  choose(h, h.document.getElementById('child'));
  assert.deepEqual(run(h, workflow(['first', 'last'])), { ok: true });
  await finished(h);
  assert.equal(el.textContent, 'last');
  assert.deepEqual(changes, ['first', 'last']);
});

test('content: submit calls requestSubmit once per item, not form.submit', async t => {
  const h = harness(t, 'content', '<form><input id="target"></form>');
  const target = h.document.getElementById('target');
  const submits = [];
  target.form.requestSubmit = () => submits.push(target.value);
  target.form.submit = () => assert.fail('must not bypass validation with form.submit');
  choose(h, target);
  run(h, workflow(['first', 'last'], ['type', 'submit']));
  await finished(h);
  assert.deepEqual(submits, ['first', 'last']);
});

test('content: cancelled beforeinput stops without input/change or clicks', async t => {
  const h = harness(t, 'content');
  const target = h.document.getElementById('target');
  target.value = 'untouched';
  target.addEventListener('beforeinput', e => e.preventDefault());
  target.addEventListener('input', () => assert.fail('cancelled typing emitted input'));
  h.document.getElementById('button').addEventListener('click', () => assert.fail('cancelled workflow clicked'));
  choose(h, target);
  run(h, workflow(['new'], ['type', 'click #button']));
  await until(() => /cancelled typing/.test(status(h)), 'cancelled typing error');
  assert.equal(target.value, 'untouched');
});

test('background: sync menus are sorted, filtered and rebuilt; messages route to the clicked frame', async t => {
  const a = workflow(['a'], ['type'], { id: 'a', name: 'Alpha 50%' });
  const z = workflow(['z'], ['type'], { id: 'z', name: 'Zebra' });
  const h = harness(t, 'background', '', {
    'workflow:z': z, 'workflow:a': a, unrelated: a,
    'workflow:wrong-key': a, 'workflow:invalid': { id: 'invalid' },
  });
  await until(() => h.calls.menus.length === 4, 'initial menu rebuild');
  assert.deepEqual(h.calls.menus, [
    { id: 'linput', title: 'linput', contexts: ['editable'] },
    { id: 'workflow:a', parentId: 'linput', title: 'Alpha 50%%', contexts: ['editable'] },
    { id: 'workflow:z', parentId: 'linput', title: 'Zebra', contexts: ['editable'] },
    { id: 'manage', parentId: 'linput', title: 'Manage workflows…', contexts: ['editable'] },
  ]);
  h.api.contextMenus.onClicked.emit({ menuItemId: 'workflow:a', frameId: 12 }, { id: 42 });
  await until(() => h.calls.sends.length === 1, 'frame message');
  assert.deepEqual(h.calls.sends[0], { tabId: 42, message: { kind: 'run', workflow: a }, options: { frameId: 12 } });
  h.api.contextMenus.onClicked.emit({ menuItemId: 'workflow:z' }, { id: 43 });
  await until(() => h.calls.sends.length === 2, 'default frame message');
  assert.equal(h.calls.sends[1].options.frameId, 0);
  h.api.contextMenus.onClicked.emit({ menuItemId: 'manage' }, { id: 42 });
  h.api.action.onClicked.emit({ id: 42 });
  assert.equal(h.calls.options, 2);
  const rebuilds = h.calls.removeAll;
  h.api.storage.onChanged.emit({}, 'local');
  await sleep(20);
  assert.equal(h.calls.removeAll, rebuilds);
  delete h.data['workflow:z'];
  h.api.storage.onChanged.emit({}, 'sync');
  h.api.storage.onChanged.emit({}, 'sync'); // exercise the pending rebuild path
  await until(() => h.calls.removeAll >= rebuilds + 2 && h.calls.menus.length === 3, 'coalesced sync rebuilds');
  assert.deepEqual(h.calls.menus.map(menu => menu.id), ['linput', 'workflow:a', 'manage']);
  assert.deepEqual(h.errors, []);
});

function optionsHarness(t, initial = {}, withBridge = false) {
  let bridge;
  const h = harness(t, 'options', fs.readFileSync(path.join(root, 'extension/options.html'), 'utf8'), initial, 'chrome', window => {
    if (!withBridge) return;
    // Deliberately never mirror into the textarea: stale fallback reads must fail.
    let doc = '', start = 0, end = 0;
    const calls = { creates: 0, sets: [], replacements: [] };
    const input = () => window.document.getElementById('script').dispatchEvent(new window.Event('input', { bubbles: true }));
    bridge = window.LinputEditor = {
      calls,
      create() { calls.creates++; },
      getValue() { return doc; },
      setValue(value) { doc = value; start = end = 0; calls.sets.push(value); },
      replaceSelection(value) {
        calls.replacements.push(value);
        doc = doc.slice(0, start) + value + doc.slice(end);
        start = end = start + value.length;
        input();
      },
      select(from, to = from) { start = from; end = to; },
      edit(value) { doc = value; input(); },
    };
  });
  return { ...h, bridge };
}
function fillForm(h, { name = 'My list', script = workflow(['alpha', 'beta', 'alpha']).script } = {}) {
  for (const [id, value] of Object.entries({ name, script })) h.document.getElementById(id).value = value;
}
async function importFile(h, payload) {
  const input = h.document.getElementById('import');
  const text = JSON.stringify(payload);
  // jsdom File lacks File.text(), so provide the File API the extension consumes.
  Object.defineProperty(input, 'files', { configurable: true, value: [{ size: Buffer.byteLength(text), text: () => Promise.resolve(text) }] });
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await sleep(20);
}

test('options: save validates name, empty script and Lua syntax, then updates the existing ID', async t => {
  const h = optionsHarness(t);
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  for (const [form, error] of [
    [{ name: ' ' }, /Name must/],
    [{ script: ' \t\n' }, /Add a Lua script/],
    [{ script: 'local =' }, /workflow.lua:1/],
  ]) {
    fillForm(h, form);
    h.document.getElementById('save').click();
    assert.match(status(h), error);
  }
  assert.equal(h.calls.sets.length, 0);
  const script = workflow(['alpha', 'beta', 'alpha']).script;
  fillForm(h, { name: '  My list  ', script });
  h.document.getElementById('save').click();
  await until(() => /Saved to/.test(status(h)), 'saved workflow');
  const [key] = Object.keys(h.calls.sets[0]);
  const saved = h.data[key];
  assert.equal(key, `workflow:${saved.id}`);
  assert.deepEqual(saved, { id: saved.id, name: 'My list', script });
  fillForm(h, { name: 'Updated', script: 'linput.log("next")' });
  h.document.getElementById('save').click();
  await until(() => h.calls.sets.length === 2 && /Saved to/.test(status(h)), 'updated workflow');
  assert.deepEqual(Object.keys(h.calls.sets[1]), [key]);
  assert.equal(h.data[key].name, 'Updated');
  assert.equal(h.data[key].script, 'linput.log("next")');
});

test('options: bridge document is saved, loaded, reset and used for converter selection', async t => {
  const original = scriptWorkflow('linput.type("original")', { id: 'original', name: 'Original' });
  const h = optionsHarness(t, { 'workflow:original': original }, true);
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  const el = id => h.document.getElementById(id);
  const template = h.bridge.getValue();
  assert.equal(h.bridge.calls.creates, 1);
  assert.deepEqual(h.bridge.calls.sets, [template]);
  assert.equal(el('workflow-count').textContent, '1');
  assert.equal(el('editor-title').textContent, 'Untitled workflow');
  assert.equal(el('editor-state').textContent, 'Unsaved draft');
  assert.equal(el('delete').disabled, true);
  el('script').value = 'local ='; // invalid stale textarea must be ignored
  const script = 'OLD\nlinput.log("bridge")';
  el('name').value = 'Bridge workflow';
  el('name').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.bridge.edit(script);
  assert.equal(el('editor-title').textContent, 'Bridge workflow');
  el('items').value = 'one\t two\n one';
  el('items').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(el('list-count').textContent, '3 items');
  el('convert').click();
  assert.equal(h.bridge.getValue(), script, 'conversion alone leaves bridge document untouched');
  const converted = el('converted').value;
  h.bridge.select(script.indexOf('OLD'), script.indexOf('OLD') + 3);
  el('insert-list').click();
  const inserted = script.replace('OLD', converted);
  assert.equal(h.bridge.getValue(), inserted);
  assert.deepEqual(h.bridge.calls.replacements, [converted]);
  assert.equal(el('script').value, 'local =');
  el('save').click();
  await until(() => /Saved to/.test(status(h)), 'bridge save');
  const key = Object.keys(h.calls.sets[0])[0];
  assert.equal(h.data[key].script, inserted, 'save reads actual bridge document');
  assert.equal(el('workflow-count').textContent, '2');
  assert.equal(el('workflows').value, h.data[key].id);
  assert.equal(el('editor-state').textContent, 'All changes saved');
  assert.equal(el('editor-state').dataset.state, 'saved');
  assert.equal(el('delete').disabled, false);
  el('name').value = 'Renamed';
  el('name').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(el('editor-title').textContent, 'Renamed');
  assert.equal(el('editor-state').textContent, 'Unsaved changes');
  assert.equal(el('editor-state').dataset.state, 'dirty');
  el('name').value = 'Bridge workflow';
  el('name').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(el('editor-state').textContent, 'All changes saved');
  h.bridge.edit(inserted + '\n-- edit');
  assert.equal(el('editor-state').textContent, 'Unsaved changes');
  h.bridge.edit(inserted);
  el('workflows').value = 'original';
  el('workflows').dispatchEvent(new h.window.Event('change'));
  assert.equal(h.bridge.getValue(), original.script);
  assert.equal(el('name').value, original.name);
  assert.equal(el('editor-title').textContent, original.name);
  assert.equal(el('editor-state').textContent, 'All changes saved');
  el('new').click();
  assert.equal(h.bridge.getValue(), template);
  assert.equal(el('name').value, '');
  assert.equal(el('workflows').value, '');
  assert.equal(el('items').value, '');
  assert.equal(el('converted').value, '');
  assert.equal(el('list-count').textContent, '0 items');
  assert.equal(el('workflow-count').textContent, '2');
  assert.equal(el('editor-state').textContent, 'Unsaved draft');
});

for (const withBridge of [false, true]) {
  test(`options: discard cancellation preserves ${withBridge ? 'bridge' : 'textarea'} editor and current workflow`, async t => {
    const original = scriptWorkflow('linput.log("original")', { id: 'original', name: 'Original' });
    const other = scriptWorkflow('linput.log("other")', { id: 'other', name: 'Other' });
    const h = optionsHarness(t, { 'workflow:original': original, 'workflow:other': other }, withBridge);
    await until(() => /New workflow/.test(status(h)), 'options initialization');
    const el = id => h.document.getElementById(id);
    const read = () => withBridge ? h.bridge.getValue() : el('script').value;
    const edit = value => {
      if (withBridge) h.bridge.edit(value);
      else { el('script').value = value; el('script').dispatchEvent(new h.window.Event('input', { bubbles: true })); }
    };
    const load = id => { el('workflows').value = id; el('workflows').dispatchEvent(new h.window.Event('change')); };
    load('original');
    const modified = original.script + '\n-- unsaved';
    edit(modified);
    el('name').value = 'Changed';
    el('name').dispatchEvent(new h.window.Event('input', { bubbles: true }));
    el('items').value = 'keep converter input';
    const messages = [];
    h.window.confirm = message => { messages.push(message); return false; };
    const beforeStatus = status(h);
    el('new').click();
    load('other');
    assert.equal(messages.length, 2);
    assert.match(messages[0], /Discard.*new workflow/);
    assert.match(messages[1], /Discard.*another workflow/);
    assert.equal(read(), modified);
    assert.equal(el('name').value, 'Changed');
    assert.equal(el('editor-title').textContent, 'Changed');
    assert.equal(el('items').value, 'keep converter input');
    assert.equal(el('workflows').value, 'original');
    assert.equal(el('editor-state').textContent, 'Unsaved changes');
    assert.equal(status(h), beforeStatus);
    assert.equal(h.calls.sets.length, 0);
    h.window.confirm = () => true;
    load('other');
    assert.equal(read(), other.script);
    assert.equal(el('editor-state').textContent, 'All changes saved');
    edit(other.script + '\n-- another edit');
    el('new').click();
    assert.notEqual(read(), other.script);
    assert.equal(el('workflows').value, '');
    assert.equal(el('editor-state').textContent, 'Unsaved draft');
  });
}

test('options: syntax checks compile bridge text without running it; document shortcuts act once', async t => {
  const h = optionsHarness(t, {}, true);
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  const el = id => h.document.getElementById(id);
  el('script').value = 'local =';
  el('name').value = 'Shortcut workflow';
  const source = 'error("MUST NOT RUN"); linput.type("never")';
  h.bridge.edit(source);
  const clicks = { save: 0, validate: 0 };
  for (const id of Object.keys(clicks)) el(id).addEventListener('click', () => clicks[id]++);
  el('validate').click();
  assert.match(status(h), /^Syntax valid/);
  assert.equal(h.calls.sets.length, 0);
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.bridge.getValue(), source);
  for (const script of [' \n\t', 'local =', '--' + 'x'.repeat(20000)]) {
    h.bridge.edit(script);
    el('validate').click();
    assert.match(status(h), /Error:/);
  }
  h.bridge.edit(source);
  const shortcut = (key, modifier, prevented = false) => {
    const event = new h.window.KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true });
    if (prevented) event.preventDefault();
    el('name').dispatchEvent(event);
    return event;
  };
  const before = { ...clicks };
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.equal(shortcut('Enter', modifier).defaultPrevented, true);
    assert.match(status(h), /^Syntax valid/);
    assert.equal(shortcut(modifier === 'ctrlKey' ? 's' : 'S', modifier).defaultPrevented, true);
    await until(() => !el('save').disabled && /Saved to/.test(status(h)), 'shortcut save');
  }
  assert.equal(clicks.validate, before.validate + 2);
  assert.equal(clicks.save, 2);
  assert.equal(h.calls.sets.length, 2);
  assert.deepEqual(Object.keys(h.calls.sets[0]), Object.keys(h.calls.sets[1]), 'shortcut saves update the same ID');
  const savedClicks = { ...clicks };
  for (const modifier of ['ctrlKey', 'metaKey']) {
    shortcut('s', modifier, true);
    shortcut('Enter', modifier, true);
  }
  assert.equal(shortcut('x', 'ctrlKey').defaultPrevented, false);
  assert.equal(shortcut('s', 'shiftKey').defaultPrevented, false);
  await sleep(20);
  assert.deepEqual(clicks, savedClicks, 'editor-handled shortcuts must not click actions a second time');
  assert.equal(h.calls.sets.length, 2);
  assert.equal(h.calls.sends.length, 0);
});

test('options: import rejects invalid data atomically and merges valid workflows by ID', async t => {
  const original = workflow(['old'], ['type'], { id: 'old', name: 'Original' });
  const h = optionsHarness(t, { 'workflow:old': original });
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  await importFile(h, { version: 3, workflows: [original] });
  assert.match(status(h), /Unsupported export version/);
  await importFile(h, { version: 2, workflows: [workflow(), scriptWorkflow('local =', { id: 'bad' })] });
  assert.match(status(h), /workflow.lua:1/);
  assert.equal(h.calls.sets.length, 0);
  assert.deepEqual(h.data, { 'workflow:old': original });
  const replacement = workflow(['new', 'new'], ['type'], { id: 'old', name: 'Replaced' });
  const added = workflow(['extra'], ['type'], { id: 'added', name: 'Added' });
  await importFile(h, { version: 2, workflows: [replacement, added] });
  await until(() => status(h) === 'Imported.', 'successful import');
  assert.deepEqual(h.data, { 'workflow:old': replacement, 'workflow:added': added });
  assert.equal(h.calls.sets.length, 1);
  assert.deepEqual(Array.from(h.document.getElementById('workflows').options, option => option.textContent), ['Choose a workflow…', 'Added', 'Replaced']);
});

test('content: tab sends keys, skips invisible/disabled fields and updates the target', async t => {
  const h = harness(t, 'content', '<input id="target"><input id="hidden"><input disabled id="disabled"><input id="other">');
  for (const id of ['target', 'disabled', 'other']) h.document.getElementById(id).getClientRects = () => [{ width: 10, height: 10 }];
  const keys = [];
  h.document.getElementById('target').addEventListener('keydown', e => keys.push([e.key, e.keyCode]));
  h.document.getElementById('other').addEventListener('keyup', e => keys.push([e.key, e.keyCode]));
  choose(h, h.document.getElementById('target'));
  run(h, scriptWorkflow('linput.type("first"); linput.tab(); linput.type("second")'));
  await finished(h);
  assert.equal(h.document.getElementById('target').value, 'first');
  assert.equal(h.document.getElementById('other').value, 'second');
  assert.equal(h.document.getElementById('hidden').value, '');
  assert.deepEqual(keys, [['Tab', 9], ['Tab', 9]]);
});

test('content: Lua functions, tables, interpolated variables, branches and helper APIs', async t => {
  const h = harness(t, 'content');
  const logs = [];
  h.window.console.log = message => logs.push(message);
  choose(h, h.document.getElementById('target'));
  const values = [];
  h.document.getElementById('other').addEventListener('input', () => values.push(h.document.getElementById('other').value));
  run(h, scriptWorkflow(`
local function decorate(word, i) return string.upper(word) .. ":" .. tostring(i * 2) end
local words = linput.split("one\\t two\\n one")
table.insert(words, "last")
assert(#words == 4)
assert(linput.exists("#other"))
assert(not linput.exists("#missing"))
linput.focus("#other")
for i, word in ipairs(words) do
  if word ~= "last" then linput.type(decorate(word, i)) else linput.type("done") end
end
assert(linput.value() == "done")
linput.log(table.concat(words, ","))
`));
  await finished(h);
  assert.deepEqual(values, ['ONE:2', 'TWO:4', 'ONE:6', 'done']);
  assert.equal(h.document.getElementById('target').value, '');
  assert.deepEqual(logs, ['linput: one,two,one,last']);
  assert.match(status(h), /one,two,one,last/);
});

test('content: sandbox omits unsupported globals and string.format (deliberate dependency advisory)', async t => {
  const h = harness(t, 'content');
  choose(h, h.document.getElementById('target'));
  run(h, scriptWorkflow(`
for _, name in ipairs({"js", "window", "document", "fetch", "require", "package", "io", "os", "debug", "coroutine", "load", "loadfile", "dofile", "collectgarbage", "print"}) do
  assert(_G[name] == nil, name .. " must be absent")
end
assert(string.format == nil, "format disabled due to dependency advisory")
assert(string.dump == nil)
linput.type(string.rep("ok", 2))
`));
  await finished(h);
  assert.equal(h.document.getElementById('target').value, 'okok');
});

test('content: syntax errors reject run; runtime errors stop without later actions', async t => {
  const h = harness(t, 'content');
  choose(h, h.document.getElementById('target'));
  assert.match(run(h, scriptWorkflow('local =')).error, /workflow.lua:1/);
  assert.deepEqual(run(h, scriptWorkflow('linput.type("before"); error("intentional failure"); linput.type("never")')), { ok: true });
  await until(() => /intentional failure/.test(status(h)), 'Lua runtime error');
  assert.equal(h.document.getElementById('target').value, 'before');
  run(h, workflow(['recovered']));
  await finished(h);
});

test('content: Lua delay rejects invalid arguments', async t => {
  const h = harness(t, 'content');
  choose(h, h.document.getElementById('target'));
  for (const arg of ['-1', '60001', '1.5', '"10"', 'nil', 'true', '0/0', 'math.huge']) {
    assert.deepEqual(run(h, scriptWorkflow(`linput.delay(${arg}); linput.type("never")`)), { ok: true });
    assert.match(status(h), /delay must be an integer from 0 to 60000 ms/, arg);
  }
  assert.equal(h.document.getElementById('target').value, '');
});

test('content: instruction-only infinite loop yields to Escape and stale slices cannot affect a new run', { timeout: 5000 }, async t => {
  const h = harness(t, 'content');
  choose(h, h.document.getElementById('target'));
  assert.deepEqual(run(h, scriptWorkflow('while true do end')), { ok: true });
  await sleep(20);
  assert.match(run(h, workflow()).error, /Already running/);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.match(status(h), /stopped/);
  run(h, workflow(['after loop']));
  await finished(h);
  await sleep(30);
  assert.equal(h.document.getElementById('target').value, 'after loop');
  assert.match(status(h), /finished/);
});

for (const script of ['while true do end', 'while true do pcall(function() while true do end end) end']) {
  test(`content: host instruction limit cannot be bypassed: ${script}`, { timeout: 10000 }, async t => {
    const h = harness(t, 'content');
    choose(h, h.document.getElementById('target'));
    assert.deepEqual(run(h, scriptWorkflow(script)), { ok: true });
    await until(() => /instruction limit exceeded/.test(status(h)), '5-million instruction limit', 8000);
    assert.equal(h.document.getElementById('target').value, '');
    run(h, workflow(['after limit']));
    await finished(h);
  });
}

test('options: converter escapes quotes, backslashes, Unicode/control-digit adjacency and preserves duplicates; insert replaces selection', async t => {
  const h = optionsHarness(t);
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  const editor = h.document.getElementById('script');
  h.document.getElementById('insert-list').click();
  assert.match(status(h), /Convert a list first/);
  const items = ['a"b', 'c\\d', '雪é🙂', '\u00017', '\u007f9', 'a"b'];
  h.document.getElementById('items').value = items.join(' \t\r\n');
  editor.value = '-- before\nOLD\nfor _, item in ipairs(items) do linput.type(item) end';
  const original = editor.value;
  h.document.getElementById('convert').click();
  const converted = h.document.getElementById('converted').value;
  assert.match(status(h), /Converted 6 items/);
  assert.equal(editor.value, original, 'conversion must not mutate script');
  assert.match(converted, /\\0017/);
  assert.match(converted, /\\1279/);
  editor.setSelectionRange(10, 13);
  h.document.getElementById('insert-list').click();
  assert.equal(editor.value, original.slice(0, 10) + converted + original.slice(13));
  assert.equal(editor.selectionStart, 10 + converted.length);
  assert.equal(editor.selectionEnd, editor.selectionStart);
  assert.equal(h.document.activeElement, editor);
  const content = harness(t, 'content');
  const values = [];
  const target = content.document.getElementById('target');
  target.addEventListener('input', () => values.push(target.value));
  choose(content, target);
  run(content, scriptWorkflow(editor.value));
  await finished(content);
  assert.deepEqual(values, items, 'execute converted Lua, not just compare quoting text');
  editor.setSelectionRange(editor.value.length, editor.value.length);
  const beforeAppend = editor.value;
  h.document.getElementById('insert-list').click();
  assert.equal(editor.value, beforeAppend + converted);
});

test('options: legacy workflows load lazily, save as script, import v1 migrates, export is v2', async t => {
  const legacy = { id: 'old', name: 'Legacy', items: ['a"b', 'a"b', '雪'], steps: ['type', 'enter', 'tab', 'delay 0', 'click #button', 'submit'] };
  const h = optionsHarness(t, { 'workflow:old': legacy });
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  assert.equal(h.calls.sets.length, 0);
  const select = h.document.getElementById('workflows');
  select.value = 'old';
  select.dispatchEvent(new h.window.Event('change'));
  assert.match(status(h), /^Loaded\./);
  const migrated = h.document.getElementById('script').value;
  assert.match(migrated, /for _, item in ipairs\(items\) do/);
  for (const action of ['type', 'enter', 'tab', 'delay', 'click', 'submit']) assert.ok(migrated.includes(`linput.${action}(`));
  assert.deepEqual(h.data['workflow:old'], legacy, 'loading alone does not write migration');
  h.document.getElementById('save').click();
  await until(() => /Saved to/.test(status(h)), 'legacy save');
  assert.deepEqual(h.data['workflow:old'], { id: 'old', name: 'Legacy', script: migrated });
  const imported = { ...legacy, id: 'imported', name: 'Imported legacy' };
  await importFile(h, { version: 1, workflows: [imported] });
  assert.equal(status(h), 'Imported.');
  assert.deepEqual(h.data['workflow:imported'], { id: 'imported', name: 'Imported legacy', script: migrated });
  let exported;
  h.window.Blob = class { constructor(parts, options) { exported = JSON.parse(parts.join('')); assert.equal(options.type, 'application/json'); } };
  h.window.URL.createObjectURL = () => 'blob:https://example.test/export';
  h.window.URL.revokeObjectURL = () => {};
  let download;
  h.window.HTMLAnchorElement.prototype.click = function() { download = this.download; };
  h.document.getElementById('export').click();
  await until(() => exported !== undefined, 'export');
  assert.equal(download, 'linput-workflows.json');
  assert.deepEqual(exported, { version: 2, workflows: [h.data['workflow:imported'], h.data['workflow:old']] });
  const content = harness(t, 'content');
  const target = content.document.getElementById('target');
  const values = [];
  target.addEventListener('input', () => values.push(target.value));
  choose(content, target);
  run(content, { ...legacy, steps: ['type'] });
  await finished(content);
  assert.deepEqual(values, legacy.items);
  assert.equal(target.value, '雪');
});

test('options: trimmed names are clean immediately after save', async t => {
  const h = optionsHarness(t);
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  fillForm(h, {name:'  Trimmed name  '});
  h.document.getElementById('name').dispatchEvent(new h.window.Event('input'));
  h.document.getElementById('save').click();
  await until(() => /Saved to/.test(status(h)), 'save');
  assert.equal(h.document.getElementById('name').value, 'Trimmed name');
  assert.equal(h.document.getElementById('editor-state').textContent, 'All changes saved');
  h.window.confirm = () => assert.fail('clean saved workflow should not prompt to discard');
  h.document.getElementById('new').click();
  assert.match(status(h), /New workflow/);
});

test('options: pending save prevents duplicate saves and preserves newer edits as unsaved', async t => {
  const h = optionsHarness(t);
  await until(() => /New workflow/.test(status(h)), 'options initialization');
  fillForm(h, {name:'  Snapshot  ', script:'linput.log("snapshot")'});
  const originalSet = h.api.storage.sync.set;
  let resolve, attempts = 0;
  h.api.storage.sync.set = values => {
    attempts++;
    return new Promise(done => {resolve = () => originalSet(values).then(done);});
  };
  h.document.getElementById('save').click();
  for (const id of ['save', 'new', 'workflows', 'import', 'delete']) assert.equal(h.document.getElementById(id).disabled, true, id);
  h.document.getElementById('save').click();
  assert.equal(attempts, 1);
  fillForm(h, {name:'Newer draft', script:'linput.log("newer")'});
  h.document.getElementById('script').dispatchEvent(new h.window.Event('input'));
  resolve();
  await until(() => /Saved snapshot/.test(status(h)), 'snapshot save');
  assert.equal(h.document.getElementById('name').value, 'Newer draft');
  assert.equal(h.document.getElementById('script').value, 'linput.log("newer")');
  assert.equal(h.document.getElementById('editor-state').textContent, 'Unsaved changes');
  assert.equal(Object.values(h.data)[0].name, 'Snapshot');
  assert.equal(Object.values(h.data)[0].script, 'linput.log("snapshot")');
  assert.equal(h.document.getElementById('save').disabled, false);
});
