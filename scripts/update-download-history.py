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
    cumulative_total = max(total, points[-1]["downloads"] if points else 0)
    if points and points[-1]["date"] == today:
        points[-1]["downloads"] = cumulative_total
        points[-1]["kind"] = "observed"
    else:
        points.append({
            "date": today,
            "downloads": cumulative_total,
            "kind": "observed",
        })

    history["updated_at"] = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(history, indent=2) + "\n", encoding="utf-8")


def nice_scale(value: int) -> tuple[int, int]:
    rough_step = max(1, value) / 4
    magnitude = 10 ** math.floor(math.log10(rough_step))
    normalized = rough_step / magnitude
    step_factor = 1 if normalized <= 1 else 2 if normalized <= 2 else 5 if normalized <= 5 else 10
    step = max(1, round(step_factor * magnitude))
    return step, max(step, math.ceil(value / step) * step)


def line_path(coordinates: list[tuple[float, float]]) -> str:
    return "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in coordinates)


def chart_tick_indices(point_count: int) -> list[int]:
    if point_count <= 8:
        return list(range(point_count))
    return sorted({round(index * (point_count - 1) / 6) for index in range(7)})


def date_label(value: str, span_days: int) -> str:
    parsed = datetime.strptime(value, "%Y-%m-%d")
    if span_days <= 31:
        return parsed.strftime("%b %d").replace(" 0", " ")
    if span_days <= 730:
        return parsed.strftime("%b %Y")
    return parsed.strftime("%Y")


def render_svg(path: Path, history: dict) -> None:
    points = history["points"]
    width, height = 960, 560
    left, right, top, bottom = 92, 930, 108, 450
    chart_width, chart_height = right - left, bottom - top
    tick_step, maximum = nice_scale(max(point["downloads"] for point in points))
    dates = [datetime.strptime(point["date"], "%Y-%m-%d").date() for point in points]
    first_day, last_day = dates[0].toordinal(), dates[-1].toordinal()
    span_days = max(1, last_day - first_day)

    def x_at(index: int) -> float:
        if first_day == last_day:
            return left + chart_width / 2
        return left + chart_width * (dates[index].toordinal() - first_day) / span_days

    def y_at(value: int) -> float:
        return bottom - chart_height * value / maximum

    coordinates = [(x_at(index), y_at(point["downloads"])) for index, point in enumerate(points)]
    first_observed = next(
        (index for index, point in enumerate(points) if point.get("kind") == "observed"),
        len(points) - 1,
    )
    estimated_coordinates = coordinates[:first_observed + 1] if first_observed else []
    observed_coordinates = coordinates[first_observed:]

    chart_paths = []
    if len(estimated_coordinates) > 1:
        chart_paths.append(
            f'<path d="{line_path(estimated_coordinates)}" fill="none" '
            'stroke="#f0442e" stroke-width="3.5" stroke-dasharray="9 7" '
            'stroke-linecap="round" stroke-linejoin="round"/>'
        )
    if len(observed_coordinates) > 1:
        chart_paths.append(
            f'<path d="{line_path(observed_coordinates)}" fill="none" '
            'stroke="#f0442e" stroke-width="4" stroke-linecap="round" '
            'stroke-linejoin="round"/>'
        )

    grid = []
    for value in range(0, maximum + tick_step, tick_step):
        y = y_at(value)
        grid.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" '
            'stroke="#e1e4e8" stroke-width="1"/>'
            f'<text x="{left - 14}" y="{y + 5:.1f}" text-anchor="end" '
            f'fill="#24292f" font-size="14">{value:,}</text>'
        )

    x_ticks = []
    for index in chart_tick_indices(len(points)):
        x, _ = coordinates[index]
        x_ticks.append(
            f'<line x1="{x:.1f}" y1="{bottom}" x2="{x:.1f}" y2="{bottom + 7}" '
            'stroke="#24292f" stroke-width="1.5"/>'
            f'<text x="{x:.1f}" y="{bottom + 28}" text-anchor="middle" '
            f'fill="#24292f" font-size="13">{escape(date_label(points[index]["date"], span_days))}</text>'
        )

    total = points[-1]["downloads"]
    updated = escape(history["updated_at"])
    repository = escape(history["repository"])
    last_x, last_y = coordinates[-1]
    observed_x, observed_y = coordinates[first_observed]

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">
  <title>CodexZero package download history</title>
  <desc>{total:,} release package downloads as of {updated}. Dashed launch-period values are estimated from release timing and repository traffic. Solid values are observed daily totals. Checksum downloads are excluded.</desc>
  <rect width="{width}" height="{height}" rx="12" fill="#ffffff"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" fill="#24292f">
    <text x="{width / 2}" y="47" text-anchor="middle" font-size="25" font-weight="650">Download history</text>
    <text x="{right}" y="48" text-anchor="end" font-size="19" font-weight="650">{total:,} total</text>
    {''.join(grid)}
    <line x1="{left}" y1="{top}" x2="{left}" y2="{bottom}" stroke="#24292f" stroke-width="2"/>
    <line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="#24292f" stroke-width="2"/>
    {''.join(chart_paths)}
    <circle cx="{observed_x:.1f}" cy="{observed_y:.1f}" r="5" fill="#ffffff" stroke="#f0442e" stroke-width="3"/>
    <circle cx="{last_x:.1f}" cy="{last_y:.1f}" r="5" fill="#f0442e" stroke="#ffffff" stroke-width="2"/>
    {''.join(x_ticks)}
    <text x="{(left + right) / 2}" y="530" text-anchor="middle" font-size="15">Date</text>
    <text x="25" y="{(top + bottom) / 2}" text-anchor="middle" font-size="15" transform="rotate(-90 25 {(top + bottom) / 2})">Package downloads</text>
    <g>
      <rect x="{left + 18}" y="{top + 17}" width="292" height="76" rx="5" fill="#ffffff" stroke="#24292f" stroke-width="1.5"/>
      <rect x="{left + 33}" y="{top + 33}" width="11" height="11" rx="2" fill="#f0442e"/>
      <text x="{left + 54}" y="{top + 44}" font-size="14" font-weight="600">{repository}</text>
      <line x1="{left + 33}" y1="{top + 68}" x2="{left + 72}" y2="{top + 68}" stroke="#f0442e" stroke-width="3" stroke-dasharray="8 6"/>
      <text x="{left + 80}" y="{top + 73}" font-size="13">Estimated</text>
      <line x1="{left + 174}" y1="{top + 68}" x2="{left + 213}" y2="{top + 68}" stroke="#f0442e" stroke-width="3"/>
      <text x="{left + 221}" y="{top + 73}" font-size="13">Observed</text>
    </g>
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
