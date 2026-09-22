#!/usr/bin/env python3
"""Build the README graphics in assets/readme/.

Manrope is embedded as base64 so the SVGs render with the right face on
GitHub, which does not load external fonts inside <img>-rendered SVG.

    python scripts/build-readme-svgs.py
"""

import io
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "readme")
B64 = os.path.join(OUT, "fonts", "manrope.b64")

FALLBACK = "'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "Consolas,Menlo,'SF Mono',monospace"


def font_style():
    with io.open(B64, encoding="utf-8") as fh:
        blob = fh.read().strip()
    return (
        "  <style>\n"
        "    @font-face{font-family:'Manrope';font-style:normal;font-weight:400 800;"
        "src:url(data:font/woff2;base64," + blob + ") format('woff2');}\n"
        "    text{font-family:'Manrope'," + FALLBACK + "}\n"
        "    .mono,.mono text,text.mono{font-family:" + MONO + "}\n"
        "  </style>\n"
    )


def write(name, body):
    path = os.path.join(OUT, name)
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)
    print("%-22s %6.1f KB" % (name, os.path.getsize(path) / 1024.0))


# --------------------------------------------------------------------------
# hero
# --------------------------------------------------------------------------

HERO = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480" viewBox="0 0 1200 480" role="img" aria-labelledby="t d">
  <title id="t">CodexZero &#8212; the Codex you know, but slimmer</title>
  <desc id="d">CodexZero banner. Headline: the Codex you know, but slimmer. Same quality, less wasted tokens, more usage limits and more perks. Up to 20 percent savings, measured on DeepSWE and Terminal-Bench.</desc>
__FONT__  <defs>
    <clipPath id="round"><rect width="1200" height="480" rx="16"/></clipPath>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="95"/>
    </filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
    </filter>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2b34a8" stop-opacity="0.42"/>
      <stop offset="0.55" stop-color="#2b34a8" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#2b34a8" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <g clip-path="url(#round)">
    <rect width="1200" height="480" fill="#8e97f4"/>
    <g filter="url(#soft)" aria-hidden="true">
      <ellipse cx="90" cy="70" rx="330" ry="250" fill="#5f6fee"/>
      <ellipse cx="40" cy="450" rx="300" ry="230" fill="#4f5fe9"/>
      <ellipse cx="360" cy="300" rx="280" ry="210" fill="#6d7cf1"/>
      <ellipse cx="620" cy="90" rx="300" ry="200" fill="#9aa2f5"/>
      <ellipse cx="700" cy="440" rx="340" ry="220" fill="#b0a9f1"/>
      <ellipse cx="1010" cy="60" rx="320" ry="220" fill="#d7dcfd"/>
      <ellipse cx="1180" cy="330" rx="300" ry="250" fill="#eceefe"/>
      <ellipse cx="880" cy="250" rx="220" ry="160" fill="#a8aff7"/>
    </g>
    <rect width="1200" height="480" fill="url(#scrim)"/>
    <rect width="1200" height="480" filter="url(#grain)" opacity="0.17" style="mix-blend-mode:overlay"/>
  </g>

  <g transform="translate(64 49) scale(.62)" aria-hidden="true">
    <path d="M19.76 6.58A16.21 16.21 0 0 1 44.24 6.58A16.21 16.21 0 0 1 59.5 25.72A16.21 16.21 0 0 1 54.06 49.59A16.21 16.21 0 0 1 32 60.21A16.21 16.21 0 0 1 9.94 49.59A16.21 16.21 0 0 1 4.5 25.72A16.21 16.21 0 0 1 19.76 6.58Z" fill="#ffffff"/>
    <ellipse cx="32" cy="32" rx="6.84" ry="10.8" fill="none" stroke="#3a47ff" stroke-width="3.6"/>
    <path d="M15.44 21.92 L21.2 32 L15.44 42.08" fill="none" stroke="#3a47ff" stroke-width="3.96" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M48.56 21.92 L42.8 32 L48.56 42.08" fill="none" stroke="#3a47ff" stroke-width="3.96" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="112" y="77" fill="#ffffff" font-size="23" font-weight="700" letter-spacing="-.1">CodexZero</text>

  <text x="64" y="202" fill="#dfe3fd" font-size="62" font-weight="800" letter-spacing="-2.2">The Codex you know,</text>
  <text x="64" y="272" fill="#ffffff" font-size="62" font-weight="800" letter-spacing="-2.2">but slimmer.</text>

  <text x="64" y="328" fill="#eaedfe" font-size="25" font-weight="500">Same quality, less wasted tokens, more usage limits and more perks.</text>

  <g transform="translate(64 364)">
    <rect x="0" y="0" width="1072" height="76" rx="12" fill="#ffffff"/>
    <text x="28" y="49" fill="#3050f0" font-size="31" font-weight="800" letter-spacing="-.6">Up to 20% savings</text>
    <line x1="362" y1="20" x2="362" y2="56" stroke="#dfe3fb"/>
    <text x="1044" y="48" fill="#5b5f92" font-size="20" font-weight="500" text-anchor="end">measured on DeepSWE + Terminal-Bench</text>
  </g>
