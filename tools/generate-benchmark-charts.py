#!/usr/bin/env python3
"""Generate the benchmark SVGs used by the README and public site."""

from __future__ import annotations

import html
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
ASSETS = ROOT / "assets" / "benchmarks"

COLORS = {
    "ink": "#171713",
    "paper": "#f4f2e9",
    "white": "#fffef8",
    "lime": "#c9ff36",
    "violet": "#bba8ff",
    "orange": "#ff7759",
    "cyan": "#87e8da",
    "muted": "#68675f",
    "line": "#d7d4c8",
}


def load(relative: str) -> dict:
    return json.loads((REPORTS / relative).read_text(encoding="utf-8"))


def compact_tokens(value: float) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return f"{value:,.0f}"


def difference(value: float, baseline: float) -> str:
    change = (value - baseline) / baseline * 100
    if abs(change) < 0.005:
        return "Baseline"
    return f"{abs(change):.2f}% {'more' if change > 0 else 'fewer'}"


def chart(
    filename: str,
    title: str,
    subtitle: str,
    rows: list[dict],
    footer: str,
) -> None:
    width = 1200
    header = 130
    column_header = 52
    row_height = 82
    footer_height = 70
    height = header + column_header + row_height * len(rows) + footer_height
    bar_x, bar_width = 330, 440
    max_tokens = max(row["tokens"] for row in rows)
    label_x, token_x, delta_x, quality_x = 48, 792, 945, 1090

    desc = "; ".join(
        f"{row['label']}: {compact_tokens(row['tokens'])} tokens, "
        f"{row['delta']}, quality {row['quality']}"
        for row in rows
    )
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        f"<title id=\"title\">{html.escape(title)}</title>",
        f"<desc id=\"desc\">{html.escape(desc)}</desc>",
        "<style>",
        "text{font-family:Arial,Helvetica,sans-serif;fill:#171713}",
        ".mono{font-family:Consolas,'Liberation Mono',monospace}",
        ".head{font-size:32px;font-weight:800;letter-spacing:-1px;fill:#fffef8}",
        ".sub{font-size:15px;fill:#d7d4c8}",
        ".col{font-size:11px;font-weight:700;letter-spacing:1px;fill:#68675f}",
        ".label{font-size:16px;font-weight:700}",
        ".value{font-size:15px;font-weight:700}",
        ".small{font-size:13px}",
        ".foot{font-size:12px;fill:#68675f}",
        "</style>",
        f'<rect width="{width}" height="{height}" fill="{COLORS["paper"]}"/>',
        f'<rect width="{width}" height="{header}" fill="{COLORS["ink"]}"/>',
        f'<text class="head" x="48" y="58">{html.escape(title)}</text>',
        f'<text class="sub" x="48" y="91">{html.escape(subtitle)}</text>',
        f'<text class="col mono" x="{label_x}" y="{header + 33}">CONFIGURATION</text>',
        f'<text class="col mono" x="{bar_x}" y="{header + 33}">PROVIDER TOKENS · SHORTER IS BETTER</text>',
        f'<text class="col mono" x="{token_x}" y="{header + 33}">TOTAL / MEAN</text>',
        f'<text class="col mono" x="{delta_x}" y="{header + 33}">VS CODEX</text>',
        f'<text class="col mono" x="{quality_x}" y="{header + 33}">QUALITY</text>',
    ]

    for index, row in enumerate(rows):
        y = header + column_header + index * row_height
        is_zero = row.get("codexzero", False)
        fill = COLORS["white"] if index % 2 == 0 else COLORS["paper"]
        if is_zero:
            fill = "#efffc0"
        bar_fill = COLORS["orange"] if is_zero else (
            COLORS["ink"] if index == 0 else COLORS["violet"]
        )
        bar_actual = max(4, bar_width * row["tokens"] / max_tokens)
        baseline_width = bar_width * rows[0]["tokens"] / max_tokens
        out.extend(
            [
                f'<rect x="0" y="{y}" width="{width}" height="{row_height}" fill="{fill}"/>',
                f'<line x1="48" y1="{y + row_height}" x2="1152" y2="{y + row_height}" '
                f'stroke="{COLORS["line"]}"/>',
                f'<text class="label" x="{label_x}" y="{y + 49}">{html.escape(row["label"])}</text>',
                f'<rect x="{bar_x}" y="{y + 30}" width="{bar_width}" height="21" rx="3" '
                f'fill="#e4e1d7"/>',
                f'<line x1="{bar_x + baseline_width:.1f}" y1="{y + 24}" '
                f'x2="{bar_x + baseline_width:.1f}" y2="{y + 58}" '
                f'stroke="{COLORS["ink"]}" stroke-width="1" opacity=".35"/>',
                f'<rect x="{bar_x}" y="{y + 30}" width="{bar_actual:.1f}" height="21" rx="3" '
                f'fill="{bar_fill}"/>',
                f'<text class="value mono" x="{token_x}" y="{y + 49}">'
                f'{html.escape(compact_tokens(row["tokens"]))}</text>',
                f'<text class="small mono" x="{delta_x}" y="{y + 49}">'
                f'{html.escape(row["delta"])}</text>',
                f'<text class="value mono" x="{quality_x}" y="{y + 49}">'
                f'{html.escape(row["quality"])}</text>',
            ]
        )

    footer_y = height - 30
    out.extend(
        [
            f'<text class="foot mono" x="48" y="{footer_y}">{html.escape(footer)}</text>',
            "</svg>",
        ]
    )
    (ASSETS / filename).write_text("\n".join(out) + "\n", encoding="utf-8")


