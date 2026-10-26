const test = require('node:test');
const assert = require('node:assert');
const { layout } = require('../src/renderer/graph.js');

const c = (hash, ...parents) => ({ hash, parents });

test('linear history stays in column 0', () => {
  const rows = layout([c('c', 'b'), c('b', 'a'), c('a')]);
  assert.deepStrictEqual(rows.map((r) => r.col), [0, 0, 0]);
  assert.strictEqual(Math.max(...rows.map((r) => r.width)), 1);
});

test('branch and merge uses a second lane then converges', () => {
  // m merges f (feature) into main; both descend from base
  const rows = layout([c('m', 'x', 'f'), c('f', 'base'), c('x', 'base'), c('base')]);
  assert.strictEqual(rows[0].col, 0);
  assert.strictEqual(rows[1].col, 1); // feature commit sits in lane 1
  assert.strictEqual(rows[2].col, 0);
  // lane 0 (x) hands over to lane 1, where base was already claimed by f
  assert.ok(rows[2].segments.some((s) => s.half === 'bottom' && s.from === 0 && s.to === 1));
  assert.strictEqual(rows[3].col, 1);
  assert.strictEqual(rows[3].width, 2);
});

test('lane is reused after a branch ends', () => {
  const rows = layout([c('a', 'p'), c('b', 'p'), c('p')]);
  assert.deepStrictEqual(rows.map((r) => r.col), [0, 1, 0]);
});

test('octopus merge fans out to every parent', () => {
  const rows = layout([c('m', 'a', 'b', 'c'), c('a'), c('b'), c('c')]);
  const bottoms = rows[0].segments.filter((s) => s.half === 'bottom');
  assert.deepStrictEqual(bottoms.map((s) => s.to).sort(), [0, 1, 2]);
});

test('parent already tracked in another lane is not duplicated', () => {
  const rows = layout([c('a', 'p'), c('b', 'p'), c('p')]);
  const lanesAfterB = rows[1].segments.filter((s) => s.half === 'bottom');
  assert.ok(lanesAfterB.some((s) => s.from === 1 && s.to === 0));
});
