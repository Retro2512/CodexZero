// Switching threads briefly unregisters the old thread's toolbar before the new
// one registers. The app shell turned that gap into a toolbar height change on
// its outer container, which restyled the whole window twice per switch. Hold
// the height for two frames so a gap inside one switch never reaches the page.

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`This Codex version needs an updated thread switch patch: ${before.slice(0, 60)}`);
  return source.replace(before, () => after);
}

export function holdToolbar(React, visible) {
  const last = React.useRef(visible);
  const [, rerender] = React.useState(0);
  const holding = !visible && last.current;
  React.useEffect(() => {
    if (!holding) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { last.current = false; rerender(n => n + 1); });
    });
    return () => cancelAnimationFrame(frame);
  }, [holding]);
  if (visible) last.current = true;
  return visible || last.current;
}

export function patchThreadSwitch(source) {
  const result = replaceOnce(source,
    '"--app-shell-main-toolbar-height":et?`var(--height-toolbar-pane)`:`0px`',
    '"--app-shell-main-toolbar-height":czHoldToolbar($K,et)?`var(--height-toolbar-pane)`:`0px`');
  return `const czHoldToolbar=${holdToolbar.toString()};\n` + result;
}