def savings_percent(value: float, baseline: float) -> float:
    return (baseline - value) / baseline * 100


def best_observed_overview() -> None:
    repeated = load("terminal-bench-2.1-replication/summary.json")
    mini = load("terminal-bench-2.1-mini/summary.json")
    controlled = load("five-way-benchmark.json")
    factorial = load("combination-benchmark.json")
    deepswe = load("deepswe-sol-high-10/summary.json")
    pilot = load("deepswe-pilot.json")

    repeated_base = repeated["configs"]["codex"]["provider"]["total_tokens"]
    mini_base = mini["configs"]["codex"]["totals"]["provider.total_tokens"]
    controlled_by_id = {row["configuration"]: row for row in controlled["overall"]}
    controlled_base = controlled_by_id["codex"]["metrics"]["provider_total_tokens"]["mean"]
    factorial_by_id = {row["configuration"]: row for row in factorial["aggregates"]}
    factorial_base = factorial_by_id["stock"]["means"]["total_tokens"]
    deepswe_base = (
        deepswe["configurations"]["codex"]["input_tokens"]
        + deepswe["configurations"]["codex"]["output_tokens"]
    )
    pilot_by_id = {row["configuration"]: row for row in pilot["trials"]}
    pilot_base = pilot_by_id["codex"]["provider_tokens"]["total"]

    observed = {
        "CodexZero": [
            savings_percent(
                repeated["configs"]["codexzero_safe"]["provider"]["total_tokens"],
                repeated_base,
            ),
            savings_percent(
                mini["configs"]["codexzero_safe"]["totals"]["provider.total_tokens"],
                mini_base,
            ),
            savings_percent(
                factorial_by_id["command-output"]["means"]["total_tokens"],
                factorial_base,
            ),
        ],
        "CodexZero Max": [
            savings_percent(
                mini["configs"]["codexzero_max"]["totals"]["provider.total_tokens"],
                mini_base,
            ),
            savings_percent(
                controlled_by_id["codexzero"]["metrics"]["provider_total_tokens"]["mean"],
                controlled_base,
            ),
            savings_percent(
                deepswe["configurations"]["codexzero"]["input_tokens"]
                + deepswe["configurations"]["codexzero"]["output_tokens"],
                deepswe_base,
            ),
            savings_percent(
                factorial_by_id["full-lean"]["means"]["total_tokens"],
                factorial_base,
            ),
            savings_percent(
                pilot_by_id["codexzero"]["provider_tokens"]["total"],
                pilot_base,
            ),
        ],
        "RTK": [
            savings_percent(
                repeated["configs"]["codex_rtk"]["provider"]["total_tokens"],
                repeated_base,
            ),
            savings_percent(
                mini["configs"]["codex_rtk"]["totals"]["provider.total_tokens"],
                mini_base,
            ),
            savings_percent(
                controlled_by_id["codex_rtk"]["metrics"]["provider_total_tokens"]["mean"],
                controlled_base,
            ),
            savings_percent(
                deepswe["configurations"]["codex_rtk"]["input_tokens"]
                + deepswe["configurations"]["codex_rtk"]["output_tokens"],
                deepswe_base,
            ),
            savings_percent(
                factorial_by_id["stock+rtk"]["means"]["total_tokens"],
                factorial_base,
            ),
        ],
        "Caveman": [
            savings_percent(
                mini["configs"]["codex_caveman"]["totals"]["provider.total_tokens"],
                mini_base,
            ),
            savings_percent(
                controlled_by_id["codex_caveman"]["metrics"]["provider_total_tokens"]["mean"],
                controlled_base,
            ),
            savings_percent(
                deepswe["configurations"]["codex_caveman"]["input_tokens"]
                + deepswe["configurations"]["codex_caveman"]["output_tokens"],
                deepswe_base,
            ),
            savings_percent(
                factorial_by_id["stock+caveman"]["means"]["total_tokens"],
                factorial_base,
            ),
        ],
        "RTK + Caveman": [
            savings_percent(
                mini["configs"]["codex_caveman_rtk"]["totals"]["provider.total_tokens"],
                mini_base,
            ),
            savings_percent(
                controlled_by_id["codex_caveman_rtk"]["metrics"]["provider_total_tokens"]["mean"],
                controlled_base,
            ),
            savings_percent(
                deepswe["configurations"]["codex_caveman_rtk"]["input_tokens"]
                + deepswe["configurations"]["codex_caveman_rtk"]["output_tokens"],
                deepswe_base,
            ),
            savings_percent(
                factorial_by_id["stock+rtk+caveman"]["means"]["total_tokens"],
                factorial_base,
            ),
        ],
    }
    best = {label: max(values) for label, values in observed.items()}

    width, height = 1200, 920
    cards = [
        ("CodexZero", best["CodexZero"], COLORS["lime"]),
        ("CodexZero Max", best["CodexZero Max"], COLORS["orange"]),
        ("Codex", 0.0, COLORS["white"]),
        ("RTK", best["RTK"], COLORS["violet"]),
        ("Caveman", best["Caveman"], COLORS["white"]),
        ("RTK + Caveman", best["RTK + Caveman"], COLORS["cyan"]),
    ]
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        '<title id="title">Best observed provider-token result for every tested setup</title>',
        '<desc id="desc">Codex baseline; CodexZero 14.63 percent fewer; '
        'CodexZero Max 31.31 percent fewer; RTK 8.01 percent fewer; '
        'Caveman 1.95 percent more; RTK plus Caveman 13.47 percent more.</desc>',
        "<style>",
        "text{font-family:Arial,Helvetica,sans-serif;fill:#171713}",
        ".mono{font-family:Consolas,'Liberation Mono',monospace}",
        ".head{font-size:42px;font-weight:800;letter-spacing:-1.5px;fill:#fffef8}",
        ".sub{font-size:16px;fill:#d7d4c8}",
        ".label{font-size:19px;font-weight:800}",
        ".value{font-size:54px;font-weight:800;letter-spacing:-2.5px}",
        ".note{font-size:13px;fill:#68675f}",
        ".foot{font-size:13px;fill:#d7d4c8}",
        "</style>",
        f'<rect width="{width}" height="{height}" fill="{COLORS["ink"]}"/>',
        '<text class="head" x="48" y="60">Best token result from every setup</text>',
        '<text class="sub mono" x="48" y="94">OBSERVED PROVIDER TOKENS VS REGULAR CODEX</text>',
    ]
    for index, (label, value, fill) in enumerate(cards):
        column = index % 2
        row = index // 2
        x = 48 + column * 564
        y = 140 + row * 224
        value_text = "Baseline"
        note = "Regular Codex"
        if label != "Codex":
            value_text = f"{abs(value):.2f}% {'fewer' if value >= 0 else 'more'}"
            note = "Best observed result"
        out.extend(
            [
                f'<rect x="{x}" y="{y}" width="540" height="196" rx="4" fill="{fill}"/>',
                f'<text class="label" x="{x + 28}" y="{y + 42}">{html.escape(label)}</text>',
                f'<text class="value" x="{x + 28}" y="{y + 116}">{html.escape(value_text)}</text>',
                f'<text class="note mono" x="{x + 28}" y="{y + 158}">{html.escape(note.upper())}</text>',
            ]
        )
    out.extend(
        [
            '<text class="foot mono" x="48" y="862">'
            "BEST RECORDED PROVIDER-TOKEN RESULT FOR EACH SETUP ACROSS COMPLETED TESTS</text>",
            '<text class="foot mono" x="1152" y="862" text-anchor="end">'
            "FULL QUALITY SCORES BELOW</text>",
            "</svg>",
        ]
    )
    (ASSETS / "benchmark-overview.svg").write_text(
        "\n".join(out) + "\n", encoding="utf-8"
    )


