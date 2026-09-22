<div align="center">

<img src="assets/readme/hero.svg" alt="CodexZero. Fewer wasted tokens. 15% fewer tokens with the same benchmark score." width="900">

[![CI](https://github.com/Retro2512/CodexZero/actions/workflows/ci.yml/badge.svg)](https://github.com/Retro2512/CodexZero/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Retro2512/CodexZero?display_name=tag&color=c9ff36&labelColor=171713)](https://github.com/Retro2512/CodexZero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-f4f2e9?labelColor=171713)](LICENSE)

**[Install](#install) &nbsp;·&nbsp; [The numbers](#the-numbers) &nbsp;·&nbsp; [What it adds](#what-it-adds) &nbsp;·&nbsp; [How it works](#how-it-works)**

</div>

<br>

**CodexZero reduces repeated command output so Codex uses fewer tokens.** It also adds custom models, a live cost counter and a cache warmer to the desktop app.

<br>

<img src="assets/readme/three-things.svg" alt="Less repetition in command output. Matching benchmark scores at 29/36. Custom models, a cost counter and a cache warmer." width="900">

<br>

## Install

For Windows x64, Intel Mac and Apple silicon Mac.

**Windows**

```powershell
irm https://raw.githubusercontent.com/Retro2512/CodexZero/main/scripts/bootstrap.ps1 | iex
```

**macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/Retro2512/CodexZero/main/scripts/bootstrap.sh | sh
```

<sub>[Windows installer](scripts/bootstrap.ps1) · [macOS installer](scripts/bootstrap.sh) · [Download packages](https://github.com/Retro2512/CodexZero/releases/latest)</sub>

<br>

## Commands

| Command | Action |
|---|---|
| `codex-zero run` | Run CodexZero. |
| `codex-zero savings` | See your token savings. |
| `codex-zero stock` | Run regular Codex. |

<br>

## The numbers

<img src="assets/benchmarks/terminal-bench-repeated.svg" alt="Stock Codex processed 26.58 million tokens and CodexZero processed 22.69 million, both scoring 29 out of 36" width="900">

We ran the same 12 software tasks, three times each, through stock Codex and through CodexZero.

> **Both scored 29 out of 36.**
> CodexZero used **3.89 million fewer tokens**, a reduction of **14.63%**.

<details>
<summary><b>Full benchmark comparison</b></summary>

<br>

| Setup | Score | Total tokens | vs. stock Codex |
|---|---:|---:|---:|
| Codex | 29/36 | 26,580,391 | baseline |
| CodexZero | 29/36 | 22,691,418 | **14.63% fewer** |

12 tasks · 3 repetitions per setup

<img src="assets/benchmarks/complete-setup-comparison.png" alt="Token use, task result, cached input, and estimated cost across CodexZero and other Codex setups" width="900">

- [Repeated benchmark report](reports/terminal-bench-2.1-replication/README.md)
- [Measurement methodology](docs/measurement.md)

</details>

<br>

## What it adds

<img src="assets/readme/extras.svg" alt="The Codex model picker listing Codex models alongside Claude, Z.ai and a local model; and a context ring showing cache warmth, cost this chat, and a Keep warm toggle" width="900">

**Custom models in the Codex dropdown.** Add Claude, Z.ai or a local model alongside your Codex models. Switch between turns.
<br><sub>Settings → Agent → Custom models · [setup and supported APIs](docs/custom-models.md)</sub>

**Live cost and cache status.** The context ring shows your conversation's API token cost and estimated cache warmth. Enable *Keep warm* to refresh the cache while the chat is idle.
<br><sub>Settings → Agent → Context cache · [cache behaviour and pricing](docs/cache-research.md)</sub>

On Windows, quit Codex, then launch the desktop features:

```text
codex-zero desktop --providers
```

<br>

## How it works

<img src="assets/readme/how-it-works.svg" alt="Repeated warnings condensed into counts alongside the original error message" width="900">

1. Your command runs.
2. The full output is saved to your disk.
3. Lines that repeat get collapsed into a count.
4. Codex receives the shorter result, or the original if no tokens are saved.

<br>

## Settings and compatibility

<details>
<summary><b>Modes and commands</b></summary>

<br>

**Standard** is the default. It uses concise instructions and Codex's normal tools.

```text
codex-zero mode standard
```

**Focused** can batch independent tool calls.

```text
codex-zero mode focused
```

`safe` uses regular Codex tools and instructions. `max-save` is an alias for Standard.

Pick a model for one run:

```text
codex-zero run --model gpt-6-astra
```

Run a configured batch of checks:

```text
codex-zero run-checks verify --summary
```

</details>

<details>
<summary><b>Compatibility</b></summary>

<br>

- Windows x64 · Intel Mac · Apple silicon Mac
- Codex CLI and Codex Desktop
- Node.js 20+ if you're building from a source checkout

Release packages include the runtime.

Quit Codex completely before running `codex-zero desktop`.

[Full compatibility notes](docs/compatibility.md)

</details>

<br>

## More

[Architecture](docs/architecture.md) &nbsp;·&nbsp; [Measurement](docs/measurement.md) &nbsp;·&nbsp; [Custom models](docs/custom-models.md) &nbsp;·&nbsp; [Cache research](docs/cache-research.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md) &nbsp;·&nbsp; [Security](SECURITY.md) &nbsp;·&nbsp; [Uninstall](docs/rollback.md)

<img src="assets/downloads/history.svg" alt="CodexZero total package download history" width="900">

<br>
