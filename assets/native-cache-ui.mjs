const DEFAULT_SETTINGS = Object.freeze({ enabled: false, minutes: 30 });
const WARMTH_STATES = new Set(["warm", "cooling", "cold", "unknown"]);

const INDICATOR_STYLES = `
.czci, .czci * { box-sizing: border-box; }
.czci { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: inherit; font: inherit; -webkit-app-region: no-drag; }
.czci-button { display: grid; place-items: center; width: 28px; height: 28px; margin: 0; border: 0; border-radius: 50%; padding: 2px; color: inherit; background: transparent; cursor: pointer; }
.czci-button:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
.czci-button:focus-visible, .czci-toggle input:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.czci-ring { width: 22px; height: 22px; transform: rotate(-90deg); }
.czci-track, .czci-progress { fill: none; stroke-width: 2.5; }
.czci-track { stroke: currentColor; opacity: .16; }
.czci-progress { stroke: currentColor; stroke-linecap: round; transition: stroke-dasharray 160ms ease, stroke 160ms ease; }
.czci .czci-progress, .czci .czci-track { stroke: var(--czci-cache-color, currentColor); }
.czci[data-warmth="warm"] .czci-track, .czci[data-warmth="cooling"] .czci-track { opacity: .4; }
.czci[data-alert="true"] .czci-track { opacity: .65; }
.czci[data-alert="true"] .czci-ring { animation: czci-cache-pulse 1.6s ease-in-out infinite; }
.czci-time { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--czci-cache-color, inherit); white-space: nowrap; }
@keyframes czci-cache-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
.czci-cost { max-width: 88px; overflow: hidden; color: inherit; font-size: 11px; line-height: 1; opacity: .68; text-overflow: ellipsis; white-space: nowrap; }
.czci-popover { position: fixed; inset: auto; margin: 0; overflow: auto; z-index: 1000; width: max-content; min-width: min(224px, var(--czci-available-width, calc(100vw - 20px))); max-width: min(300px, var(--czci-available-width, calc(100vw - 20px))); max-height: var(--czci-available-height, calc(100vh - 20px)); border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 8px; padding: 11px 12px; color: inherit; font: inherit; background: var(--color-background-primary, Canvas); box-shadow: 0 8px 24px color-mix(in srgb, #000 18%, transparent); -webkit-app-region: no-drag; }
.czci-title { margin: 0 0 3px; font-size: 12px; font-weight: 650; }
.czci-context { margin: 0 0 10px; font-size: 11px; opacity: .66; }
.czci-toggle { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 12px; font-weight: 600; }
.czci-toggle input { width: 16px; height: 16px; margin: 0; appearance: auto; -webkit-appearance: checkbox; accent-color: currentColor; }
.czci-prices { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 16px; margin: 10px 0 0; padding-top: 9px; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); font-size: 11px; }
.czci-prices dt { opacity: .64; }
.czci-prices dd { margin: 0; font-variant-numeric: tabular-nums; }
.czci-error { margin: 8px 0 0; color: var(--color-text-danger, #c43b3b); font-size: 11px; }
@media (max-width: 480px) {
  .czci-cost { max-width: 66px; }
}
@media (prefers-reduced-motion: reduce) {
  .czci-progress { transition: none; }
  .czci[data-alert="true"] .czci-ring { animation: none; }
}
`;

const SETTINGS_STYLES = `
.czcs, .czcs * { box-sizing: border-box; }
.czcs { color: inherit; font: inherit; padding: 2px 0 12px; }
.czcs button, .czcs input { color: inherit; font: inherit; }
.czcs-fields { display: grid; grid-template-columns: minmax(150px, .7fr) minmax(180px, 1fr); gap: 14px 18px; align-items: end; margin: 2px 0 14px; }
.czcs-check { display: flex; align-items: center; gap: 8px; min-height: 34px; font-size: 12px; font-weight: 600; }
.czcs-check input { width: 16px; height: 16px; margin: 0; appearance: auto; -webkit-appearance: checkbox; accent-color: currentColor; }
.czcs-field { display: grid; gap: 6px; min-width: 0; font-size: 12px; font-weight: 600; }
.czcs-input { width: 100%; min-height: 34px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 6px; padding: 6px 8px; background: color-mix(in srgb, currentColor 3%, transparent); }
.czcs-input:invalid:not(:focus) { border-color: var(--color-border-danger, #b94747); }
.czcs-button { min-height: 32px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 6px; padding: 5px 12px; background: transparent; cursor: pointer; font-weight: 600; }
.czcs-button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 6%, transparent); }
.czcs-button:focus-visible, .czcs-input:focus-visible, .czcs-check input:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.czcs-button:disabled, .czcs input:disabled { cursor: default; opacity: .55; }
.czcs-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.czcs-status { min-height: 18px; margin: 0 auto 0 0; font-size: 12px; }
.czcs-status[data-kind="error"] { color: var(--color-text-danger, #c43b3b); }
.czcs-status[data-kind="success"] { color: var(--color-text-success, #27834f); }
@media (max-width: 640px) {
  .czcs-fields { grid-template-columns: 1fr; }
}
`;

