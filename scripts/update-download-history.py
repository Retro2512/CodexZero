#!/usr/bin/env python3
"""Record GitHub release package downloads and render the README chart."""

from __future__ import annotations

import argparse
import json
import math
import os
import urllib.request
from datetime import datetime, timezone
from html import escape
from pathlib import Path


def release_downloads(repository: str) -> int:
    total = 0
    page = 1
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "CodexZero download history",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    while True:
        request = urllib.request.Request(
            f"https://api.github.com/repos/{repository}/releases"
            f"?per_page=100&page={page}",
            headers=headers,
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            releases = json.load(response)

        for release in releases:
            for asset in release.get("assets", []):
                if not asset["name"].endswith(".sha256"):
                    total += int(asset.get("download_count", 0))

        if len(releases) < 100:
            return total
        page += 1


def load_history(path: Path, repository: str) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {
        "repository": repository,
        "metric": "release-package-downloads",
        "points": [],
    }


def write_history(path: Path, history: dict, total: int, now: datetime) -> None:
    today = now.date().isoformat()
    points = history.setdefault("points", [])
    if points and points[-1]["date"] == today:
        points[-1]["downloads"] = total
    else:
        points.append({"date": today, "downloads": total})

    history["updated_at"] = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(history, indent=2) + "\n", encoding="utf-8")


def nice_ceiling(value: int) -> int:
    if value <= 10:
        return 10
    magnitude = 10 ** math.floor(math.log10(value))
    normalized = value / magnitude
    step = 1 if normalized <= 1 else 2 if normalized <= 2 else 5 if normalized <= 5 else 10
    return step * magnitude


def render_svg(path: Path, history: dict) -> None:
    points = history["points"]
    width, height = 960, 360
    left, right, top, bottom = 72, 930, 112, 298
    chart_width, chart_height = right - left, bottom - top
    maximum = nice_ceiling(max(point["downloads"] for point in points))

    def x_at(index: int) -> float:
        if len(points) == 1:
            return left + chart_width / 2
        return left + chart_width * index / (len(points) - 1)

    def y_at(value: int) -> float:
        return bottom - chart_height * value / maximum

    coordinates = [(x_at(index), y_at(point["downloads"])) for index, point in enumerate(points)]
    if len(coordinates) == 1:
        chart_paths = ""
        date_labels = (
            f'<text x="{coordinates[0][0]:.1f}" y="329" text-anchor="middle" '
            f'fill="#8b949e" font-size="13">{escape(points[0]["date"])}</text>'
        )
    else:
        line = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in coordinates)
        area = (
            f"M {coordinates[0][0]:.1f} {bottom} L "
            + " L ".join(f"{x:.1f} {y:.1f}" for x, y in coordinates)
            + f" L {coordinates[-1][0]:.1f} {bottom} Z"
        )
        chart_paths = (
            f'<path d="{area}" fill="url(#area)"/>'
            f'<path d="{line}" fill="none" stroke="#58a6ff" stroke-width="3" '
            'stroke-linecap="round" stroke-linejoin="round"/>'
        )
        date_labels = (
            f'<text x="{left}" y="329" fill="#8b949e" font-size="13">'
            f'{escape(points[0]["date"])}</text>'
            f'<text x="{right}" y="329" text-anchor="end" fill="#8b949e" '
            f'font-size="13">{escape(points[-1]["date"])}</text>'
        )

    grid = []
    for index in range(5):
        value = round(maximum * index / 4)
        y = y_at(value)
        grid.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" '
            'stroke="#30363d" stroke-width="1"/>'
            f'<text x="{left - 14}" y="{y + 5:.1f}" text-anchor="end" '
            f'fill="#8b949e" font-size="13">{value:,}</text>'
        )

    total = points[-1]["downloads"]
    updated = escape(history["updated_at"])
    repository = escape(history["repository"])
    last_x, last_y = coordinates[-1]

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">
  <title>CodexZero package download history</title>
  <desc>{total:,} release package downloads as of {updated}. Checksum downloads are excluded.</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2f81f7" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#2f81f7" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" rx="14" fill="#0d1117"/>
  <text x="32" y="42" fill="#f0f6fc" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="21" font-weight="650">Total package downloads</text>
  <text x="32" y="70" fill="#8b949e" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="14">{repository} · updated daily</text>
  <text x="{right}" y="53" text-anchor="end" fill="#f0f6fc" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="34" font-weight="700">{total:,}</text>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
    {''.join(grid)}
    {chart_paths}
    <circle cx="{last_x:.1f}" cy="{last_y:.1f}" r="5" fill="#58a6ff" stroke="#0d1117" stroke-width="3"/>
    {date_labels}
  </g>
</svg>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="Retro2512/CodexZero")
    parser.add_argument("--data", type=Path, default=Path("assets/downloads/history.json"))
    parser.add_argument("--output", type=Path, default=Path("assets/downloads/history.svg"))
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    history = load_history(args.data, args.repo)
    write_history(args.data, history, release_downloads(args.repo), now)
    render_svg(args.output, history)


if __name__ == "__main__":
    main()
