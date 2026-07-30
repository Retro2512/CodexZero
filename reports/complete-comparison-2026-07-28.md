# Complete CodexZero comparison — 2026-07-28

## Result

**Best defensible claim:** CodexZero's strength is verified cost reduction without giving up task correctness. Standard passed 18/18 strict micro tasks with 17.1% fewer provider tokens and 20.2% lower weighted cost. The independent Max Savings repeat passed 18/18 with 13.7% fewer tokens and 20.6% lower cost.

This pass now covers **632 completed inference cells** plus 10 explicitly retained usage-cap failures/probes. Vendor-published results are never mixed into fresh local rankings.

## Main fresh medium-reasoning micro

| Configuration | Strict tasks | Checks | Mean tokens | Cache | Mean cost | Paired tokens vs stock | Paired cost vs stock |
|---|---:|---:|---:|---:|---:|---:|---:|
| Stock Codex | 36/36 | 294/294 | 46,772 | 76.2% | $0.081 | — | — |
| CodexZero Safe v0.4 | 18/18 | 147/147 | 44,275 | 84.0% | $0.062 | -4.27% | -19.01% |
| CodexZero Standard v0.4 | 18/18 | 147/147 | 38,777 | 78.1% | $0.065 | -17.09% | -20.21% |
| CodexZero Focused v0.4 | 18/18 | 147/147 | 40,454 | 77.5% | $0.069 | -13.51% | -15.55% |
| Codex + RTK | 35/36 | 293/294 | 48,979 | 71.9% | $0.095 | +4.72% | +16.53% |
| Codex + Caveman | 36/36 | 294/294 | 65,063 | 77.4% | $0.115 | +39.11% | +40.82% |
| Codex + RTK + Caveman | 36/36 | 294/294 | 68,536 | 77.2% | $0.124 | +46.53% | +53.07% |
| Context Mode 1.0.169 | 15/18 | 144/147 | 87,220 | 73.7% | $0.180 | +86.48% | +121.71% |
| LeanCTX 3.9.12 | 5/6 | 50/51 | 128,454 | 81.2% | $0.195 | +159.84% | +145.57% |
| Headroom 0.32.1 proxy-only | 0/18 | 114/147 | 41,612 | 75.9% | $0.078 | -11.03% | -3.61% |
| Headroom 0.32.1 default stack | 0/18 | 99/147 | 77,293 | 74.3% | $0.147 | +65.26% | +80.99% |
| CodexZero legacy lean-prompt adapter | 18/18 | 147/147 | 39,767 | 76.5% | $0.070 | -15.91% | -19.42% |

Headroom's two rows failed the strict task contract, so their token deltas are not usable wins. LeanCTX and Context Mode also lost task checks in this micro.

## Max means two different things

### Max Savings product mode — independent medium repeat

| Arm | Strict tasks | Mean tokens | Cache | Mean cost | Paired token reduction | Paired cost reduction |
|---|---:|---:|---:|---:|---:|---:|
| Stock Codex | 18/18 | 46,045 | 67.9% | $0.0968 | +0.00% | +0.00% |
| CodexZero Max Savings | 18/18 | 39,753 | 72.3% | $0.0768 | +13.67% | +20.60% |

Max Savings is the compatibility name for the current Standard behavior family. This was a separate 36-cell repeat, not a relabel of the earlier rows.

### Model reasoning effort `max` — partial before account cap

| Arm | Valid/attempted | Mean tokens | Cache | Mean cost | Paired cells | Paired token reduction |
|---|---:|---:|---:|---:|---:|---:|
| Stock Codex | 17/18 | 47,866 | 68.4% | $0.1047 | 17 | +0.00% |
| CodexZero Safe | 15/18 | 43,509 | 68.4% | $0.0964 | 15 | +6.81% |
| CodexZero Max Savings | 17/18 | 40,903 | 65.2% | $0.0962 | 16 | +19.12% |
| CodexZero Focused | 17/18 | 42,181 | 66.4% | $0.0974 | 16 | +16.38% |

Six final cells returned the raw account usage-limit error rather than an inference. The valid-cell numbers above are censored and are not promoted to the main ranking.

## Newly added competitors

### Tamp 0.8.16

| Arm | Strict tasks | Total tokens | vs stock | Uncached | Cache | Weighted cost | vs stock | Native Tamp tokens removed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 18/18 | 820,681 | +0.00% | 234,873 | 71.2% | 1.6131 | +0.00% | 0 |
| Tamp Balanced (L5) | 18/18 | 668,759 | -18.51% | 264,726 | 60.1% | 1.6711 | +3.60% | 1,890 |
| Tamp Max (L9) | 18/18 | 688,632 | -16.09% | 265,163 | 61.2% | 1.6899 | +4.76% | 1,890 |