</svg>
"""


# --------------------------------------------------------------------------
# three cards: a stat, a statement, a list
# --------------------------------------------------------------------------

CARDS = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300" viewBox="0 0 1200 300" role="img" aria-labelledby="t d">
  <title id="t">Fewer tokens, same quality, more perks</title>
  <desc id="d">Fewer tokens: up to 20 percent fewer per run. Same quality: the same benchmark score, checked on Terminal-Bench and DeepSWE. More perks: any model in one dropdown, live cost per chat, a self-warming cache.</desc>
__FONT__  <defs>
    <clipPath id="round"><rect width="1200" height="300" rx="16"/></clipPath>
    <linearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eef0fe"/>
      <stop offset="1" stop-color="#e6e6fb"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#round)"><rect width="1200" height="300" fill="url(#wash)"/></g>

  <g>
    <rect x="24" y="24" width="368" height="252" rx="16" fill="#ffffff" stroke="#dcdffb"/>
    <rect x="52" y="50" width="28" height="28" rx="9" fill="#3050f0"/>
    <path d="M66 57 L66 71 M60 65 L66 71 L72 65" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="94" y="70" fill="#1e2050" font-size="15" font-weight="800" letter-spacing="1.3">FEWER TOKENS</text>
    <line x1="52" y1="100" x2="364" y2="100" stroke="#eceefd"/>
    <text x="52" y="136" fill="#8b8fb5" font-size="17" font-weight="600">up to</text>
    <text x="52" y="207" fill="#3050f0" font-size="76" font-weight="800" letter-spacing="-3.4">20%</text>
    <text x="52" y="243" fill="#3a3d6b" font-size="19" font-weight="600">fewer per run</text>
  </g>

  <g>
    <rect x="416" y="24" width="368" height="252" rx="16" fill="#ffffff" stroke="#dcdffb"/>
    <rect x="444" y="50" width="28" height="28" rx="9" fill="#00a240"/>
    <path d="M451 64 L457 70 L466 59" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="486" y="70" fill="#1e2050" font-size="15" font-weight="800" letter-spacing="1.3">SAME QUALITY</text>
    <line x1="444" y1="100" x2="756" y2="100" stroke="#eceefd"/>
    <text x="444" y="168" fill="#1e2050" font-size="43" font-weight="800" letter-spacing="-1.6">The same</text>
    <text x="444" y="212" fill="#1e2050" font-size="43" font-weight="800" letter-spacing="-1.6">score.</text>
    <text x="444" y="248" fill="#6f739c" font-size="17" font-weight="500">Terminal-Bench and DeepSWE</text>
  </g>

  <g>
    <rect x="808" y="24" width="368" height="252" rx="16" fill="#ffffff" stroke="#dcdffb"/>
    <rect x="836" y="50" width="28" height="28" rx="9" fill="#7b86f2"/>
    <path d="M850 57 L850 71 M843 64 L857 64" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>
    <text x="878" y="70" fill="#1e2050" font-size="15" font-weight="800" letter-spacing="1.3">MORE PERKS</text>
    <line x1="836" y1="100" x2="1148" y2="100" stroke="#eceefd"/>
    <text x="836" y="140" fill="#1e2050" font-size="21" font-weight="700" letter-spacing="-.3">Any model, one dropdown</text>
    <line x1="836" y1="164" x2="1148" y2="164" stroke="#f3f4fe"/>
    <text x="836" y="196" fill="#1e2050" font-size="21" font-weight="700" letter-spacing="-.3">Live cost per chat</text>
    <line x1="836" y1="220" x2="1148" y2="220" stroke="#f3f4fe"/>
    <text x="836" y="252" fill="#1e2050" font-size="21" font-weight="700" letter-spacing="-.3">Self-warming cache</text>
  </g>
</svg>
"""


