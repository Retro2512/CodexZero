"use strict";

const SCHEME = "codexzero";
const KIND = "codexZeroNotification";

function validPath(value) {
  return typeof value === "string" && value.length <= 4096 &&
    /^\/(?:local|remote)\/[^/?#\\\s]+(?:\?[^#\\\s]*)?$/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function notificationRoute(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== `${SCHEME}:` || url.hostname !== "notification" ||
        url.username || url.password || url.port || url.hash ||
        (url.pathname !== "" && url.pathname !== "/") ||
        url.searchParams.size !== 1) return null;
    const path = url.searchParams.get("path");
    return validPath(path) ? { kind: KIND, path } : null;
  } catch { return null; }
}

function escapeXml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function notificationXml(options, path, id) {
  const link = `${SCHEME}://notification?${new URLSearchParams({ path })}`;
  const reminder = options.timeoutType === "never";
  const actions = [];
  if (options.hasReply) actions.push(`<input id="reply" type="text" placeHolderContent="${escapeXml(options.replyPlaceholder)}"/>`);
  // Preserve Electron's native action/reply payloads. Only the toast body uses
  // protocol activation; clicking it never executes an approval or sends text.
  for (const [index, action] of (options.actions ?? []).entries()) {
    actions.push(`<action activationType="foreground" arguments="${escapeXml(`type=action&action=${index}&tag=${id}`)}" content="${escapeXml(action.text)}"/>`);
  }
  if (options.hasReply) actions.push(`<action activationType="foreground" arguments="${escapeXml(`type=reply&tag=${id}`)}" content="Reply" hint-inputId="reply"/>`);
  return `<toast activationType="protocol" launch="${escapeXml(link)}"${reminder ? ' scenario="reminder"' : ""}><visual><binding template="ToastGeneric"><text>${escapeXml(options.title)}</text><text>${escapeXml(options.body)}</text></binding></visual>${actions.length ? `<actions>${actions.join("")}</actions>` : ""}${options.silent ? '<audio silent="true"/>' : ""}</toast>`;
}

function createNotification(Notification, options, platform = process.platform) {
  const { codexZeroNavigationPath, ...nativeOptions } = options;
  const notification = new Notification(nativeOptions);
  if (platform === "win32" && validPath(codexZeroNavigationPath)) {
    notification.toastXml = notificationXml(nativeOptions, codexZeroNavigationPath, notification.id);
  }
  return notification;
}

module.exports = { SCHEME, notificationRoute, notificationXml, createNotification };
