// Thin CodeMirror UI adapter. Workflow state, validation and browser actions
// remain in OxCaml; no script is evaluated here.
import {EditorState} from '@codemirror/state';
import {EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine,
  drawSelection, dropCursor, rectangularSelection} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching,
  indentOnInput, foldGutter, foldKeymap, syntaxTree} from '@codemirror/language';
import {autocompletion, completionKeymap, snippetCompletion} from '@codemirror/autocomplete';
import {closeBrackets, closeBracketsKeymap} from '@codemirror/autocomplete';
import {searchKeymap, highlightSelectionMatches} from '@codemirror/search';
import {lua} from '@codemirror/legacy-modes/mode/lua';
import {tags} from '@lezer/highlight';
import {linter, lintGutter, lintKeymap, setDiagnostics} from '@codemirror/lint';

const api = [
  ['type', '(text)', 'Replace the current target with text.', 'type(${text})'],
  ['enter', '()', 'Send a synthetic Enter key.', 'enter()'],
  ['delay', '(ms)', 'Pause for 0–60000 milliseconds.', 'delay(${250})'],
  ['click', '(selector)', 'Click the first matching element in this frame.', 'click("${selector}")'],
  ['tab', '()', 'Move focus forward to the next visible control.', 'tab()'],
  ['submit', '()', 'Validate and submit the target’s form. May navigate.', 'submit()'],
  ['focus', '(selector)', 'Choose a matching editable field as the new target.', 'focus("${selector}")'],
  ['value', '() → string', 'Read the current target’s text.', 'value()'],
  ['exists', '(selector) → boolean', 'Check if a CSS selector matches an element.', 'exists("${selector}")'],
  ['log', '(text)', 'Write a message to the run status and console.', 'log("${message}")'],
  ['split', '(text) → table', 'Split whitespace-separated text; preserve duplicates.', 'split("${items}")'],
];
const members = {
  linput: api.map(([label, detail, info, template]) => snippetCompletion(template, {label, detail, info, type:'function', boost:10})),
  string: ['upper', 'lower', 'sub', 'gsub', 'gmatch', 'match', 'find', 'len', 'rep', 'reverse', 'byte', 'char'].map(label => ({label, type:'function'})),
  table: ['insert', 'remove', 'concat', 'sort', 'unpack', 'pack', 'move'].map(label => ({label, type:'function'})),
  math: ['abs', 'ceil', 'floor', 'max', 'min', 'random', 'sqrt', 'sin', 'cos', 'pi', 'huge'].map(label => ({label, type: label === 'pi' || label === 'huge' ? 'constant':'function'})),
  utf8: ['char', 'codes', 'codepoint', 'len', 'offset', 'charpattern'].map(label => ({label, type:'function'})),
};
const globals = [
  ...['linput', 'string', 'table', 'math', 'utf8'].map(label => ({label, type:'namespace'})),
  ...['ipairs', 'pairs', 'tostring', 'tonumber', 'assert', 'error', 'pcall', 'xpcall', 'type', 'next', 'select', 'rawget', 'rawset', 'rawequal', 'getmetatable', 'setmetatable'].map(label => ({label, type:'function'})),
  ...['local', 'end', 'then', 'else', 'elseif', 'do', 'return', 'break', 'in', 'and', 'or', 'not', 'true', 'false', 'nil'].map(label => ({label, type:'keyword'})),
  snippetCompletion('for _, ${item} in ipairs(${items}) do\n  ${}\nend', {label:'for', detail:'each item', type:'keyword', boost:5}),
  snippetCompletion('if ${condition} then\n  ${}\nend', {label:'if', detail:'conditional', type:'keyword', boost:5}),
  snippetCompletion('local function ${name}(${args})\n  ${}\nend', {label:'function', detail:'local helper', type:'keyword'}),
  snippetCompletion('while ${condition} do\n  ${}\nend', {label:'while', detail:'loop', type:'keyword'}),
  snippetCompletion('repeat\n  ${}\nuntil ${condition}', {label:'repeat', detail:'loop', type:'keyword'}),
];
function completeLua(context) {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (/string|comment/i.test(node.name)) return null;
  const word = context.matchBefore(/[A-Za-z_][\w.]*/);
  if (!word && !context.explicit) return null;
  if (word && word.text.includes('.')) {
    const dot = word.text.lastIndexOf('.');
    const namespace = word.text.slice(0, dot);
    if (!members[namespace]) return null;
    return {from:word.from + dot + 1, options:members[namespace], validFor:/^\w*$/};
  }
  const options = [...globals];
  // Offer names already declared in this script as well as built-in functions.
  const declared = new Set();
  const source = context.state.doc.toString();
  for (const match of source.matchAll(/\blocal\s+(?:function\s+)?([A-Za-z_]\w*)/g)) declared.add(match[1]);
  for (const match of source.matchAll(/\bfor\s+([A-Za-z_]\w*)(?:\s*,\s*([A-Za-z_]\w*))?/g)) {
    declared.add(match[1]); if (match[2]) declared.add(match[2]);
  }
  for (const label of declared) options.push({label, type:'variable', boost:2});
  return {from:word ? word.from:context.pos, options, validFor:/^\w*$/};
}