function bridge() {
  return globalThis.window && globalThis.window.codexZeroCache;
}

function isLocalHost(hostId) {
  return hostId == null || hostId === "local";
}

function validMoney(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const minutes = Number(source.minutes);
  return {
    enabled: source.enabled === true,
    minutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : DEFAULT_SETTINGS.minutes,
  };
}

function emptySnapshot(error = null) {
  return {
    loading: true,
    settings: { ...DEFAULT_SETTINGS },
    override: null,
    enabled: false,
    warmth: { state: "unknown", remainingMs: null, estimated: true },
    cost: { usd: null, uncachedUsd: null, partial: false, label: "" },
    keepWarmSupported: true,
    error,
  };
}

export function normalizeSnapshot(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid cache result");
  const warmth = value.warmth && typeof value.warmth === "object" ? value.warmth : {};
  const cost = value.cost && typeof value.cost === "object" ? value.cost : {};
  const remaining = Number(warmth.remainingMs);
  return {
    loading: false,
    settings: normalizeSettings(value.settings),
    override: typeof value.override === "boolean" ? value.override : null,
    enabled: value.enabled === true,
    warmth: {
      state: WARMTH_STATES.has(warmth.state) ? warmth.state : "unknown",
      remainingMs: warmth.remainingMs != null && Number.isFinite(remaining) && remaining >= 0 ? remaining : null,
      coolingThresholdMs: Number.isFinite(warmth.coolingThresholdMs) ? Math.max(0, warmth.coolingThresholdMs) : 120000,
      windowMs: Number.isFinite(warmth.windowMs) && warmth.windowMs > 0 ? warmth.windowMs : 1800000,
      estimated: true,
    },
    cost: {
      usd: validMoney(cost.usd),
      uncachedUsd: validMoney(cost.uncachedUsd),
      partial: cost.partial === true,
      label: typeof cost.label === "string" ? cost.label.trim().slice(0, 80) : "",
    },
    keepWarmSupported: value.keepWarmSupported !== false,
    error: typeof value.error === "string" && value.error ? "Cache status unavailable" : null,
  };
}

function normalizeContext(value) {
  const source = value && typeof value === "object" ? value : {};
  const suppliedPercent = Number(source.percent);
  const usedTokens = Number(source.usedTokens);
  const contextWindow = Number(source.contextWindow);
  const inferredPercent = Number.isFinite(usedTokens) && Number.isFinite(contextWindow) && contextWindow > 0
    ? usedTokens / contextWindow * 100
    : 0;
  return {
    percent: Math.min(100, Math.max(0, Number.isFinite(suppliedPercent) ? suppliedPercent : inferredPercent)),
    usedTokens: Number.isFinite(usedTokens) && usedTokens >= 0 ? usedTokens : null,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
  };
}

function compactNumber(value) {
  if (value == null) return null;
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(value).toLocaleString();
}

function money(value) {
  if (value == null) return "API unavailable";
  const digits = value > 0 && value < .01 ? 4 : 2;
  return `~$${value.toFixed(digits)}`;
}

function cacheLabel(snapshot, remainingMs) {
  if (remainingMs != null && snapshot.warmth.state !== "cold") {
    return `Cache · ~${cacheTime(remainingMs)} left`;
  }
  if (snapshot.warmth.state === "warm") return "Cache · Warm";
  if (snapshot.warmth.state === "cooling") return "Cache · Cooling";
  if (snapshot.warmth.state === "cold") return "Cache · 0:00 left";
  return "Cache · Unconfirmed";
}