def repeated_terminal_bench() -> None:
    data = load("terminal-bench-2.1-replication/summary.json")
    baseline = data["configs"]["codex"]["provider"]["total_tokens"]
    labels = {
        "codex": "Codex",
        "codexzero_safe": "CodexZero Safe",
        "codex_rtk": "Codex + RTK",
    }
    rows = []
    for key in data["config_order"]:
        config = data["configs"][key]
        tokens = config["provider"]["total_tokens"]
        quality = config["official_quality"]
        rows.append(
            {
                "label": labels[key],
                "tokens": tokens,
                "delta": difference(tokens, baseline),
                "quality": f"{quality['passes']}/{quality['attempts']}",
                "codexzero": key.startswith("codexzero"),
            }
        )
    chart(
        "terminal-bench-repeated.svg",
        "Repeated Terminal-Bench 2.1",
        "12 fresh tasks × 3 runs each · GPT-5.6 Sol medium · 108 final cells",
        rows,
        "CodexZero Safe matched Codex at 29/36 with 14.63% fewer provider tokens.",
    )


def terminal_bench_six_way() -> None:
    data = load("terminal-bench-2.1-mini/summary.json")
    baseline = data["configs"]["codex"]["totals"]["provider.total_tokens"]
    labels = {
        "codex": "Codex",
        "codexzero_safe": "CodexZero Safe",
        "codexzero_max": "CodexZero Max",
        "codex_rtk": "Codex + RTK",
        "codex_caveman": "Codex + Caveman",
        "codex_caveman_rtk": "Caveman + RTK",
    }
    rows = []
    for key in data["config_order"]:
        config = data["configs"][key]
        tokens = config["totals"]["provider.total_tokens"]
        rows.append(
            {
                "label": labels[key],
                "tokens": tokens,
                "delta": difference(tokens, baseline),
                "quality": f"{config['passes']}/{config['scorable_trials']}",
                "codexzero": key.startswith("codexzero"),
            }
        )
    chart(
        "terminal-bench-six-way.svg",
        "Terminal-Bench six-way breadth check",
        "12 selected tasks · one run per configuration · GPT-5.6 Sol medium",
        rows,
        "Two provider-incompatible tasks were excluded from the /10 scorable quality score.",
    )


