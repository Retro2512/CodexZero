// Keep selection overlay repositioning tied to scroll events that can affect
// its transcript. The original handler is otherwise left unchanged.
const containerAnchor = 'S=()=>{let e=s??c?.current??void 0,t=o==null?void 0:e?.querySelector(o)??void 0,r=null';
const originalHandler = 'b=e=>{let n=window.getSelection();if(!(p.current||n==null||n.rangeCount===0||n.isCollapsed)){if(t!=null&&t.contains(n.getRangeAt(0).commonAncestorContainer)){let r=e.target;if(!(r instanceof Node&&t.contains(r))){v();return}if(!n.getRangeAt(0).intersectsNode(r))return}l()}}';
const scopedHandler = 'b=event=>{let scrollTarget=event.target;if(e!=null&&scrollTarget instanceof Node&&!scrollTarget.contains(e)&&!e.contains(scrollTarget))return;let n=window.getSelection();if(!(p.current||n==null||n.rangeCount===0||n.isCollapsed)){if(t!=null&&t.contains(n.getRangeAt(0).commonAncestorContainer)){let r=event.target;if(!(r instanceof Node&&t.contains(r))){v();return}if(!n.getRangeAt(0).intersectsNode(r))return}l()}}';

function assertOnce(source, anchor) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`Unsupported selection overlay bundle anchor: ${anchor.slice(0, 80)}`);
  }
}

export function patchSelectionScroll(source) {
  assertOnce(source, containerAnchor);
  assertOnce(source, originalHandler);
  return source.replace(originalHandler, scopedHandler);
}
