function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("This Codex version needs an updated notification routing patch");
  return source.replace(before, after);
}

export const NOTIFICATION_BOOTSTRAP_TARGET = "flush-pending-http-urls";
export const NOTIFICATION_MAIN_TARGET = "notification click open";

export function patchNotificationBootstrap(source) {
  return replaceOnce(source, 'function j(e){let t;try{t=new URL(e)}catch{return null}if("https:"===t.protocol){', 'function j(e){let cz=require("./native-notification-routing.cjs").notificationRoute(e);if(cz)return cz;let t;try{t=new URL(e)}catch{return null}if("https:"===t.protocol){');
}

export function patchNotificationMain(source) {
  let result = replaceOnce(source, "this.createNotification=e.createNotification??(e=>new en.Notification(e))", 'this.createNotification=e.createNotification??(e=>require("./native-notification-routing.cjs").createNotification(en.Notification,e))');
  result = replaceOnce(result, "let s=this.createNotification({title:f,", "let s=this.createNotification({codexZeroNavigationPath:e.navigationPath,title:f,");
  result = replaceOnce(result, 'case"localConversation":{', 'case"codexZeroNotification":return void l(e,t.path);case"localConversation":{');
  // Windows emits close when the banner times out, even though the toast is
  // still in Action Center. Do not release its action callback at that point.
  return replaceOnce(result, 's.on("close",()=>{this.notifications.get(e.id)?.notification===s&&this.removeNotification(e.id)})', 's.on("close",t=>{(process.platform!=="win32"||t?.reason==="userCanceled"||t?.reason==="applicationHidden")&&this.notifications.get(e.id)?.notification===s&&this.removeNotification(e.id)})');
}
