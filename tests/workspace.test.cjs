const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app/webui_cn/app.js'), 'utf8');

test('dashboard quick prompts reach the question handler', () => {
  let click, asked;
  const item = { dataset: { ask: '总结资料' } };
  const sandbox = {
    $: () => ({ addEventListener() {} }),
    document: { addEventListener: (name, fn) => { click = fn; } },
    showView() {}, qBox: { value: '', focus() {} },
    ask: question => { asked = question; },
  };
  vm.createContext(sandbox);
  const start = source.indexOf('$("#side-nav").addEventListener');
  const end = source.indexOf('/* ── 健康徽章');
  vm.runInContext(source.slice(start, end), sandbox);
  click({ target: { closest: selector => selector === '[data-ask]' ? item : null } });
  assert.equal(asked, '总结资料');
});

test('document and node labels cannot break out of quoted HTML attributes', () => {
  const start = source.indexOf('function escapeHtml(');
  const end = source.indexOf('function renderMd(');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  assert.equal(sandbox.escapeHtml('"<报告>&'), '&quot;&lt;报告&gt;&amp;');
});