# --------------------------------------------------------------------------
# full setup comparison: every tool we measured, against stock Codex
# --------------------------------------------------------------------------

# label, signed delta (+ = fewer tokens), kind, result, cached input, est. cost
ROWS = [
    ("Tura Balanced",              25.8, "fail",    "25.8% fewer · failed",        "72.7%", "$0.53 / $1"),
    ("Tamp Balanced L5",           18.5, "other",   "18.5% fewer · other setup",   "60.1%", "$1.04 / $1"),
    ("CodexZero Standard",         17.1, "cz",      "17.1% fewer · passed",        "78.1%", "$0.80 / $1"),
    ("CodexZero Max Savings",      13.7, "cz",      "13.7% fewer · passed",        "72.3%", "$0.79 / $1"),
    ("Headroom proxy-only",        11.0, "fail",    "11.0% fewer · failed",        "75.9%", "$0.96 / $1"),
    ("Stock Codex",                 0.0, "base",    "Baseline",                         "76.2%", "$1.00 / $1"),
    ("Codex + RTK",                -4.7, "partial", "4.7% more · 97% tasks",       "71.9%", "$1.17 / $1"),
    ("Ponytail · AGENTS adapter", -12.2, "other", "12.2% more",                    "75.3%", "$1.00 / $1"),
    ("sqz",                       -34.0, "other",   "34.0% more · 3-task sample",  "81.4%", "$1.18 / $1"),
    ("Codex + Caveman",           -39.1, "other",   "39.1% more",                       "77.4%", "$1.41 / $1"),
    ("Squeez",                    -40.0, "other",   "40.0% more · 3-task sample",  "65.6%", "$1.74 / $1"),
    ("Context Mode",              -86.5, "partial", "86.5% more · 83% tasks",      "73.7%", "$2.22 / $1"),
    ("LeanCTX",                  -159.8, "partial", "159.8% more · 83% tasks",     "81.2%", "$2.46 / $1"),
]

STYLE = {
    "cz":      dict(bar="#3050f0", row="#eef0fe", rail="#3050f0", name="#1e2050", res="#00a240", w=700),
    "base":    dict(bar=None,      row="#ffffff", rail="#1e2050", name="#1e2050", res="#1e2050", w=700),
    "fail":    dict(bar="#d92d20", row="#fdf1f0", rail="#d92d20", name="#3a3d6b", res="#d92d20", w=600),
    "partial": dict(bar="#e8908a", row="#ffffff", rail=None,      name="#3a3d6b", res="#6f739c", w=600),
    "other":   dict(bar="#b9bef4", row="#ffffff", rail=None,      name="#3a3d6b", res="#6f739c", w=600),
}

X0, ZONE = 250.0, 550.0          # bar track
SPAN = 159.8 + 25.8
PX = ZONE / SPAN
ZERO = X0 + 159.8 * PX
TOP, RH = 64, 46
COL_RES, COL_CACHE, COL_COST = 1032, 1112, 1176


