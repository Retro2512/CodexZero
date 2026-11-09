// The model list query is defined in many chunks, so the refresh interval is
// set once as a default for every ["models","list"] query on the app's client.
export const MODEL_REFRESH_TARGET = '"core_providers.render"';

const queryClientAnchor = "function eX(){let e=new eE.E(eH.LR);";
const refreshedQueryClient = 'function eX(){let e=new eE.E(eH.LR);e.setQueryDefaults(["models","list"],{refetchInterval:3e5,refetchIntervalInBackground:!1});';

export function patchModelRefresh(source) {
  if (source.split(queryClientAnchor).length !== 2) {
    throw new Error("This Codex version needs an updated model refresh patch");
  }
  return source.replace(queryClientAnchor, () => refreshedQueryClient);
}
