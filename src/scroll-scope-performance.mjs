// Keep selection overlay repositioning tied to scroll events that can affect
// its transcript. The original handler is otherwise left unchanged.
export const SELECTION_SCROLL_TARGET = "\"[data-thread-scroll-footer='true']\"";

const containersAnchor = "let e=null!=j||null==T?[j]:T.map(h).filter(m),t=null;";
const originalHandler = "a=t=>{let a=window.getSelection(),r=O.current?.portalTarget;";
const scopedHandler = "a=t=>{let scrollTarget=t.target;if(scrollTarget instanceof Node){let containers=null!=j||null==T?[j]:T.map(h).filter(m);if(containers.length>0&&containers.every(c=>c instanceof Node&&!scrollTarget.contains(c)&&!c.contains(scrollTarget)))return}let a=window.getSelection(),r=O.current?.portalTarget;";

function assertOnce(source, anchor) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`Unsupported selection overlay bundle anchor: ${anchor.slice(0, 80)}`);
  }
}

export function patchSelectionScroll(source) {
  assertOnce(source, containersAnchor);
  assertOnce(source, originalHandler);
  return source.replace(originalHandler, () => scopedHandler);
}