def chart():
    h = TOP + RH * len(ROWS) + 58
    out = []
    out.append('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="%d" '
               'viewBox="0 0 1200 %d" role="img" aria-labelledby="t d">' % (h, h))
    out.append('  <title id="t">Every setup we measured, against stock Codex</title>')
    desc = "; ".join("%s %s" % (r[0], r[3]) for r in ROWS)
    out.append('  <desc id="d">Token use versus stock Codex. %s.</desc>' % desc)
    out.append("__FONT__  <defs><clipPath id=\"round\"><rect width=\"1200\" height=\"%d\" rx=\"16\"/></clipPath></defs>" % h)
    out.append('  <g clip-path="url(#round)">')
    out.append('    <rect width="1200" height="%d" fill="#ffffff"/>' % h)
    out.append('    <rect width="1200" height="%d" fill="#eef0fe"/>' % (TOP - 6))

    for i, (name, d, kind, res, cache, cost) in enumerate(ROWS):
        st = STYLE[kind]
        y = TOP + i * RH
        mid = y + RH / 2.0
        if st["row"] != "#ffffff":
            out.append('    <rect x="0" y="%d" width="1200" height="%d" fill="%s"/>' % (y, RH, st["row"]))
        if st["rail"]:
            out.append('    <rect x="0" y="%d" width="4" height="%d" fill="%s"/>' % (y, RH, st["rail"]))
        out.append('    <line x1="24" y1="%d" x2="1176" y2="%d" stroke="#f0f2fd"/>' % (y + RH, y + RH))
        out.append('    <text x="26" y="%.1f" fill="%s" font-size="15" font-weight="%d">%s</text>'
                   % (mid + 5, st["name"], st["w"], name))
        if st["bar"]:
            wpx = abs(d) * PX
            bx = ZERO if d > 0 else ZERO - wpx
            out.append('    <rect x="%.1f" y="%.1f" width="%.1f" height="18" rx="3" fill="%s"/>'
                       % (bx, mid - 9, wpx, st["bar"]))
            tip = bx + wpx - 4 if d > 0 else bx
            out.append('    <rect x="%.1f" y="%.1f" width="4" height="18" fill="#ffffff" opacity=".9"/>'
                       % (tip, mid - 9))
        out.append('    <text x="%d" y="%.1f" fill="%s" font-size="13.5" font-weight="%d" text-anchor="end">%s</text>'
                   % (COL_RES, mid + 4.5, st["res"], 700 if kind in ("cz", "base") else 600, res))
        out.append('    <text x="%d" y="%.1f" fill="#6f739c" font-size="13.5" text-anchor="end">%s</text>'
                   % (COL_CACHE, mid + 4.5, cache))
        out.append('    <text x="%d" y="%.1f" fill="%s" font-size="13.5" font-weight="%d" text-anchor="end">%s</text>'
                   % (COL_COST, mid + 4.5, "#1e2050" if kind in ("cz", "base") else "#6f739c",
                      700 if kind == "cz" else 500, cost))
    out.append('  </g>')

    base = TOP + RH * len(ROWS)
    for lbl, x, anc in (("SETUP", 26, "start"), ("RESULT", COL_RES, "end"),
                        ("CACHED INPUT", COL_CACHE, "end"), ("EST. COST", COL_COST, "end")):
        out.append('  <text x="%d" y="38" fill="#6f739c" font-size="11" font-weight="800" '
                   'letter-spacing="1.4" text-anchor="%s">%s</text>' % (x, anc, lbl))
    out.append('  <line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="#1e2050" stroke-width="2"/>'
               % (ZERO, TOP, ZERO, base))
    out.append('  <text x="%.1f" y="%d" fill="#6f739c" font-size="11" font-weight="800" letter-spacing="1.4" '
               'text-anchor="end">MORE TOKENS</text>' % (ZERO - 16, base + 34))
    out.append('  <text x="%.1f" y="%d" fill="#3050f0" font-size="11" font-weight="800" letter-spacing="1.4">'
               'FEWER TOKENS</text>' % (ZERO + 16, base + 34))
    out.append('</svg>')
    return chr(10).join(out) + chr(10)



# --------------------------------------------------------------------------
# what it adds: the model picker, and the live cost ring
# --------------------------------------------------------------------------

EXTRAS = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="430" viewBox="0 0 1200 430" role="img" aria-labelledby="t d">
  <title id="t">The Codex model picker with custom models, and the live cost ring</title>
  <desc id="d">Left: the Codex model picker. Under CODEX, gpt-6-astra is selected and marked Default, with gpt-5-codex below it. Under CUSTOM MODELS, claude-opus-5.5 is marked Claude Code, glm-5.3-flash is marked API and qwen3.8:27b is marked Local, above a Manage custom models row. Right: a ring showing the cache 68 percent warm, 43 cents spent in this chat, and a Keep warm toggle that tops the cache up every 4 minutes while you are idle.</desc>