Tamp L5/L9 passed every task, but both cost more under the fixed rate card. The custom provider path changed cache metadata, so only Tamp's native 1,890-token counter is a causal compression result; the larger provider-total shifts are observational.

### Ponytail 4.8.4 — official AGENTS adapter

| Arm | Strict tasks | Total tokens | Cache | Weighted cost | Requests | Tool calls | Summed wall |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex | 18/18 | 819,617 | 70.5% | $1.6315 | 48 | 27 | 392.0s |
| Codex + Ponytail (official AGENTS.md adapter) | 18/18 | 919,506 | 75.3% | $1.6298 | 52 | 31 | 432.2s |

Ponytail used 12.19% more provider tokens; modeled cost was effectively tied at -0.11%. This was instruction-tier, not full hook-tier, and the workload does not test Ponytail's strongest open-ended code-size claim.

### Tura 0.1.34 — local strict probe

| Arm | Effort | Strict tasks | Mean tokens | Cache | Mean cost | Mean wall |
|---|---:|---:|---:|---:|---:|---:|
| Tura Direct | high | 0/1 | 22,336 | 45.6% | $0.0775 | 17.9s |
| Tura Direct | medium | 0/2 | 22,218 | 45.5% | $0.0729 | 16.8s |
| Tura Balanced | medium | 0/2 | 23,553 | 72.7% | $0.0495 | 16.3s |
| CodexZero legacy Max | medium | 3/3 | 26,863 | 61.3% | $0.0635 | 17.0s |
| Stock Codex | medium | 3/3 | 31,736 | 47.8% | $0.0941 | 12.1s |

Every Tura run executed the target command correctly, but omitted the required result line and changed workspace metadata, so the strict score is 0/5. The prior same-fixture CodexZero cells were 3/3. The sample is small and Tura is a different agent runtime.

### Tura vendor-published DeepSWE evidence — kept separate

| Published arm | Effort | Passes | Tokens | Cost | vs published Codex tokens |
|---|---:|---:|---:|---:|---:|
| codex-cli-gpt5.6-sol-medium | medium | 38/60 | 333,538,349 | $257.17 | +0.00% |
| tura-balanced-gpt5.6-sol-high | high | 48/60 | 229,695,477 | $221.14 | -31.13% |
| tura-direct-gpt5.6-sol-high | high | 39/60 | 75,108,167 | $99.62 | -77.48% |

These 180 published records recompute correctly, but Tura ran high effort while its Codex comparator is marked local modified/medium with no release hash. They are strong vendor evidence, not an apples-to-apples local ablation.

## Public Terminal-Bench replication

| Configuration | Tasks | Verifier subtests | Tokens | Cache | Cost |
|---|---:|---:|---:|---:|---:|
| Codex | 29/36 | 92/105 | 26,580,391 | 95.0% | $25.14 |
| CodexZero Safe | 29/36 | 91/105 | 22,691,418 | 93.8% | $23.28 |
| Codex + RTK | 32/36 | 95/105 | 31,550,572 | 95.0% | $28.96 |

CodexZero Safe matched stock's 29/36 task score with 14.63% fewer tokens and 7.40% lower modeled cost. RTK reached 32/36, but used 18.7% more tokens.

## Local DeepSWE high-reasoning suite

| Configuration | Resolved | Feature checks | Regression checks | Tokens | Modeled cost | Tokens vs stock |
|---|---:|---:|---:|---:|---:|---:|
| Stock Codex | 2/3 | 147/149 | 1815/1815 | 29,597,398 | $20.81 | +0.00% |
| CodexZero legacy Max | 2/3 | 147/149 | 1815/1815 | 19,987,849 | $15.74 | -32.47% |
| Codex + RTK | 1/3 | 145/149 | 1815/1815 | 17,757,324 | $14.46 | -40.00% |
| Codex + Caveman | 2/3 | 147/149 | 1815/1815 | 26,770,701 | $19.44 | -9.55% |
| Codex + RTK + Caveman | 1/3 | 145/149 | 1815/1815 | 17,954,294 | $14.27 | -39.34% |

The legacy Max adapter matched stock exactly on resolves and verifier totals while reducing provider tokens 32.47% and modeled cost 24.34%.

## Every factorial combination that was run