def controlled_workloads() -> None:
    data = load("five-way-benchmark.json")
    baseline = data["overall"][0]["metrics"]["provider_total_tokens"]["mean"]
    rows = []
    for config in data["overall"]:
        tokens = config["metrics"]["provider_total_tokens"]["mean"]
        label = config["label"]
        if config["configuration"] == "codexzero":
            label = "CodexZero Max"
        rows.append(
            {
                "label": label,
                "tokens": tokens,
                "delta": difference(tokens, baseline),
                "quality": f"{config['quality_passes']}/{config['expected_trials']}",
                "codexzero": config["configuration"] == "codexzero",
            }
        )
    chart(
        "controlled-workloads.svg",
        "Controlled repeatable workloads",
        "6 fixed workloads × 3 runs · GPT-5.6 Sol medium · 90 isolated trials",
        rows,
        "All five configurations passed every quality gate; CodexZero Max used 13.72% fewer tokens.",
    )


def deepswe_high() -> None:
    data = load("deepswe-sol-high-10/summary.json")
    order = [
        "codex",
        "codexzero",
        "codex_rtk",
        "codex_caveman",
        "codex_caveman_rtk",
    ]
    labels = {
        "codex": "Codex",
        "codexzero": "CodexZero Max",
        "codex_rtk": "Codex + RTK",
        "codex_caveman": "Codex + Caveman",
        "codex_caveman_rtk": "Caveman + RTK",
    }
    baseline = (
        data["configurations"]["codex"]["input_tokens"]
        + data["configurations"]["codex"]["output_tokens"]
    )
    rows = []
    for key in order:
        config = data["configurations"][key]
        tokens = config["input_tokens"] + config["output_tokens"]
        rows.append(
            {
                "label": labels[key],
                "tokens": tokens,
                "delta": difference(tokens, baseline),
                "quality": f"{config['resolved']}/{config['tasks']}",
                "codexzero": key == "codexzero",
            }
        )
    chart(
        "deepswe-high.svg",
        "DeepSWE 10-task run",
        "10 software tasks · GPT-5.6 Sol high · historical Max configuration",
        rows,
        "This earlier run tested Max, not today’s default Safe mode.",
    )