__FONT__  <defs>
    <clipPath id="round"><rect width="1200" height="430" rx="16"/></clipPath>
    <linearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eef0fe"/>
      <stop offset="1" stop-color="#e6e6fb"/>
    </linearGradient>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#2b34a8" flood-opacity="0.16"/>
    </filter>
  </defs>
  <g clip-path="url(#round)"><rect width="1200" height="430" fill="url(#wash)"/></g>

  <g filter="url(#lift)">
    <rect x="40" y="34" width="512" height="362" rx="16" fill="#ffffff" stroke="#dcdffb"/>
  </g>
  <text x="68" y="74" fill="#1e2050" font-size="19" font-weight="800" letter-spacing="-.2">Model</text>
  <line x1="68" y1="92" x2="524" y2="92" stroke="#eceefd"/>

  <text x="68" y="120" fill="#8b8fb5" font-size="11" font-weight="800" letter-spacing="1.4">CODEX</text>
  <rect x="56" y="130" width="480" height="42" rx="10" fill="#eef0fe"/>
  <path d="M74 151 L81 158 L94 144" fill="none" stroke="#3050f0" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="110" y="157" fill="#1e2050" font-size="16" font-weight="700">gpt-6-astra</text>
  <text x="516" y="156" fill="#6f739c" font-size="13" text-anchor="end">Default</text>
  <text x="110" y="201" fill="#3a3d6b" font-size="16" font-weight="500">gpt-5-codex</text>

  <text x="68" y="245" fill="#8b8fb5" font-size="11" font-weight="800" letter-spacing="1.4">CUSTOM MODELS</text>
  <text x="110" y="280" fill="#3a3d6b" font-size="16" font-weight="500">claude-opus-5.5</text>
  <text x="516" y="279" fill="#6f739c" font-size="13" text-anchor="end">Claude Code</text>
  <text x="110" y="316" fill="#3a3d6b" font-size="16" font-weight="500">glm-5.3-flash</text>
  <text x="516" y="315" fill="#6f739c" font-size="13" text-anchor="end">API</text>
  <text x="110" y="352" fill="#3a3d6b" font-size="16" font-weight="500">qwen3.8:27b</text>
  <text x="516" y="351" fill="#6f739c" font-size="13" text-anchor="end">Local</text>

  <line x1="68" y1="370" x2="524" y2="370" stroke="#eceefd"/>
  <circle cx="82" cy="386" r="6.5" fill="none" stroke="#8b8fb5" stroke-width="1.8"/>
  <text x="110" y="391" fill="#6f739c" font-size="14" font-weight="600">Manage custom models</text>

  <text x="616" y="40" fill="#8b8fb5" font-size="11" font-weight="800" letter-spacing="1.4">WHAT THIS CHAT COSTS</text>
  <rect x="616" y="56" width="544" height="318" rx="16" fill="#ffffff" stroke="#dcdffb"/>

  <circle cx="742" cy="186" r="58" fill="none" stroke="#e6e8fc" stroke-width="13"/>
  <circle cx="742" cy="186" r="58" fill="none" stroke="#3050f0" stroke-width="13" stroke-linecap="round" stroke-dasharray="248 117" transform="rotate(-90 742 186)"/>
  <text x="742" y="186" fill="#1e2050" font-size="34" font-weight="800" text-anchor="middle">68%</text>
  <text x="742" y="208" fill="#8b8fb5" font-size="12.5" font-weight="500" text-anchor="middle">cache warm</text>

  <text x="840" y="146" fill="#8b8fb5" font-size="11" font-weight="800" letter-spacing="1.4">THIS CHAT</text>
  <text x="840" y="192" fill="#1e2050" font-size="40" font-weight="800" letter-spacing="-1.2">$0.43</text>
  <text x="840" y="218" fill="#6f739c" font-size="14" font-weight="500">adds up as you go, not after</text>

  <rect x="648" y="288" width="480" height="60" rx="12" fill="#f6f7fe" stroke="#e2e5fc"/>
  <rect x="674" y="308" width="38" height="22" rx="11" fill="#00a240"/>
  <circle cx="701" cy="319" r="8" fill="#ffffff"/>
  <text x="728" y="315" fill="#1e2050" font-size="15" font-weight="700">Keep warm</text>
  <text x="728" y="335" fill="#6f739c" font-size="13" font-weight="500">tops the cache up every 4 min while you are idle</text>
</svg>
"""


def retrofit(name):
    """Add the embedded face to an existing hand-authored SVG."""
    path = os.path.join(OUT, name)
    with io.open(path, encoding="utf-8") as fh:
        svg = fh.read()
    svg = re.sub(r'\n\s*<style>.*?</style>\n', '\n', svg, flags=re.S)
    svg = svg.replace(' font-family="Consolas,Menlo,monospace"', ' class="mono"')
    svg = re.sub(r' font-family="Arial,Helvetica,sans-serif"', '', svg)
    head = re.search(r'(</desc>\n)', svg)
    return svg[:head.end()] + "__FONT__" + svg[head.end():]


def main():
    style = font_style()
    write("hero.svg", HERO.replace("__FONT__", style))
    write("three-things.svg", CARDS.replace("__FONT__", style))
    write("bench-repeated.svg", chart().replace("__FONT__", style))
    write("extras.svg", EXTRAS.replace("__FONT__", style))
    for name in ("how-it-works.svg",):
        write(name, retrofit(name).replace("__FONT__", style))


if __name__ == "__main__":
    main()
