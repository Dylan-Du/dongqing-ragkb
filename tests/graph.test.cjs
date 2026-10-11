const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped graph functions; DOM/canvas boundaries are minimal doubles
// so geometry and animation scheduling can be checked without a browser.
function graph() {
  const source = fs.readFileSync(path.join(__dirname, '../app/webui_cn/app.js'), 'utf8');
  const section = source.slice(source.indexOf('const viewGraph ='), source.indexOf('/* ── 模型接入'));
  const elements = new Map(), frames = [], listeners = new Map(), drawnLabels = [];
  const ctx = new Proxy({ measureText: text => ({ width: text.length * 12 }), fillText: text => drawnLabels.push(text) }, {
    get: (target, key) => target[key] ?? (() => {}),
  });
  function $(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, clientWidth: 900, clientHeight: 600,
      width: 300, height: 150, style: {}, textContent: '', innerHTML: '', value: '',
      getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addEventListener: (event, fn) => listeners.set(id + ':' + event, fn),
      querySelectorAll: () => [],
    });
    return elements.get(id);
  }
  const sandbox = { $, console, Map, Set, Math, window: { devicePixelRatio: 2, addEventListener() {} },
    requestAnimationFrame: fn => frames.push(fn), setTimeout: () => {},
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
  };
  $('#view-graph').hidden = true;
  Object.assign($('#graph-wrap'), { clientWidth: 0, clientHeight: 0 });
  vm.createContext(sandbox);
  vm.runInContext(section + '\nthis.graphState = G; this.draw = render; this.resize = gResize; this.pick = pickNode; this.fit = zoomFit; this.load = loadGraphData;', sandbox);
  $('#view-graph').hidden = false;
  Object.assign($('#graph-wrap'), { clientWidth: 900, clientHeight: 600 });
  return { G: sandbox.graphState, sandbox, $, frames, listeners, drawnLabels };
}

module.exports = { graph };

test('graph maintains one animation callback after every frame', () => {
  const { frames } = graph();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(frames.length, 1);
});

test('entering or resizing the graph updates the canvas backing resolution', () => {
  const g = graph();
  g.sandbox.resize(); g.sandbox.draw();
  assert.equal(g.$('#graph-canvas').width, 1800);
  assert.equal(g.$('#graph-canvas').height, 1200);
});

test('wheel zoom preserves the world point underneath the pointer', () => {
  const g = graph();
  Object.assign(g.G, { zoom: 2, panX: 100, panY: 50 });
  const wheel = g.listeners.get('#graph-canvas:wheel');
  wheel({ preventDefault() {}, clientX: 300, clientY: 250, deltaY: -200 });
  assert.ok(Math.abs((300 - g.G.panX) / g.G.zoom - 100) < 1e-8);
  assert.ok(Math.abs((250 - g.G.panY) / g.G.zoom - 100) < 1e-8);
});

test('node selection chooses the nearest hit, independently of data ordering', () => {
  const g = graph();
  g.G.nodes = [{ id: 'near', type: 'concept' }, { id: 'far', type: 'concept' }];
  g.G.pos.set('near', { x: 2, y: 0 });
  g.G.pos.set('far', { x: 5, y: 0 });
  assert.equal(g.sandbox.pick(0, 0).id, 'near');
});

test('zoom buttons keep the center point in the same position', () => {
  const g = graph();
  Object.assign(g.G, { zoom: 2, panX: 100, panY: 50, width: 900, height: 600 });
  g.listeners.get('#g-zin:click')();
  assert.ok(Math.abs((450 - g.G.panX) / g.G.zoom - 175) < 1e-8);
  assert.ok(Math.abs((300 - g.G.panY) / g.G.zoom - 125) < 1e-8);
});

test('fitting the viewport leaves room for node radii and labels', () => {
  const g = graph();
  g.G.nodes = [{ id: 'a' }, { id: 'b' }];
  g.G.pos.set('a', { x: -300, y: -200 });
  g.G.pos.set('b', { x: 300, y: 200 });
  Object.assign(g.G, { width: 900, height: 600 });
  g.sandbox.fit();
  assert.ok(-300 * g.G.zoom + g.G.panX >= 50);
  assert.ok(-200 * g.G.zoom + g.G.panY >= 50);
});

test('colliding labels do not obscure a selected knowledge node', () => {
  const g = graph();
  g.G.nodes = [{ id: 'a', label: '重要节点', type: 'concept' }, { id: 'b', label: '相邻节点', type: 'concept' }];
  for (const node of g.G.nodes) {
    g.G.pos.set(node.id, { x: 200, y: 200 });
    g.G.adj.set(node.id, Array(9).fill('a'));
  }
  Object.assign(g.G, { loaded: true, alpha: 0, selectId: 'b' });
  g.sandbox.draw();
  assert.deepEqual(g.drawnLabels, ['相邻节点']);
});

test('graph filters keep dimmed nodes from intercepting a click', () => {
  const g = graph();
  g.G.nodes = [{ id: 'a', label: '方法', type: 'method' }, { id: 'b', label: '概念', type: 'concept' }];
  g.G.pos.set('a', { x: 3, y: 0 }); g.G.pos.set('b', { x: 1, y: 0 });
  g.G.typeFilter = 'method';
  assert.equal(g.sandbox.pick(0, 0).id, 'a');
});

test('resizing the viewport preserves the world point at its center', () => {
  const g = graph();
  g.sandbox.resize();
  Object.assign(g.G, { panX: 450, panY: 300 });
  Object.assign(g.$('#graph-wrap'), { clientWidth: 400, clientHeight: 300 });
  g.sandbox.resize();
  assert.equal(g.G.panX, 200);
  assert.equal(g.G.panY, 150);
});

test('refreshing graph data clears a category that no longer exists', async () => {
  const g = graph();
  g.G.typeFilter = 'concept';
  g.sandbox.api = async () => ({ json: async () => ({
    nodes: [{ id: 'a', labels: ['方法'], properties: { entity_id: '方法', entity_type: 'method' } }],
    edges: [], is_truncated: false,
  }) });
  await g.sandbox.load();
  assert.equal(g.G.typeFilter, null);
  assert.equal(g.sandbox.pick(450, 300).id, 'a');
});