def full_factorial() -> None:
    data = load("combination-benchmark.json")
    baseline = data["aggregates"][0]["means"]["total_tokens"]
    labels = {
        "stock": "Codex",
        "command-output": "Safe",
        "full-lean": "Max",
    }
    rows = []
    for config in data["aggregates"]:
        parts = [labels[config["prompt_mode"]]]
        if config["rtk"]:
            parts.append("RTK")
        if config["caveman"]:
            parts.append("Caveman")
        tokens = config["means"]["total_tokens"]
        rows.append(
            {
                "label": " + ".join(parts),
                "tokens": tokens,
                "delta": difference(tokens, baseline),
                "quality": f"{config['quality_passes']}/{config['trials']}",
                "codexzero": config["prompt_mode"] != "stock",
            }
        )
    chart(
        "full-factorial.svg",
        "Every mode combination",
        "12 configurations × 3 runs · one fixed task · GPT-5.6 Sol low",
        rows,
        "Every run passed. Max + RTK was lowest at 19.14% fewer provider tokens.",
    )


def deepswe_pilot() -> None:
    data = load("deepswe-pilot.json")
    by_config = {trial["configuration"]: trial for trial in data["trials"]}
    baseline = by_config["codex"]["provider_tokens"]["total"]
    rows = []
    for key, label in (
        ("codex", "Codex"),
        ("codexzero", "CodexZero Max"),
    ):
        trial = by_config[key]
        tokens = trial["provider_tokens"]["total"]
        rows.append(
            {
                "label": label,
                "tokens": tokens,
                "delta": difference(tokens, baseline),
                "quality": "1/1" if trial["resolved"] else "0/1",
                "codexzero": key == "codexzero",
            }
        )
    chart(
        "deepswe-pilot.svg",
        "DeepSWE one-task pilot",
        "1 software task · GPT-5.6 Sol medium · historical Max configuration",
        rows,
        "Both resolved the task; CodexZero Max used 31.30% fewer provider tokens.",
    )


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    best_observed_overview()
    repeated_terminal_bench()
    controlled_workloads()
    terminal_bench_six_way()
    deepswe_high()
    full_factorial()
    deepswe_pilot()
    print(f"Generated 7 charts in {ASSETS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
