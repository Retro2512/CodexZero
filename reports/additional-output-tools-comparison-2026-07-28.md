# Additional output-tool screen

Model: `gpt-5.6-sol` � effort: `medium` � three workloads � reused stock control.

| Tool | Strict tasks | Provider tokens | vs stock | Modeled cost | vs stock | Cache | Speed | Requests | Tool calls |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Stock Codex | 3/3 | 135,977 | baseline | $0.2462 | baseline | 75.3% | baseline | 8 | 3 |
| sqz 1.3.0 | 3/3 | 182,210 | -34.0% | $0.2905 | -18.0% | 81.4% | +4.0% | 11 | 7 |
| Squeez 1.44.0 | 3/3 | 190,320 | -40.0% | $0.4278 | -73.7% | 65.6% | +3.7% | 11 | 6 |

Both tools passed all three strict tasks. On this provider-total screen, sqz used 34.0% more tokens and Squeez used 40.0% more than the reused stock control. Local tool-output compression did not translate into end-to-end provider savings.

- Three-task screening sample; not the full 18-cell micro.
- Baseline cells are reused from the same pinned harness, model, effort, seed, and stock binary to avoid additional usage.
- Provider cache state cannot be cleared and materially affected total-token and cost results.