const theme = EditorView.theme({
  '&': {color:'#dbe5ee', backgroundColor:'#141e29', fontSize:'13px', height:'100%'},
  '.cm-scroller': {fontFamily:'"IBM Plex Mono", "SFMono-Regular", Consolas, monospace', lineHeight:'1.85', overflow:'auto'},
  '.cm-content': {padding:'22px 0', caretColor:'#82e5bf', minHeight:'430px'},
  '.cm-line': {padding:'0 26px 0 12px'},
  '.cm-gutters': {backgroundColor:'#141e29', color:'#657689', border:'none', padding:'0 0 0 12px'},
  '.cm-gutterElement': {padding:'0 2px'},
  '.cm-lineNumbers .cm-gutterElement': {padding:'0 8px 0 3px', minWidth:'28px'},
  '.cm-foldGutter .cm-gutterElement': {width:'12px', padding:'0', textAlign:'center'},
  '.cm-lintGutter .cm-gutterElement': {width:'12px', padding:'0'},
  '.cm-activeLineGutter': {color:'#b9cbd7', backgroundColor:'transparent'},
  '.cm-activeLine': {backgroundColor:'#ffffff04'},
  '.cm-cursor, .cm-dropCursor': {borderLeftColor:'#82e5bf'},
  '&.cm-focused': {outline:'none'},
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {backgroundColor:'#315448 !important'},
  '.cm-matchingBracket': {backgroundColor:'#365647', outline:'1px solid #709b83', color:'#f0fff6'},
  '.cm-foldPlaceholder': {backgroundColor:'#2a3b48', borderColor:'#536774', color:'#d4e9dd'},
  '.cm-tooltip': {backgroundColor:'#20303d', border:'1px solid #4b616c', borderRadius:'8px', color:'#e0eced', boxShadow:'0 8px 24px #0005'},
  '.cm-tooltip-autocomplete > ul': {fontFamily:'inherit', maxHeight:'240px'},
  '.cm-tooltip-autocomplete > ul > li': {padding:'5px 12px'},
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {backgroundColor:'#315b50', color:'#f1fff6'},
  '.cm-completionLabel': {fontFamily:'"IBM Plex Mono", "SFMono-Regular", Consolas, monospace', fontSize:'12px'},
  '.cm-completionDetail': {color:'#a7c5be', marginLeft:'12px', fontSize:'11px', fontStyle:'normal'},
  '.cm-completionInfo': {padding:'10px 12px', maxWidth:'270px', fontFamily:'system-ui', fontSize:'12px', lineHeight:'1.5'},
  '.cm-searchMatch': {backgroundColor:'#a17d3044', outline:'1px solid #bda34d'},
  '.cm-searchMatch.cm-searchMatch-selected': {backgroundColor:'#a17d3077'},
  '.cm-panels': {backgroundColor:'#1e2d39', color:'#dbe5ee'},
  '.cm-panel.cm-search': {padding:'8px 12px', fontFamily:'system-ui', fontSize:'12px'},
  '.cm-textfield': {backgroundColor:'#141e29', color:'#dbe5ee', border:'1px solid #58717c', borderRadius:'4px'},
  '.cm-button': {backgroundImage:'none', backgroundColor:'#2b4e43', color:'#e4f4eb', border:'1px solid #557b66', borderRadius:'4px'},
}, {dark:true});
const highlight = HighlightStyle.define([
  {tag:tags.keyword, color:'#91d5b6'},
  {tag:[tags.string, tags.special(tags.string)], color:'#e8c791'},
  {tag:tags.number, color:'#c5aff2'},
  {tag:tags.comment, color:'#8194a5', fontStyle:'italic'},
  {tag:[tags.bool, tags.null], color:'#c5aff2'},
  {tag:[tags.operator, tags.punctuation], color:'#a3b6c5'},
  {tag:[tags.function(tags.variableName), tags.standard(tags.variableName)], color:'#89c3e6'},
  {tag:tags.definition(tags.variableName), color:'#e3edf0'},
]);

