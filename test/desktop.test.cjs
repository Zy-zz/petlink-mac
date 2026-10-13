const test = require('node:test');
const assert = require('node:assert/strict');
const { clampBounds, placedBounds } = require('../src/desktop.cjs');
const { validatePlacement, validateMessage } = require('../src/peer.cjs');
const displays = [{ workArea: { x: 0, y: 30, width: 1440, height: 850 } },
  { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }];

test('desktop positions map relative coordinates across different screens and keep edges visible', () => {
  assert.deepEqual(placedBounds({ display: 1, x: .25, y: .5 }, displays, { width: 300, height: 200 }),
    { x: 210, y: 355, width: 300, height: 200 });
  assert.deepEqual(placedBounds({ display: 2, x: .5, y: .5 }, displays, { width: 300, height: 200 }),
    { x: -1110, y: 440, width: 300, height: 200 });
  assert.deepEqual(placedBounds({ display: 16, x: 1, y: 0 }, displays, { width: 300, height: 200 }),
    { x: 1140, y: 30, width: 300, height: 200 });
  assert.deepEqual(clampBounds({ x: -3000, y: 2000, width: 160, height: 170 }, displays[1].workArea),
    { x: -1920, y: 910, width: 160, height: 170 });
});
test('untrusted placements and confirmations reject malformed coordinates and incompatible content', () => {
  for (const value of [null, {}, { display: 0, x: .5, y: .5 }, { display: 1, x: NaN, y: .5 },
    { display: 1, x: Infinity, y: 0 }, { display: 1, x: '0.5', y: .5 }, { display: 1, x: .5, y: 1.01 }])
    assert.throws(() => validatePlacement(value));
  const placement = { display: 1, x: .2, y: .7 };
  assert.deepEqual(validateMessage({ text: '甩一张纸条', placement }), { text: '甩一张纸条', placement });
  assert.throws(() => validateMessage({ text: 'bad', placement, attachment: { name: 'bad.svg', mime: 'image/svg+xml', data: 'PHN2Zy8+' } }));
  assert.throws(() => validateMessage({ text: 'bad', throwDecision: { requestId: '../bad', accepted: true } }));
  assert.throws(() => validateMessage({ text: 'bad', placement, throwDecision: { requestId: '11111111-1111-1111-1111-111111111111', accepted: true } }));
});
