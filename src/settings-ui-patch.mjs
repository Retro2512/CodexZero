// CodexZero's Settings sections and the composer cache indicator, for the
// rspack-built desktop. Each patch names the one chunk it applies to.

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`This Codex version needs an updated ${label} patch`);
  return source.replace(before, () => after);
}

// The Configuration page in Settings. CodexZero's sections render above the
// official ones and receive the selected host.
export const SETTINGS_PAGE_TARGET = "ConfigurationPanel:()=>";

export function patchSettingsPage(source) {
  let result = replaceOnce(source, "function eL(e){let t,n,r,o,d,u,p=(0,i.c)(22),{workConfiguration:g}=e,{selectedHostId:f}=(0,e_.D)()",
    "function czSettingsSections(){return czSections??=[czCreateProviderSettings(r,s,em.X),czCreateCacheSettings(r,em.X),czCreateFeatureSettings(r,em.X)]}" +
    "function eL(e){let t,n,r,o,d,u,p=(0,i.c)(22),{workConfiguration:g}=e,{selectedHostId:f}=(0,e_.D)()", "Settings");
  result = replaceOnce(result, "(0,s.jsxs)(ee.P,{title:t,subtitle:n,children:[r,o,d]})",
    "(0,s.jsxs)(ee.P,{title:t,subtitle:n,children:[...czSettingsSections().map((C,k)=>(0,s.jsx)(C,{hostId:f},`cz${k}`)),r,o,d]})", "Settings");
  return 'import{createCacheSettings as czCreateCacheSettings,createFeatureSettings as czCreateFeatureSettings}from"../codexzero-cache-ui.js";' +
    'import{createProviderSettings as czCreateProviderSettings}from"../codexzero-provider-settings.js";let czSections;' + result;
}

// The context usage control in the composer footer becomes the cache
// indicator. It is rebuilt every render so a task switch never reuses the
// previous task's indicator when both have equal context usage.
export const CACHE_INDICATOR_TARGET = 'id:"composer.contextWindowUsageLabel"';

export function patchCacheIndicator(source) {
  let result = replaceOnce(source, "function ru(e){", "function ru(e){return czCacheIndicatorFor(e)}function czOriginalContextUsage(e){", "context indicator");
  result = replaceOnce(result, "function rX(e){",
    'function czCacheIndicatorFor(e){czCacheIndicator??=czCreateCacheIndicator(f);return(0,o.jsx)(czCacheIndicator,{contextUsage:e.contextUsage,threadId:e.czThreadId??null,hostId:"local"})}function rX(e){',
    "context indicator");
  result = replaceOnce(result,
    'v[23]!==U||v[24]!==en?(h=en?(0,o.jsx)("span",{ref:z,className:"text-sm leading-[18px]",children:(0,o.jsx)(ru,{contextUsage:U})}):null,v[23]=U,v[24]=en,v[25]=h):h=v[25]',
    'h=en?(0,o.jsx)("span",{ref:z,className:"text-sm leading-[18px]",children:(0,o.jsx)(ru,{contextUsage:U,czThreadId:L})}):null',
    "context indicator");
  return 'import{createCacheIndicator as czCreateCacheIndicator}from"../codexzero-cache-ui.js";let czCacheIndicator;' + result;
}
