# Terminal-Bench fast comparison — 56-task extension

All runs used `gpt-5.6-sol` with low reasoning.

| Configuration | Passes | Pass rate | Measured cost | Input tokens | Missing-cost cells |
|---|---:|---:|---:|---:|---:|
| stock_compat_0146 | 31/56 | 55.4% | $24.074 | 22,784,107 | 13 |
| v050_safe | 32/56 | 57.1% | $29.267 | 31,740,837 | 13 |
| v050_standard | 29/56 | 51.8% | $21.913 | 20,323,932 | 12 |
| v050_focused | 31/56 | 55.4% | $20.306 | 17,593,717 | 12 |

## Other tools

| Configuration | Passes | Pass rate | Measured cost | Input tokens | Missing-cost cells |
|---|---:|---:|---:|---:|---:|
| stock_codex | 30/56 | 53.6% | $23.596 | 22,274,482 | 12 |
| codexzero_safe | 30/56 | 53.6% | $25.677 | 24,836,527 | 12 |
| codexzero_max | 28/56 | 50.0% | $21.078 | 17,419,673 | 12 |
| ponytail | 28/56 | 50.0% | $25.362 | 24,001,410 | 11 |
| leanctx | 32/56 | 57.1% | $34.404 | 36,734,358 | 13 |
| rtk | 30/56 | 53.6% | $25.746 | 24,316,750 | 13 |
| caveman | 28/56 | 50.0% | $28.137 | 26,743,011 | 12 |
| tura_balanced | 38/56 | 67.9% | $20.020 | 9,442,197 | 10 |

Costs and tokens exclude terminal-failure cells with no provider usage; those cells remain included in pass rates.
