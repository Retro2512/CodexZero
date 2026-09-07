"""Fast-mode Harbor adapter for the pinned Tura balanced agent."""

from __future__ import annotations

from typing import override

from tools.harbor_tura_agent import TuraBalanced


class TuraBalancedFast(TuraBalanced):
    """Run Tura balanced with low model reasoning for the fast benchmark."""

    _REASONING_EFFORT = "low"

    @staticmethod
    @override
    def name() -> str:
        return "tura-balanced-fast"
