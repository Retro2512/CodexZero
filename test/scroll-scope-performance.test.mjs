import assert from 'node:assert/strict';
import test from 'node:test';
import { patchSelectionScroll } from '../src/scroll-scope-performance.mjs';

// The handler and its captured container are the exact minified bundle shape.
const source = 'S=()=>{let e=s??c?.current??void 0,t=o==null?void 0:e?.querySelector(o)??void 0,r=null,' +
  'b=e=>{let n=window.getSelection();if(!(p.current||n==null||n.rangeCount===0||n.isCollapsed)){if(t!=null&&t.contains(n.getRangeAt(0).commonAncestorContainer)){let r=e.target;if(!(r instanceof Node&&t.contains(r))){v();return}if(!n.getRangeAt(0).intersectsNode(r))return}l()}},x=e=>{}';

class FixtureNode {
  constructor(parent = null) { this.parent = parent; }
  contains(other) {
    for (let current = other; current != null; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
}

function listener(sourceText, container, portalTarget = null, selectionNode = null) {
  const start = sourceText.indexOf('b=');
  const end = sourceText.indexOf(',x=e=>', start);
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
  const window = { getSelection() { calls.selectionReads++; return selection; } };
  const callback = Function('e', 't', 'p', 'v', 'l', 'window', 'Node', `return (${expression});`)(
    container, portalTarget, { current: false }, () => calls.delayed++, () => calls.updates++, window, FixtureNode,
  );
  return { callback, calls };
}

test('selection patch rejects missing, ambiguous, and previously patched anchors', () => {
  const patched = patchSelectionScroll(source);
  assert.match(patched, /scrollTarget instanceof Node&&!scrollTarget\.contains\(e\)&&!e\.contains\(scrollTarget\)/);
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
  const { callback, calls } = listener(patchSelectionScroll(source), transcript, null, selectedText);

  callback({ target: sidebar });
  callback({ target: nestedSidebarScroller });
  assert.deepEqual(calls, { selectionReads: 0, updates: 0, delayed: 0 });

  callback({ target: document });
  callback({ target: internalScroller });
  callback({ target: transcript });
  callback({ target: { kind: 'window' } });
  assert.deepEqual(calls, { selectionReads: 4, updates: 4, delayed: 0 });
});

test('relevant portal selection behavior remains identical to the original listener', () => {
  const document = new FixtureNode();
  const transcript = new FixtureNode(document);
  const portal = new FixtureNode(transcript);
  const selectedText = new FixtureNode(portal);
  const selectedScroller = new FixtureNode(portal);
  selectedText.parent = selectedScroller;
  const oldListener = listener(source, transcript, portal, selectedText);
  const newListener = listener(patchSelectionScroll(source), transcript, portal, selectedText);
  for (const target of [selectedScroller, portal, transcript, document, { kind: 'window' }]) {
    oldListener.callback({ target });
    newListener.callback({ target });
  }
  assert.deepEqual(newListener.calls, oldListener.calls);
  assert.deepEqual(newListener.calls, { selectionReads: 5, updates: 2, delayed: 3 });
});

test('unknown container keeps original behavior and independent overlays keep independent scopes', () => {
  const document = new FixtureNode();
  const transcript = new FixtureNode(document);
  const sidebar = new FixtureNode(document);
  const selectedText = new FixtureNode(transcript);
  const unknown = listener(patchSelectionScroll(source), undefined, null, selectedText);
  unknown.callback({ target: sidebar });
  assert.deepEqual(unknown.calls, { selectionReads: 1, updates: 1, delayed: 0 });

  const transcriptOverlay = listener(patchSelectionScroll(source), transcript, null, selectedText);
  const sidebarOverlay = listener(patchSelectionScroll(source), sidebar, null, selectedText);
  transcriptOverlay.callback({ target: sidebar });
  sidebarOverlay.callback({ target: sidebar });
  assert.deepEqual(transcriptOverlay.calls, { selectionReads: 0, updates: 0, delayed: 0 });
  assert.deepEqual(sidebarOverlay.calls, { selectionReads: 1, updates: 1, delayed: 0 });
});