export function cacheCostLabels(cost) {
  const label = cost.label || "API equivalent";
  const displayed = cost.partial ? `${label} · partial` : label;
  return { displayed, accessible: cost.label ? displayed : label };
}

function cacheTime(remainingMs) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function createCacheIndicator(React) {
  const h = React.createElement;
  const { useEffect, useId, useLayoutEffect, useRef, useState } = React;

  return function CacheIndicator({ threadId, contextUsage, hostId }) {
    const panelId = useId();
    const buttonRef = useRef(null);
    const panelRef = useRef(null);
    const leaveTimer = useRef(null);
    const generationRef = useRef(0);
    const operationRef = useRef(null);
    const mountedRef = useRef(true);
    const [snapshot, setSnapshot] = useState(() => emptySnapshot());
    const [receivedAt, setReceivedAt] = useState(Date.now());
    const [now, setNow] = useState(Date.now());
    const [hovered, setHovered] = useState(false);
    const [focusWithin, setFocusWithin] = useState(false);
    const [pinned, setPinned] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [popoverPosition, setPopoverPosition] = useState(null);
    const local = isLocalHost(hostId);
    const context = normalizeContext(contextUsage);

    useEffect(() => {
      mountedRef.current = true;
      return () => { mountedRef.current = false; clearTimeout(leaveTimer.current); };
    }, []);

    function setResult(result) {
      setSnapshot(normalizeSnapshot(result));
      const time = Date.now();
      setReceivedAt(time);
      setNow(time);
    }

    function queue(task) {
      const previous = operationRef.current;
      const current = (previous ? previous.catch(() => {}) : Promise.resolve())
        .then(task)
        .catch(() => null);
      operationRef.current = current;
      current.finally(() => {
        if (operationRef.current === current) operationRef.current = null;
      });
      return current;
    }

    useEffect(() => {
      const generation = ++generationRef.current;
      let active = true;
      const resetAt = Date.now();
      setSnapshot(emptySnapshot());
      setReceivedAt(resetAt);
      setNow(resetAt);
      setSaving(false);
      setPinned(false);
      setDismissed(false);

      if (!local) {
        setSnapshot({ ...emptySnapshot(), loading: false });
        return () => { active = false; };
      }

      function refresh(queueWhenBusy = false) {
        if (operationRef.current && !queueWhenBusy) return;
        queue(async () => {
          if (!active || generationRef.current !== generation) return;
          let timeout;
          try {
            const api = bridge();
            if (typeof api?.read !== "function") throw new Error("Cache bridge unavailable");
            const result = await Promise.race([
              api.read(threadId == null ? null : threadId),
              new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Cache read timed out")), 10000); }),
            ]);
            if (active && generationRef.current === generation) setResult(result);
          } catch {
            if (active && generationRef.current === generation) {
              setSnapshot((current) => ({ ...current, loading: false, error: "Could not load cache status" }));
            }
          } finally { clearTimeout(timeout); }
        });
      }

      refresh(true);
      const poll = setInterval(refresh, 5000);
      return () => {
        active = false;
        clearInterval(poll);
      };
    }, [threadId, local]);

    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, []);

    useEffect(() => {
      const documentObject = globalThis.document;
      const api = bridge();
      if (!local || threadId == null || !documentObject || typeof documentObject.addEventListener !== "function"
        || !api || typeof api.activity !== "function") return undefined;

      const generation = generationRef.current;
      let active = true;
      let lastActivityAt = 0;
      function handleInput(event) {
        if (!active || generationRef.current !== generation) return;
        if (typeof event.isTrusted === "boolean" && !event.isTrusted) return;
        const target = event.target;
        if (!target || typeof target.closest !== "function"
          || !target.closest('textarea,[contenteditable="true"]')) return;
        const time = Date.now();
        if (time - lastActivityAt < 15000) return;
        lastActivityAt = time;
        queue(async () => {
          if (!active || generationRef.current !== generation) return;
          await api.activity(threadId);
        });
      }

      documentObject.addEventListener("input", handleInput, true);
      return () => {
        active = false;
        documentObject.removeEventListener("input", handleInput, true);
      };
    }, [threadId, local]);

    async function changeEnabled(event) {
      const enabled = event.target.checked;
      const api = bridge();
      const generation = generationRef.current;
      if (!local || threadId == null || !api || typeof api.setEnabled !== "function" || saving) return;
      setSaving(true);
      await queue(async () => {
        if (generationRef.current !== generation) return;
        try {
          const result = await api.setEnabled(threadId, enabled);
          if (mountedRef.current && generationRef.current === generation) setResult(result);
        } catch {
          if (mountedRef.current && generationRef.current === generation) {
            setSnapshot((current) => ({ ...current, error: "Could not change cache setting" }));
          }
        }
      });
      if (mountedRef.current && generationRef.current === generation) setSaving(false);
    }

    function handleBlur(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setFocusWithin(false);
        if (!pinned) setDismissed(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPinned(false);
        setHovered(false);
        if (panelRef.current?.contains(globalThis.document?.activeElement)) buttonRef.current?.focus();
        setDismissed(true);
      }
    }

    const elapsed = Math.max(0, now - receivedAt);
    const remainingMs = snapshot.warmth.remainingMs == null ? null : Math.max(0, snapshot.warmth.remainingMs - elapsed);
    const displayedWarmth = remainingMs === 0 && snapshot.warmth.state !== "unknown"
      ? "cold"
      : remainingMs != null && remainingMs <= snapshot.warmth.coolingThresholdMs && snapshot.warmth.state === "warm"
        ? "cooling" : snapshot.warmth.state;
    const displayedSnapshot = displayedWarmth === snapshot.warmth.state
      ? snapshot
      : { ...snapshot, warmth: { ...snapshot.warmth, state: displayedWarmth } };
    const cacheAlert = !snapshot.loading && displayedWarmth === "cold";
    const remainingRatio = remainingMs == null ? 0 : Math.min(1, remainingMs / snapshot.warmth.windowMs);
    const cacheColor = snapshot.loading || displayedWarmth === "unknown" ? "currentColor" : cacheAlert ? "#ef4444" : `hsl(${Math.round(130 * remainingRatio)} 68% 52%)`;
    const status = cacheLabel(displayedSnapshot, remainingMs);
    const percentText = `${Math.round(context.percent)}%`;
    const used = compactNumber(context.usedTokens);
    const windowSize = compactNumber(context.contextWindow);
    const countText = used != null && windowSize != null ? `${used} / ${windowSize}` : "";
    const open = !dismissed && (hovered || focusWithin || pinned);
    const costText = snapshot.loading ? "…" : money(snapshot.cost.usd);
    const partialTitle = snapshot.cost.partial ? "Partial estimate" : undefined;
    const { displayed: displayedCostLabel, accessible: accessibleCostLabel } = cacheCostLabels(snapshot.cost);
    const accessibleLabel = countText
      ? `Context ${percentText}, ${countText}. ${status}. ${accessibleCostLabel} ${costText}`
      : `Context ${percentText}. ${status}. ${accessibleCostLabel} ${costText}`;

    useLayoutEffect(() => {
      if (!open) return undefined;
      const windowObject = globalThis.window;
      const panel = panelRef.current;
      const button = buttonRef.current;
      if (!windowObject || !panel || !button) return undefined;

      // The composer establishes a clipped containing block. Native popovers
      // render in the top layer, outside its transforms and overflow clipping.
      panel.showPopover?.();

      function positionPopover() {
        const buttonRect = button.getBoundingClientRect();
        const viewportWidth = windowObject.innerWidth || globalThis.document?.documentElement?.clientWidth || 0;
        const viewportHeight = windowObject.innerHeight || globalThis.document?.documentElement?.clientHeight || 0;
        // Desktop's UI scale is CSS zoom on an ancestor. Rectangles already
        // include it, while fixed-position offsets still use unzoomed pixels.
        // Top-layer promotion escapes clipping, but does not remove that zoom.
        let zoom = panel.currentCSSZoom;
        if (!(zoom > 0)) {
          zoom = 1;
          for (let node = panel; node; node = node.parentElement) {
            const value = parseFloat(windowObject.getComputedStyle(node).zoom);
            if (Number.isFinite(value) && value > 0) zoom *= value;
          }
        }
        panel.style.setProperty("--czci-available-width", `${Math.max(0, viewportWidth - 20) / zoom}px`);
        panel.style.setProperty("--czci-available-height", `${Math.max(0, viewportHeight - 20) / zoom}px`);
        const panelRect = panel.getBoundingClientRect();
        if (!viewportWidth || !viewportHeight || !panelRect.width || !panelRect.height) return;
        const maximumLeft = Math.max(10, viewportWidth - panelRect.width - 10);
        const maximumTop = Math.max(10, viewportHeight - panelRect.height - 10);
        const left = Math.min(Math.max(10, buttonRect.left), maximumLeft);
        const above = buttonRect.top - panelRect.height - 6;
        const top = Math.min(Math.max(10, above >= 10 ? above : buttonRect.bottom + 6), maximumTop);
        setPopoverPosition((current) => current && Math.abs(current.left - left / zoom) < .5 && Math.abs(current.top - top / zoom) < .5
          ? current
          : { left: left / zoom, top: top / zoom });
      }

      positionPopover();
      windowObject.addEventListener("resize", positionPopover);
      windowObject.addEventListener("scroll", positionPopover, true);
      const Observer = globalThis.ResizeObserver;
      const observer = typeof Observer === "function" ? new Observer(positionPopover) : null;
      observer?.observe(panel);
      observer?.observe(button);
      const Mutation = globalThis.MutationObserver;
      const scaleObserver = typeof Mutation === "function" ? new Mutation(positionPopover) : null;
      for (let node = panel.parentElement; node; node = node.parentElement) {
        scaleObserver?.observe(node, { attributes: true, attributeFilter: ["style", "class"] });
      }
      return () => {
        windowObject.removeEventListener("resize", positionPopover);
        windowObject.removeEventListener("scroll", positionPopover, true);
        observer?.disconnect();
        scaleObserver?.disconnect();
      };
    }, [open, snapshot.error, snapshot.cost.partial]);

    useEffect(() => {
      if (!open) return;
      const dismiss = (event) => {
        if (buttonRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return;
        setPinned(false); setHovered(false); setFocusWithin(false); setDismissed(true);
      };
      globalThis.document?.addEventListener("pointerdown", dismiss, true);
      globalThis.document?.addEventListener("keydown", handleKeyDown, true);
      return () => {
        globalThis.document?.removeEventListener("pointerdown", dismiss, true);
        globalThis.document?.removeEventListener("keydown", handleKeyDown, true);
      };
    }, [open]);

    function enter() {
      clearTimeout(leaveTimer.current);
      setHovered(true); setDismissed(false);
    }

    function leave() {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = setTimeout(() => setHovered(false), 160);
    }

    return h("div", {
      className: "czci",
      "data-warmth": displayedWarmth,
      "data-alert": String(cacheAlert),
      style: { "--czci-cache-color": cacheColor },
      onMouseEnter: enter,
      onMouseLeave: leave,
      onFocus: () => { setFocusWithin(true); setDismissed(false); },
      onBlur: handleBlur,
      onKeyDown: handleKeyDown,
    },
      h("style", null, INDICATOR_STYLES),
      h("button", {
        className: "czci-button",
        ref: buttonRef,
        type: "button",
        "aria-label": accessibleLabel,
        "aria-expanded": open,
        "aria-controls": panelId,
        "aria-haspopup": "dialog",
        onClick: () => {
          if (pinned) {
            setPinned(false);
            setDismissed(true);
          } else {
            setPinned(true);
            setDismissed(false);
          }
        },
      },
        h("svg", { className: "czci-ring", viewBox: "0 0 24 24", "aria-hidden": "true" },
          h("circle", { className: "czci-track", cx: 12, cy: 12, r: 9 }),
          h("circle", {
            className: "czci-progress", cx: 12, cy: 12, r: 9, pathLength: 100,
            strokeDasharray: `${context.percent} ${100 - context.percent}`,
          }),
        ),
      ),
      remainingMs != null ? h("span", { className: "czci-time", title: "Estimated cache time remaining" }, `~${cacheTime(remainingMs)}`) : null,
      h("span", { className: "czci-cost", title: partialTitle }, costText),
      open ? h("div", {
        className: "czci-popover", id: panelId, ref: panelRef, role: "dialog", "aria-label": "Context cache",
        popover: "manual", onMouseEnter: enter, onMouseLeave: leave,
        style: popoverPosition
          ? { left: `${popoverPosition.left}px`, top: `${popoverPosition.top}px` }
          : { left: "10px", top: "10px", visibility: "hidden" },
      },
        h("p", { className: "czci-title" }, status),
        h("p", { className: "czci-context" }, `${percentText} used · ${100 - Math.round(context.percent)}% left`, countText ? h("br") : null, countText),
        snapshot.keepWarmSupported ? h("label", { className: "czci-toggle" },
          h("input", {
            type: "checkbox",
            checked: snapshot.enabled,
            disabled: !local || threadId == null || saving,
            onChange: changeEnabled,
          }),
          h("span", null, "Keep warm"),
        ) : null,
        h("dl", { className: "czci-prices", title: partialTitle },
          h("dt", null, displayedCostLabel),
          h("dd", null, costText),
          h("dt", null, "Without cache"),
          h("dd", null, money(snapshot.cost.uncachedUsd)),
        ),
        snapshot.error ? h("p", { className: "czci-error", role: "status" }, snapshot.error) : null,
      ) : null,
    );
  };
}