function syntaxDiagnostics(editor) {
  if (typeof window.LinputLuaCheck !== 'function') return [];
  const source = editor.state.doc.toString();
  if (!source.trim()) return [];
  const error = window.LinputLuaCheck(source);
  if (!error) return [];
  const match = error.match(/workflow\.lua:(\d+):/);
  const line = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, match ? Number(match[1]) : 1)));
  return [{from:line.from, to:line.to, severity:'error', message:error}];
}

let view;
function editorChanged() {
  const field = document.getElementById('script');
  field.value = view.state.doc.toString();
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const position = document.getElementById('cursor-position');
  if (position) position.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
  field.dispatchEvent(new Event('input', {bubbles:true}));
}
const bridge = {
  create() {
    if (view || !document.getElementById('code-editor')) return;
    const field = document.getElementById('script');
    view = new EditorView({
      parent:document.getElementById('code-editor'),
      state:EditorState.create({doc:field.value, extensions:[
        lineNumbers(), highlightActiveLineGutter(), history(), foldGutter(), lintGutter(),
        linter(syntaxDiagnostics, {delay:400}),
        drawSelection(), dropCursor(), rectangularSelection(), indentOnInput(), EditorView.lineWrapping,
        bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches(),
        StreamLanguage.define(lua), syntaxHighlighting(highlight), theme,
        autocompletion({override:[completeLua], activateOnTyping:true, activateOnTypingDelay:120}),
        keymap.of([
          {key:'Mod-s', run:() => {document.getElementById('save').click(); return true;}},
          {key:'Mod-Enter', run:() => {document.getElementById('validate').click(); return true;}},
          ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap,
          ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab,
        ]),
        EditorView.contentAttributes.of({'aria-label':'Lua script editor', 'aria-describedby':'script-help', 'spellcheck':'false'}),
        EditorView.updateListener.of(update => {
          if (update.docChanged) editorChanged();
          else if (update.selectionSet) {
            const line = update.state.doc.lineAt(update.state.selection.main.head);
            const position = document.getElementById('cursor-position');
            if (position) position.textContent = `Ln ${line.number}, Col ${update.state.selection.main.head - line.from + 1}`;
          }
        }),
      ]}),
    });
    const library = document.getElementById('library-disclosure');
    if (library) {
      const mobile = window.matchMedia('(max-width:620px)');
      const adapt = () => {library.open = !mobile.matches;};
      mobile.addEventListener('change', adapt);
      adapt();
    }
    field.hidden = true;
    field.setAttribute('aria-hidden', 'true');
    document.querySelector('label[for="script"]')?.setAttribute('for', 'code-editor');
    editorChanged();
  },
  getValue() { return view ? view.state.doc.toString():document.getElementById('script').value; },
  setValue(text) {
    document.getElementById('script').value = text;
    if (view && view.state.doc.toString() !== text) {
      view.dispatch({changes:{from:0, to:view.state.doc.length, insert:text}, selection:{anchor:0}});
      // Diagnostics belong to the old document, not to a newly opened workflow.
      view.dispatch(setDiagnostics(view.state, []));
    }
  },
  checkSyntax() {
    if (view) view.dispatch(setDiagnostics(view.state, syntaxDiagnostics(view)));
  },
  replaceSelection(text) {
    if (view) {view.dispatch(view.state.replaceSelection(text)); view.focus();}
    else {
      const field = document.getElementById('script');
      field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
      field.dispatchEvent(new Event('input', {bubbles:true})); field.focus();
    }
  },
  select(from, to) {
    if (view) view.dispatch({selection:{anchor:from, head:to}});
    else document.getElementById('script').setSelectionRange(from, to);
  },
  focus() { if (view) view.focus(); else document.getElementById('script').focus(); },
};
window.LinputEditor = bridge;
