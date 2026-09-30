function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("This Codex version needs an updated notification routing patch");
  return source.replace(before, after);
}

export function patchNotificationBootstrap(source) {
  return replaceOnce(source, "function UO(e){let t;", 'function UO(e){let cz=require("./native-notification-routing.cjs").notificationRoute(e);if(cz)return cz;let t;');
}

export function patchNotificationMain(source) {
  let result = replaceOnce(source, "let t=new l.Notification(e);", 'let t=require("./native-notification-routing.cjs").createNotification(l.Notification,e);');
  result = replaceOnce(result, "l=this.createNotification({title:c,body:gh(e.body)", "l=this.createNotification({codexZeroNavigationPath:e.navigationPath,title:c,body:gh(e.body)");
  result = replaceOnce(result, "case`localConversation`:{", 'case`codexZeroNotification`:u(e,t.path);return;case`localConversation`:{');
  // Windows emits close when the banner times out, even though the toast is
  // still in Action Center. Do not release its action callback at that point.
  return replaceOnce(result, "case`close`:return t.on(`close`,()=>{n(void 0)})", "case`close`:return t.on(`close`,e=>{if(process.platform!==`win32`||e?.reason===`userCanceled`||e?.reason===`applicationHidden`)n(void 0)})");
}
