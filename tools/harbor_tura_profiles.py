"""Explicit Harbor adapters for the remaining Tura benchmark profiles.

Keep each benchmark arm as a separate import path so Harbor manifests record
the exact Tura agent, reasoning effort, and routing mode being measured.
"""

from __future__ import annotations

from typing import override

from tools.harbor_tura_agent import TuraBalanced


class TuraBalancedMedium(TuraBalanced):
    """Balanced, medium reasoning, standard routing (32-task catch-up)."""

    @staticmethod
    @override
    def name() -> str:
        return "tura-balanced-medium"


class TuraDirectLow(TuraBalanced):
    """Direct, low reasoning, standard routing (matched fast comparison)."""

    _AGENT_ID = "direct"
    _REASONING_EFFORT = "low"

    @staticmethod
    @override
    def name() -> str:
        return "tura-direct-low"


class TuraBalancedProductDefault(TuraBalanced):
    """Balanced with Tura 0.1.34's shipped high/priority runtime settings."""

    _REASONING_EFFORT = "high"
    _PRIORITY = True

    @staticmethod
    @override
    def name() -> str:
        return "tura-balanced-product-default"
