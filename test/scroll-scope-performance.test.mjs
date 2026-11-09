import assert from 'node:assert/strict';
import test from 'node:test';
import { patchSelectionScroll } from '../src/scroll-scope-performance.mjs';

// The containers lookup and the scroll handler are the exact minified bundle shape.
const source = 'n=()=>{t();E.current=window.requestAnimationFrame(()=>{E.current=null;let e=null!=j||null==T?[j]:T.map(h).filter(m),t=null;})},o=()=>{},' +
  'a=t=>{let a=window.getSelection(),r=O.current?.portalTarget;if(!L.current&&null!=a&&0!==a.rangeCount&&!a.isCollapsed){if(null!=r&&r.contains(a.getRangeAt(0).commonAncestorContainer)){let n=t.target;if(!(n instanceof Node&&r.contains(n)))return void(null!=e&&window.clearTimeout(e),e=window.setTimeout(()=>{e=null,o()},100));if(!a.getRangeAt(0).intersectsNode(n))return}n()}},r=e=>{}';

class FixtureNode {
  constructor(parent = null) { this.parent = parent; }
  contains(other) {
    for (let current = other; current != null; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
}

function listener(sourceText, { container, containerRefs = null, portalTarget = null, selectionNode = null }) {
  const start = sourceText.indexOf('a=t=>');
  const end = sourceText.indexOf(',r=e=>', start);
  assert.ok(start >= 0 && end > start, 'Selection listener must be extractable');
  const expression = sourceText.slice(start + 2, end);
  const calls = { selectionReads: 0, updates: 0, delayed: 0 };
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => ({
      commonAncestorContainer: selectionNode,
      intersectsNode: node => node?.contains(selectionNode) ?? false,
    }),
  };
  const window = {
    getSelection() { calls.selectionReads++; return selection; },
    setTimeout(callback) { calls.delayed++; return 1; },
    clearTimeout() {},
  };
  const callback = Function('j', 'T', 'h', 'm', 'O', 'L', 'e', 'o', 'n', 'window', 'Node', `return (${expression});`)(
    container, containerRefs, ref => ref.current, value => value != null, { current: portalTarget == null ? null : { portalTarget } },
    { current: false }, null, () => {}, () => calls.updates++, window, FixtureNode,
  );
  return { callback, calls };
}

test('selection patch rejects missing, ambiguous, and previously patched anchors', () => {
  const patched = patchSelectionScroll(source);
  assert.match(patched, /scrollTarget instanceof Node/);
  assert.throws(() => patchSelectionScroll('different bundle'), /Unsupported selection overlay bundle anchor/);
  assert.throws(() => patchSelectionScroll(source + source), /Unsupported selection overlay bundle anchor/);
  assert.throws(() => patchSelectionScroll(patched), /Unsupported selection overlay bundle anchor/);
});

test('sidebar sibling scroll avoids even reading selection, but ancestor and transcript scrolls are handled', () => {
  const document = new FixtureNode();
  const transcript = new FixtureNode(document);
  const selectedText = new FixtureNode(transcript);
  const internalScroller = new FixtureNode(transcript);
  const sidebar = new FixtureNode(document);
  const nestedSidebarScroller = new FixtureNode(sidebar);
  const { callback, calls } = listener(patchSelectionScroll(source), { container: transcript, selectionNode: selectedText });

  callback({ target: sidebar });
  callback({ target: nestedSidebarScroller });
  assert.deepEqual(calls, { selectionReads: 0, updates: 0, delayed: 0 });

  callback({ target: document });
  callback({ target: internalScroller });
  callback({ target: transcript });
  callback({ target: { kind: 'window' } });
  assert.deepEqual(calls, { selectionReads: 4, updates: 4, delayed: 0 });
});

test('thread panes passed as refs are each treated as the transcript', () => {
  const document = new FixtureNode();
  const left = new FixtureNode(document);
  const right = new FixtureNode(document);
  const sidebar = new FixtureNode(document);
  const selectedText = new FixtureNode(right);
  const refs = [{ current: left }, { current: null }, { current: right }];
  const { callback, calls } = listener(patchSelectionScroll(source), { containerRefs: refs, selectionNode: selectedText });
  callback({ target: sidebar });
  assert.deepEqual(calls, { selectionReads: 0, updates: 0, delayed: 0 });
  callback({ target: new FixtureNode(right) });
  callback({ target: new FixtureNode(left) });
  assert.deepEqual(calls, { selectionReads: 2, updates: 2, delayed: 0 });
});

test('relevant portal selection behavior remains identical to the original listener', () => {
  const document = new FixtureNode();
  const transcript = new FixtureNode(document);
  const portal = new FixtureNode(transcript);
  const selectedScroller = new FixtureNode(portal);
  const selectedText = new FixtureNode(selectedScroller);
  const options = { container: transcript, portalTarget: portal, selectionNode: selectedText };
  const oldListener = listener(source, options);
  const newListener = listener(patchSelectionScroll(source), options);
  for (const target of [selectedScroller, portal, transcript, document, { kind: 'window' }]) {
    oldListener.callback({ target });
    newListener.callback({ target });
  }
  assert.deepEqual(newListener.calls, oldListener.calls);
  assert.deepEqual(newListener.calls, { selectionReads: 5, updates: 2, delayed: 3 });
});

test('unknown containers keep original behavior and independent overlays keep independent scopes', () => {
  const document = new FixtureNode();
  const transcript = new FixtureNode(document);
  const sidebar = new FixtureNode(document);
  const selectedText = new FixtureNode(transcript);
  for (const options of [{ container: undefined }, { containerRefs: [{ current: null }] }]) {
    const unknown = listener(patchSelectionScroll(source), { ...options, selectionNode: selectedText });
    unknown.callback({ target: sidebar });
    assert.deepEqual(unknown.calls, { selectionReads: 1, updates: 1, delayed: 0 });
  }

  const transcriptOverlay = listener(patchSelectionScroll(source), { container: transcript, selectionNode: selectedText });
  const sidebarOverlay = listener(patchSelectionScroll(source), { container: sidebar, selectionNode: selectedText });
  transcriptOverlay.callback({ target: sidebar });
  sidebarOverlay.callback({ target: sidebar });
  assert.deepEqual(transcriptOverlay.calls, { selectionReads: 0, updates: 0, delayed: 0 });
  assert.deepEqual(sidebarOverlay.calls, { selectionReads: 1, updates: 1, delayed: 0 });
});