| Configuration | Passes | Mean tokens | Mean cost |
|---|---:|---:|---:|
| max-save | 3/3 | 33,725 | $0.140 |
| max-save+caveman | 3/3 | 34,379 | $0.145 |
| max-save+rtk | 3/3 | 33,555 | $0.159 |
| max-save+rtk+caveman | 3/3 | 45,484 | $0.147 |
| safe | 3/3 | 38,577 | $0.136 |
| safe+caveman | 3/3 | 57,860 | $0.181 |
| safe+rtk | 3/3 | 37,802 | $0.127 |
| safe+rtk+caveman | 2/3 | 58,966 | $0.170 |
| stock | 3/3 | 41,594 | $0.171 |
| stock+caveman | 3/3 | 60,865 | $0.200 |
| stock+rtk | 3/3 | 41,371 | $0.154 |
| stock+rtk+caveman | 3/3 | 61,822 | $0.174 |

## Every locally compared system

| System/mode | Family | Fresh status | Evidence |
|---|---|---|---|
| Stock Codex | baseline coding agent | compared | `reports/fast-benchmark-2026-07-28.json` |
| CodexZero Safe | guarded tool-result path | compared | `reports/fast-benchmark-2026-07-28.json` |
| CodexZero Standard | lean instructions + direct tools | compared | `reports/fast-benchmark-2026-07-28.json` |
| CodexZero Max Savings | Standard compatibility alias / lean direct-tool profile | independently repeated | `private-artifacts\fast-benchmark-20260728T013916Z\max-alias-2512.json` |
| CodexZero Focused | lean instructions + scoped code runtime | compared | `reports/fast-benchmark-2026-07-28.json` |
| RTK | command-output proxy | compared | `reports/fast-benchmark-2026-07-28.json` |
| Caveman skill | instruction/persona minimizer | compared | `reports/fast-benchmark-2026-07-28.json` |
| Context Mode | MCP sandbox, memory, routing | compared | `reports/fast-benchmark-2026-07-28.json` |
| LeanCTX | MCP context layer / optional proxy | compared, partial workload coverage | `reports/fast-benchmark-2026-07-28.json` |
| Headroom | payload compressor, proxy, MCP, memory | proxy-only and default-stack arms compared | `reports/fast-benchmark-2026-07-28.json` |
| Ponytail | instruction/persona code minimizer | official AGENTS adapter compared | `private-artifacts/ponytail-benchmark/micro-summary.json` |
| Tamp | proxy payload compressor | Balanced L5 and Max L9 compared | `private-artifacts/tamp-benchmark/run-full-20260727/report.json` |
| Tura | replacement coding-agent runtime | Direct medium/high and Balanced medium probed | `private-artifacts/tura-investigation/micro-summary.json` |

## Everything else found but not fairly completed

