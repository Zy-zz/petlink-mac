const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function pet() {
  const listeners = new Map(), calls = [], classes = new Set();
  const button = { addEventListener: (name, fn) => listeners.set(name, fn), setPointerCapture() {},
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/pet.js'), 'utf8'), {
    document: { getElementById: () => button, querySelector: () => ({ style: {} }) },
    window: { petlink: { onState() {} } },
    call: async (channel) => { calls.push(channel); if (channel === 'get-state') return { unread: 0, status: {} }; },
    showError: (error) => { throw error; }
  });
  const fire = (type, x = 100, y = 100) => listeners.get(type)({ type, button: 0, pointerId: 1,
    screenX: x, screenY: y, preventDefault() {} });
  return { fire, calls, classes };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('whole-pet drag moves and saves without also opening chat', async () => {
  const p = pet();
  p.fire('pointerdown'); p.fire('pointermove', 140, 160);
  assert.equal(p.classes.has('dragging'), true);
  p.fire('pointerup', 140, 160); await settle();
  assert.deepEqual(p.calls, ['get-state', 'drag-start', 'drag-move', 'drag-end']);
  assert.equal(p.classes.has('dragging'), false);
  p.fire('pointermove', 150, 170); await settle();
  assert.equal(p.calls.length, 4);
});

test('click opens chat, while a cancelled gesture only saves the position', async () => {
  const p = pet();
  p.fire('pointerdown'); p.fire('pointermove', 101, 102); p.fire('pointerup'); await settle();
  assert.deepEqual(p.calls, ['get-state', 'drag-start', 'drag-end', 'open']);
  const cancelled = pet();
  cancelled.fire('pointerdown'); cancelled.fire('pointercancel'); await settle();
  assert.deepEqual(cancelled.calls, ['get-state', 'drag-start', 'drag-end']);
});
