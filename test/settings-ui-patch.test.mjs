import assert from "node:assert/strict";
import test from "node:test";
import { CACHE_INDICATOR_TARGET, SETTINGS_PAGE_TARGET, patchCacheIndicator, patchSettingsPage } from "../src/settings-ui-patch.mjs";

const settingsFixture = "PimJ(e,t,n){n.d(t,{ConfigurationPanel:()=>eH});" +
  "function eL(e){let t,n,r,o,d,u,p=(0,i.c)(22),{workConfiguration:g}=e,{selectedHostId:f}=(0,e_.D)();" +
  "return(0,s.jsxs)(ee.P,{title:t,subtitle:n,children:[r,o,d]})}";

test("Settings sections render first on the Configuration page with the selected host", () => {
  assert.ok(settingsFixture.includes(SETTINGS_PAGE_TARGET));
  const patched = patchSettingsPage(settingsFixture);
  assert.ok(patched.startsWith('import{createCacheSettings as czCreateCacheSettings,createFeatureSettings as czCreateFeatureSettings}from"../codexzero-cache-ui.js";'));
  assert.ok(patched.includes('from"../codexzero-provider-settings.js";let czSections;'));
  assert.ok(patched.includes("czCreateProviderSettings(r,s,em.X),czCreateCacheSettings(r,em.X),czCreateFeatureSettings(r,em.X)"));
  assert.ok(patched.includes("children:[...czSettingsSections().map((C,k)=>(0,s.jsx)(C,{hostId:f},`cz${k}`)),r,o,d]"));
  assert.throws(() => patchSettingsPage("nothing here"), /updated Settings patch/);
});

const footerFixture = 'Ceox(e,t,n){var o=n("ABep"),f=n("zd8w");' +
  "function ru(e){let t;return null}" +
  "function rX(e){let L=x;" +
  'v[23]!==U||v[24]!==en?(h=en?(0,o.jsx)("span",{ref:z,className:"text-sm leading-[18px]",children:(0,o.jsx)(ru,{contextUsage:U})}):null,v[23]=U,v[24]=en,v[25]=h):h=v[25]}' +
  'id:"composer.contextWindowUsageLabel"';

test("the composer context control becomes the per-task cache indicator", () => {
  assert.ok(footerFixture.includes(CACHE_INDICATOR_TARGET));
  const patched = patchCacheIndicator(footerFixture);
  assert.ok(patched.startsWith('import{createCacheIndicator as czCreateCacheIndicator}from"../codexzero-cache-ui.js";let czCacheIndicator;'));
  assert.ok(patched.includes("function ru(e){return czCacheIndicatorFor(e)}function czOriginalContextUsage(e){"));
  assert.ok(patched.includes('czCacheIndicator??=czCreateCacheIndicator(f);return(0,o.jsx)(czCacheIndicator,{contextUsage:e.contextUsage,threadId:e.czThreadId??null,hostId:"local"})'));
  assert.ok(patched.includes("(0,o.jsx)(ru,{contextUsage:U,czThreadId:L})"));
  assert.ok(!patched.includes("v[23]!==U"), "never reuses a memoized indicator across tasks");
  assert.throws(() => patchCacheIndicator("function ru(e){"), /updated context indicator patch/);
});
