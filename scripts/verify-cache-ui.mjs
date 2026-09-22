// Browser regression test using the React runtime bundled with the desktop app.
// Usage: node scripts/verify-cache-ui.mjs <app.asar> <playwright module path>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { openAsar } from '../src/asar-patch.mjs';
import { ConversationAccounting, warmth } from '../src/cache-accounting.mjs';

const [archivePath, playwrightPath] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const archive = await openAsar(archivePath);
const shared = Object.keys(archive.header.files.webview.files.assets.files).find(n => /^app-shared-.*\.js$/.test(n));
const styles = Object.keys(archive.header.files.webview.files.assets.files).filter(n => /^app-(shared|initial|primary)-.*\.css$/.test(n));
const zoom = Number(process.env.CACHE_UI_ZOOM) || 1;
const html = `<!doctype html><html data-theme="dark" style="color-scheme:dark;--color-background-primary:#181818"><head>${styles.map(n=>`<link rel="stylesheet" href="/assets/${n}">`).join('')}</head><body style="margin:0;background:#181818;color:#eee;font:14px system-ui">
<div class="zoom-adjusted-viewport" style="--codex-window-zoom:${zoom}">
<div id="composer" style="position:fixed;bottom:20px;right:20px;width:500px;height:80px;overflow:hidden;transform:translateZ(0);contain:paint;border:1px solid #888"><div id="root" style="display:flex;justify-content:flex-end"></div></div>
<button id="outside" style="position:fixed;top:5px;right:5px">Outside</button>
</div>
<script type="module">
const shared = await import('/assets/${shared}');
const React = shared.qB(), DOM = shared.AB();
const {createCacheIndicator} = await import('/cache-ui.mjs');
window.reads = []; window.fail = false; window.saved = [];
window.remaining = 1800000;
window.codexZeroCache = {
 read: async id => { window.reads.push(id); if(window.fail) throw Error('Transient'); return {
 settings:{enabled:false,minutes:30},enabled:window.enabled||false,
 warmth:{state:window.warmthState||'warm',remainingMs:window.warmthState==='unknown'?null:window.remaining,windowMs:1800000},cost:{usd:1.25,uncachedUsd:2.5}
 }; },
 setEnabled: async (id,enabled) => { window.saved.push({id,enabled}); window.enabled=enabled; return window.codexZeroCache.read(id); },
 activity: async () => {}
};
const Indicator = createCacheIndicator(React);
const root = DOM.createRoot(document.getElementById('root'));
window.render = (id='fixture') => root.render(React.createElement(Indicator,{threadId:id,hostId:'local',contextUsage:{percent:38,usedTokens:98300,contextWindow:258400}}));
window.render();
</script></body></html>`;
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    let bytes;
    if(url.pathname === '/') { res.setHeader('Content-Type','text/html'); bytes=html; }
    else {
      res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'text/javascript');
      bytes=url.pathname === '/cache-ui.mjs'
        ? await fs.readFile(process.env.CACHE_UI_SOURCE || new URL('../assets/native-cache-ui.mjs',import.meta.url))
        : await archive.read(`webview${url.pathname}`);
    }
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
  browser = await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:800,height:600}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const button=page.locator('.czci-button'), panel=page.locator('.czci-popover');
  await button.waitFor();
  await page.waitForFunction(()=>document.querySelector('.czci-cost')?.textContent==='~$1.25');
  assert.match(await page.locator('.czci-time').textContent(), /^~(30:00|29:59)$/);
  assert.ok(await page.locator('.czci-track').evaluate(el=>{
    const [r,g,b]=getComputedStyle(el).stroke.match(/[\d.]+/g).map(Number);return g>r&&g>b;
  }), 'Warm ring uses the native success color');
  await button.hover();
  await panel.waitFor({state:'visible'});
  const visible=await panel.evaluate(el=>{
    const r=el.getBoundingClientRect();
    return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,hit:el.contains(document.elementFromPoint(r.x+20,r.y+20)),topLayer:el.matches(':popover-open')};
  });
  assert.ok(visible.hit,'Popover must escape transformed overflow clipping and receive pointer input');
  assert.ok(visible.top>=0 && visible.bottom<=600);
  assert.ok(visible.left>=0 && visible.right<=800);
  assert.ok(visible.topLayer);
  assert.ok((await panel.textContent()).includes('38% used · 62% left'));
  if (process.env.CACHE_UI_SCREENSHOT) await page.screenshot({path:process.env.CACHE_UI_SCREENSHOT});
  await page.evaluate(()=>document.querySelector('.zoom-adjusted-viewport').style.setProperty('--codex-window-zoom','1.75'));
  await page.waitForFunction(()=>{
    const p=document.querySelector('.czci-popover').getBoundingClientRect(),b=document.querySelector('.czci-button').getBoundingClientRect();
    return p.x>=0 && p.right<=innerWidth && p.top>=0 && p.bottom<=innerHeight && Math.abs(p.bottom-(b.top-6))<2;
  });
  await page.getByLabel('Keep warm',{exact:true}).check();
  assert.deepEqual(await page.evaluate(()=>window.saved),[{id:'fixture',enabled:true}]);
  await page.keyboard.press('Escape');
  await panel.waitFor({state:'detached'});
  await button.click();
  await panel.waitFor({state:'visible'});
  await page.locator('#outside').click();
  await panel.waitFor({state:'detached'});
  await page.evaluate(()=>{window.remaining=60000;window.render('second');});
  await page.waitForFunction(()=>document.querySelector('.czci')?.dataset.warmth==='cooling');
  assert.ok((await page.evaluate(()=>window.reads)).includes('second'));
  await page.evaluate(()=>window.fail=true);
  await page.waitForTimeout(5500);
  assert.equal(await page.locator('.czci-cost').textContent(),'~$1.25','Transient read failure preserves cost');
  await button.hover();
  assert.ok((await panel.textContent()).includes('Could not load cache status'));
  await page.evaluate(()=>window.fail=false);
  await page.waitForTimeout(5500);
  assert.ok(!(await panel.textContent()).includes('Could not load cache status'));
  await page.setViewportSize({width:320,height:500});
  const r=await panel.boundingBox();
  assert.ok(r.x>=0 && r.x+r.width<=320 && r.y>=0 && r.y+r.height<=500,'Narrow viewport fit');
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>{window.remaining=1;window.render('expired');});
  await page.waitForFunction(()=>document.querySelector('.czci')?.dataset.warmth==='cold');
  assert.equal(await page.locator('.czci-time').textContent(),'~0:00');
  assert.equal(await page.locator('.czci-ring').evaluate(el=>getComputedStyle(el).animationName),'czci-cache-pulse');
  assert.equal(await page.locator('.czci-track').evaluate(el=>getComputedStyle(el).stroke),'rgb(239, 68, 68)');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.czci-ring').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  // A preload bridge that arrives late must recover without remounting.
  await page.evaluate(()=>{window.savedApi=window.codexZeroCache;delete window.codexZeroCache;window.render('late-bridge');});
  await page.waitForFunction(()=>document.querySelector('.czci-cost')?.textContent==='API unavailable');
  await page.evaluate(()=>{window.codexZeroCache=window.savedApi;window.remaining=1800000;});
  await page.waitForFunction(()=>document.querySelector('.czci')?.dataset.warmth==='warm');
  assert.equal(await page.locator('.czci-cost').textContent(),'~$1.25');
  await page.evaluate(()=>{window.savedRead=window.codexZeroCache.read;window.codexZeroCache.read=()=>new Promise(()=>{});window.render('timeout');});
  await page.waitForFunction(()=>document.querySelector('.czci-cost')?.textContent==='API unavailable');
  await page.evaluate(()=>{window.codexZeroCache.read=window.savedRead;});
  await page.waitForFunction(()=>document.querySelector('.czci-cost')?.textContent==='~$1.25');
  await page.evaluate(()=>{window.warmthState='unknown';window.render('unconfirmed');});
  await page.waitForFunction(()=>document.querySelector('.czci')?.dataset.warmth==='unknown');
  assert.equal(await page.locator('.czci-time').count(),0,'Unknown expiry must not invent a countdown');
  assert.equal(await page.locator('.czci').getAttribute('data-alert'),'false');
  assert.equal(await page.locator('.czci-ring').evaluate(el=>getComputedStyle(el).animationName),'none');
  await button.hover();
  assert.ok((await panel.textContent()).includes('Cache · Unconfirmed'));
  const fresh = new ConversationAccounting('fresh-first-request');
  const timestamp = new Date().toISOString();
  fresh.accept({timestamp,type:'turn_context',payload:{model:'gpt-5.6-sol'}});
  const usage = {input_tokens:23500,cached_input_tokens:0,output_tokens:20};
  fresh.accept({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:usage,last_token_usage:usage}}});
  await page.evaluate(heat=>{
    window.warmthState=heat.state;window.remaining=heat.remainingMs;window.render('fresh-first-request');
  },warmth(fresh.snapshot));
  await page.waitForFunction(()=>document.querySelector('.czci')?.dataset.warmth==='warm');
  assert.match(await page.locator('.czci-time').textContent(),/~(30:00|29:59)/);
  assert.equal(await page.locator('.czci').getAttribute('data-alert'),'false');
  assert.equal(await page.locator('.czci-ring').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.deepEqual(errors,[]);
  console.log('PASS: clipped composer hover, top layer hit testing, toggle, Escape, click, outside dismissal, task switch, ring colors, countdown expiry, transient failure, late bridge, timeout recovery, narrow viewport');
} finally {
  await browser?.close(); await new Promise(r=>server.close(r)); await archive.close();
}