| Option | Family | Status | Fair next test |
|---|---|---|---|
| [sqz](https://github.com/ojuschugh1/sqz) | stdin command-output compressor | built v1.3.0; three cells attempted; zero inference due usage cap | resume the prepared 36-cell stock-vs-sqz micro after the cap resets |
| [Squeez](https://github.com/claudioemmanuel/squeez) | hook/command-output compressor + MCP | isolated Codex adapter prepared; first probe blocked before inference | 36-cell micro with raw hook-activation evidence |
| [trs (Token-Reducing Shell)](https://github.com/dPeluChe/trs) | command-output proxy + project digest | not run | same 36-cell command-output micro |
| [ai-squeeze](https://github.com/skibidiskib/ai-squeeze) | deterministic command-output compressor | not run | same 36-cell command-output micro |
| [Codex Token Guard](https://github.com/Davidcreador/codex-token-guard) | Codex-native command/output hooks | not run | micro after interactive hook trust is reproducible |
| [Token Optimizer MCP (@ooples)](https://github.com/ooples/token-optimizer-mcp) | MCP caching, diffs, filtering | not run | micro plus MCP tool-schema overhead |
| [Honey](https://github.com/Green-PT/honey-for-devs) | instruction/persona minimizer | not run | Caveman/Ponytail instruction-tier matrix |
| [RDXmin](https://github.com/JayPokale/RDXmin) | instruction rules; Claude-only output hook | not run | Codex rules-only arm; do not attribute Claude hook results |
| [Token Savior](https://github.com/Mibayy/token-savior) | MCP structural navigation + memory | not run | repo-scale exploration and repair tasks |
| [Lumen](https://github.com/ory/lumen) | semantic code search / MCP | not run | repo-scale tasks; report indexing separately |
| [jCodeMunch MCP](https://github.com/jgravelle/jcodemunch-mcp) | AST/symbol retrieval | not run | repo-scale exploration tasks |
| [SigMap](https://sigmap.io/) | deterministic code grounding / retrieval | published-only evidence reviewed | repo-scale retrieval hit-rate and end-task correctness |
| [Tentra](https://trytentra.com/blog/we-measured-99-percent-token-savings-with-a-code-graph/) | persistent code graph | published dogfood evidence reviewed | broader read paths and mixed code-change tasks |
| [ai-codex](https://github.com/skibidiskib/ai-codex) | prebuilt codebase index | not run | multi-session repo orientation suite including index cost |
| [ICM](https://github.com/rtk-ai/icm) | persistent cross-agent memory | not run | cross-session recall and resumed-task suite |
| [AICTX](https://github.com/oldskultxo/aictx) | cross-session repo continuity | not run | cold-start/resume suite |
| [ccb](https://github.com/cx994/ccb) | multi-agent bridge with persistent context | not run | multi-agent coordination suite, not single-agent micro |
| [Aimee](https://github.com/RakuenSoftware/aimee) | local agent server, memory, code graph, delegates | not run | whole-system repo suite with all delegate tokens and setup cost |
| [Distill](https://github.com/samuelfaj/distill) | local-model CLI-output distillation | not run | separate local-model hardware/latency/quality suite |
| [Token Warden](https://github.com/vukkt/token-warden) | learned rule optimizer for Claude Code | not a Codex drop-in | Claude-specific longitudinal suite |
| [pxpipe](https://github.com/teamchong/pxpipe) | lossy image rendering of text context | not run | multimodal/visual quality and cost suite |
| [OpenSlimEdit](https://github.com/ASidorenkoCode/openslimedit) | OpenCode tool-description/read-output compressor | not a Codex drop-in | OpenCode-native suite |
| [Token Optimizer (alexgreensh)](https://github.com/alexgreensh/token-optimizer) | diagnostic/context audit and coaching | not a runtime-compressor peer | measure diagnosis accuracy and downstream improvement |
| [PrismoDev](https://github.com/shanirsh/prismodev) | repository token-waste diagnostics/context packs | not a direct runtime-compressor arm | diagnostic precision and context-pack task success |
| [Tokenwatch](https://github.com/Kk120306/tokenwatch) | usage/cost measurement | measurement-only, not a competitor arm | cross-check accounting accuracy |
| [Context Gateway](https://github.com/Compresr-ai/Context-Gateway) | API-boundary history-compaction proxy | not run; different API-key/summarizer route | separate API-key proxy benchmark |
| [dense / condense](https://github.com/condense-chat/dense) | hosted request-compression proxy | Codex path listed as coming soon | run when first-class Codex support exists |
| [SuperCompress](https://www.npmjs.com/package/@agents-npm-packages/supercompress) | API-boundary prompt compression + MCP | cannot proxy ChatGPT-login Codex | separate Codex API-key benchmark |
| [GotContext](https://gotcontext.ai/) | hosted MCP context/code compression | not run; service/account-backed | service-backed repo suite with disclosed fees |
| [CTX](https://github.com/Alegau03/CTX) | OpenCode-first context runtime | not a first-class Codex path | OpenCode or explicitly generic-MCP suite |
| [Caveman Code](https://github.com/JuliusBrussee/caveman-code) | whole replacement coding agent | not the Caveman skill; not run | whole-agent repo benchmark |

SQZ and Squeez are different projects. Token Optimizer MCP and alexgreensh Token Optimizer are also different projects. Caveman skill and Caveman Code are not the same product.

## What the next run should prioritize

1. Resume the already prepared `sqz` and Squeez arms after the account cap resets.
2. Run `trs` and `ai-squeeze` on the same 36-cell command-output matrix.
3. Run Codex Token Guard with raw hook-activation proof.
4. Run Honey and RDXmin rules beside Ponytail/Caveman, adding changed LOC, files touched, complexity, dependencies, and correctness.
5. Use a separate repo-scale suite for SigMap, Tentra, Token Savior, Lumen, jCodeMunch, ai-codex, ICM, AICTX, and Aimee.

## Interpretation rules

- Task success and verifier checks outrank token reduction.
- Report uncached input, cached input, output, requests, wall time, and weighted cost; cache can reverse a token-only ranking.
- Hook installation is not evidence that hooks ran.
- Whole-agent replacements, API proxies, retrieval systems, diagnostics, and single-agent overlays do not belong in one undifferentiated leaderboard.
- Vendor-published evidence stays separate from fresh local evidence.
