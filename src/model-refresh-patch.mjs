const modelQueryAnchor = "refetchOnWindowFocus:!0,staleTime:kv.FIVE_MINUTES,queryFn:()=>(a&&u.removeQueries({exact:!0,queryKey:Q2n(r,t,o)}),ep(d,r).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:o}))";
const refreshedModelQuery = "refetchOnWindowFocus:!0,refetchInterval:kv.FIVE_MINUTES,refetchIntervalInBackground:!1,staleTime:kv.FIVE_MINUTES,queryFn:()=>(a&&u.removeQueries({exact:!0,queryKey:Q2n(r,t,o)}),ep(d,r).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:o}))";

export function patchModelRefresh(source) {
  if (source.split(modelQueryAnchor).length !== 2) {
    throw new Error("This Codex version needs an updated model refresh patch");
  }
  return source.replace(modelQueryAnchor, refreshedModelQuery);
}