export function createCacheSettings(React, Section) {
  const h = React.createElement;
  const { useEffect, useId, useRef, useState } = React;

  function LocalCacheSettings() {
    const minutesId = useId();
    const operationRef = useRef(null);
    const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS }));
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ text: "", kind: "" });

    useEffect(() => {
      let active = true;
      const api = bridge();
      if (!api || typeof api.read !== "function") {
        setLoading(false);
        setMessage({ text: "Could not load context cache", kind: "error" });
        return () => { active = false; };
      }

      const request = Promise.resolve()
        .then(() => api.read(null))
        .then((result) => {
          if (!active) return;
          setSettings(normalizeSnapshot(result).settings);
          setLoading(false);
        })
        .catch(() => {
          if (!active) return;
          setLoading(false);
          setMessage({ text: "Could not load context cache", kind: "error" });
        });
      operationRef.current = request;
      request.finally(() => {
        if (operationRef.current === request) operationRef.current = null;
      });
      return () => { active = false; };
    }, []);

    async function save(event) {
      event.preventDefault();
      if (loading || saving || operationRef.current) return;
      const minutes = Number(settings.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        setMessage({ text: "Enter a whole number from 1 to 1440", kind: "error" });
        return;
      }
      const api = bridge();
      if (!api || typeof api.saveSettings !== "function") {
        setMessage({ text: "Could not save changes", kind: "error" });
        return;
      }

      setSaving(true);
      try {
        const request = Promise.resolve().then(() => api.saveSettings({ enabled: settings.enabled, minutes }));
        operationRef.current = request;
        const result = await request;
        setSettings(normalizeSettings(result));
        setMessage({ text: "Saved", kind: "success" });
      } catch {
        setMessage({ text: "Could not save changes", kind: "error" });
      } finally {
        operationRef.current = null;
        setSaving(false);
      }
    }

    const disabled = loading || saving;
    return h(Section, {},
      h(Section.Header, { title: "Context cache" }),
      h(Section.Content, {},
        h("style", null, SETTINGS_STYLES),
        h("form", { className: "czcs", onSubmit: save, "aria-busy": disabled },
          h("div", { className: "czcs-fields" },
            h("label", { className: "czcs-check" },
              h("input", {
                type: "checkbox", checked: settings.enabled, disabled,
                onChange: (event) => setSettings((current) => ({ ...current, enabled: event.target.checked })),
              }),
              h("span", null, "Keep warm"),
            ),
            h("label", { className: "czcs-field", htmlFor: minutesId },
              h("span", null, "Minutes after activity"),
              h("input", {
                className: "czcs-input", id: minutesId, type: "number", required: true,
                min: 1, max: 1440, step: 1, value: settings.minutes, disabled,
                onChange: (event) => setSettings((current) => ({ ...current, minutes: event.target.value })),
              }),
            ),
          ),
          h("div", { className: "czcs-actions" },
            h("p", {
              className: "czcs-status", "data-kind": message.kind,
              role: message.kind === "error" ? "alert" : "status", "aria-live": "polite",
            }, loading ? "Loading" : message.text),
            h("button", { className: "czcs-button", type: "submit", disabled }, saving ? "Saving" : "Save"),
          ),
        ),
      ),
    );
  }

  return function CacheSettings({ hostId }) {
    return isLocalHost(hostId) ? h(LocalCacheSettings) : null;
  };
}
