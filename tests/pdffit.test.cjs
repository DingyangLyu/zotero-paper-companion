const {test} = require('node:test');
const assert = require('node:assert/strict');
global.Zotero = {Notifier: {registerObserver: () => 'id', unregisterObserver() {}}};
const {nextScale} = require('../plugin/content/pdffit.js');

test('a page that filled the width is rescaled to fill the narrower column when the pane opens', () => {
  // 210%: page 1713px in a 1740px view; the pane leaves 1243px.
  const s = nextScale({scale: 2.1, page: 1713, prevView: 1740, view: 1243});
  assert.ok(s < 2.1);
  assert.ok(Math.abs(1713 * s / 2.1 - 1713 / 1740 * 1243) < 2, 'same fill ratio');
});

test('closing the pane scales the page back up', () => {
  const s = nextScale({scale: 1.5, page: 1224, prevView: 1243, view: 1740});
  assert.ok(Math.abs(s - 2.1) < 0.02);
});

test('a page wider than its old view is brought back inside the new one', () => {
  const s = nextScale({scale: 2.2, page: 1890, prevView: 1740, view: 1438});
  assert.ok(1890 * s / 2.2 <= 1438);
});

test('deliberate zoom-in, narrow pages and tiny changes are left alone', () => {
  assert.equal(nextScale({scale: 4, page: 3200, prevView: 1740, view: 1243}), null);
  assert.equal(nextScale({scale: 1, page: 800, prevView: 1740, view: 1243}), null);
  assert.equal(nextScale({scale: 2.1, page: 1713, prevView: 1740, view: 1730}), null);
  assert.equal(nextScale({scale: 2.1, page: 0, prevView: 1740, view: 1243}), null);
});

test('opening and closing the pane repeatedly returns to the original zoom', () => {
  let scale = 2.1, page = 1714;
  for (const [prevView, view] of [[1725, 1243], [1243, 1725], [1725, 1243], [1243, 1725]]) {
    const s = nextScale({scale, page, prevView, view});
    page = page * s / scale;
    scale = s;
  }
  assert.ok(Math.abs(scale - 2.1) < 0.005);
});
