from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

from .types import Decision


@dataclass(frozen=True)
class CacheKey:
    identity_type: str
    identity_id: str
    adapter: str
    identity_scope: str


class DecisionCache:
    """Caches allow and deny alike, so a denied principal stops re-hitting the
    server. Eviction is lazy, on read."""

    def __init__(
        self,
        ttl_seconds: float,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl_seconds
        self._now = now
        self._lock = threading.Lock()
        self._entries: dict[CacheKey, tuple[Decision, float]] = {}

    def get(self, key: CacheKey) -> Optional[Decision]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            decision, expires_at = entry
            if self._now() > expires_at:
                del self._entries[key]
                return None
            return decision

    def set(
        self,
        key: CacheKey,
        decision: Decision,
        ttl_seconds: Optional[float] = None,
    ) -> None:
        ttl = self._ttl if ttl_seconds is None else ttl_seconds
        with self._lock:
            self._entries[key] = (decision, self._now() + ttl)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
