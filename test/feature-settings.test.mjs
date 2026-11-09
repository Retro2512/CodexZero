import assert from "node:assert/strict";
import test from "node:test";
import { createFeatureSettings, featuresChanged, normalizeFeatures } from "../assets/native-cache-ui.mjs";

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: value => [value, () => {}],
};
const Section = Object.assign(() => null, { Header: () => null, Content: () => null });

function render(current) {
  globalThis.window = { codexZeroFeatures: { current, save: async value => value, restart: async () => {} } };
  const element = createFeatureSettings(React, Section)({ hostId: "local" });
  return element && element.type();
}

const text = node => node == null ? [] : typeof node === "string" ? [node] : (node.children ?? []).flatMap(text);

test("saved choices are read strictly and compared with the running app", () => {
  assert.deepEqual(normalizeFeatures({ workMode: "yes", chats: true, dots: 1 }), { workMode: false, chats: true, dots: false });
  assert.deepEqual(normalizeFeatures(null), { workMode: false, chats: false, dots: false });
  assert.equal(featuresChanged({ workMode: true, chats: false, dots: false }, { workMode: false, chats: false, dots: false }), true);
  assert.equal(featuresChanged({ workMode: false, chats: false, dots: true }, { workMode: false, chats: false, dots: false }), true);
  assert.equal(featuresChanged({ workMode: false, chats: false, dots: false }, { workMode: false, chats: false, dots: false }), false);
});

test("the section shows both switches only in the lean app", () => {
  assert.equal(render({ workMode: false, chats: false, available: false }), null);
  assert.equal(createFeatureSettings(React, Section)({ hostId: "ssh:devbox" }), null);
  const page = render({ workMode: false, chats: true, available: true });
  const labels = text(page);
  assert.ok(labels.includes("Optional features") || page.children.length > 0);
  assert.ok(labels.includes("Work mode"));
  assert.ok(labels.includes("ChatGPT chats"));
  assert.ok(labels.includes("Dots"));
  assert.ok(!labels.includes("Restart"), "nothing to restart until a choice changes");
  delete globalThis.window;
});
