import fs from "node:fs/promises";
import path from "node:path";

// Clarify continuation without replacing authentication or confirmation rules.
// The pinned Windows desktop embeds four environment-specific safety documents.
const bundleAnchor = '"browser-safety":`# Browser Safety\n';
const documentAnchor = "# Browser Safety\n";
const expectedDocuments = 4;

export const BROWSER_CONTINUATION_GUIDANCE = `
### Browser task continuation
Use an existing signed in session for the site the user authorized. Do not ask the user to sign in again merely because the page also offers a sign in button. Prefer the browser context the user selected; do not switch contexts or copy cookies to obtain access.

Do permitted navigation and ordinary sign in entry steps instead of immediately handing the whole task back. Apply the confirmation policy's implied login authorization for the named site. A sign in label alone does not mean that the next click enters credentials, grants permissions, or creates an account; classify the actual action.

Follow the authentication guidance for method selection, credential entry, verification, and protected pages. These instructions do not change credential protection or required confirmations. Do not choose an unspecified login method for the user or handle secret values yourself.

After a completed secure authentication request, verify the resulting page when observation is permitted and continue the task. Report waiting only when an actual pending request needs user input. Continue any independent authorized work while one part is blocked.

Do not add confirmation for cookie consent or Terms of Service acceptance where the existing policy explicitly permits it. A separate account creation or permission grant still follows its own confirmation rule.
`;

function insertGuidance(source, anchor, count) {
  const replacement = anchor + BROWSER_CONTINUATION_GUIDANCE + "\n";
  const patchedCount = source.split(replacement).length - 1;
  const anchorCount = source.split(anchor).length - 1;
  if (anchorCount !== count || (patchedCount !== 0 && patchedCount !== count) ||
      source.split("### Browser task continuation").length - 1 !== patchedCount) {
    throw new Error("This Codex version needs an updated browser continuation patch");
  }
  if (patchedCount === count) return source;
  return source.split(anchor).join(replacement);
}

export function patchBrowserContinuation(source) {
  return insertGuidance(source, bundleAnchor, expectedDocuments);
}

export function patchBrowserContinuationDocument(source) {
  // Keep original line endings, including those in the inserted guidance.
  const crlf = source.includes("\r\n");
  const normalized = crlf ? source.replaceAll("\r\n", "\n") : source;
  const patched = insertGuidance(normalized, documentAnchor, 1);
  return crlf ? patched.replaceAll("\n", "\r\n") : patched;
}

export async function patchCopiedBrowserContinuation(appRoot) {
  const root = path.join(appRoot, "resources", "cua_node", "bin", "node_modules", "@oai", "browser-desktop");
  const files = [
    { file: path.join(root, "scripts", "browser-service.mjs"), patch: patchBrowserContinuation },
    { file: path.join(root, "environment-docs", "codex-app", "browser-safety.md"), patch: patchBrowserContinuationDocument },
  ];
  // Validate every input before changing the copied application.
  const changes = [];
  for (const { file, patch } of files) {
    const original = await fs.readFile(file, "utf8");
    changes.push({ file, original, patched: patch(original) });
  }
  for (const { file, original, patched } of changes) {
    if (patched !== original) await fs.writeFile(file, patched);
  }
  return changes.map(({ file }) => file);
}
