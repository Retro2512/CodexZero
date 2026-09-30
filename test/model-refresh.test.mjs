import test from "node:test";
import assert from "node:assert/strict";
import { patchModelRefresh } from "../src/model-refresh-patch.mjs";

const modelQuery = "refetchOnWindowFocus:!0,staleTime:kv.FIVE_MINUTES,queryFn:()=>(a&&u.removeQueries({exact:!0,queryKey:Q2n(r,t,o)}),ep(d,r).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:o}))";
const refreshedModelQuery = "refetchOnWindowFocus:!0,refetchInterval:kv.FIVE_MINUTES,refetchIntervalInBackground:!1,staleTime:kv.FIVE_MINUTES,queryFn:()=>(a&&u.removeQueries({exact:!0,queryKey:Q2n(r,t,o)}),ep(d,r).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:o}))";

test("model refresh patches only the targeted model-list query", () => {
  const source = `const unrelated={staleTime:kv.FIVE_MINUTES};\nuseQuery({...${modelQuery},select:mapModels});\nconst trailing=1;`;
  const expected = `const unrelated={staleTime:kv.FIVE_MINUTES};\nuseQuery({...${refreshedModelQuery},select:mapModels});\nconst trailing=1;`;

  assert.equal(patchModelRefresh(source), expected);
});

test("model query keeps focus refresh and five-minute staleness with a five-minute background-disabled interval", () => {
  const patched = patchModelRefresh(modelQuery);

  assert.match(patched, /refetchOnWindowFocus:!0/);
  assert.match(patched, /refetchInterval:kv\.FIVE_MINUTES/);
  assert.match(patched, /refetchIntervalInBackground:!1/);
  assert.match(patched, /staleTime:kv\.FIVE_MINUTES/);
});

test("model refresh rejects missing or duplicate anchors", () => {
  assert.throws(() => patchModelRefresh("unrecognized bundle"), /updated model refresh patch/);
  assert.throws(() => patchModelRefresh(`${modelQuery};${modelQuery}`), /updated model refresh patch/);
});
