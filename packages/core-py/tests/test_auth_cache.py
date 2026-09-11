from __future__ import annotations

from astropods_adapter_core.auth import CacheKey, Decision, DecisionCache


def key(**over: str) -> CacheKey:
    fields = {
        "identity_type": "user",
        "identity_id": "user_1",
        "adapter": "custom",
        "identity_scope": "",
    }
    fields.update(over)
    return CacheKey(**fields)  # type: ignore[arg-type]


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_returns_a_stored_decision_within_its_ttl():
    clock = Clock()
    cache = DecisionCache(60, clock)
    cache.set(key(), Decision(allowed=True, user_id="user_1"))

    clock.now = 59
    assert cache.get(key()) == Decision(allowed=True, user_id="user_1")


def test_caches_denials_so_a_denied_caller_stops_hitting_the_server():
    cache = DecisionCache(60, Clock())
    cache.set(key(), Decision(allowed=False))
    assert cache.get(key()) == Decision(allowed=False)


def test_drops_an_entry_once_its_ttl_passes():
    clock = Clock()
    cache = DecisionCache(60, clock)
    cache.set(key(), Decision(allowed=True))

    clock.now = 61
    assert cache.get(key()) is None


def test_honors_a_per_entry_ttl_shorter_than_the_default():
    clock = Clock()
    cache = DecisionCache(60, clock)
    cache.set(key(), Decision(allowed=True), 10)

    clock.now = 11
    assert cache.get(key()) is None


def test_separates_entries_that_differ_in_any_one_key_field():
    cache = DecisionCache(60, Clock())
    cache.set(key(), Decision(allowed=True))

    assert cache.get(key(identity_id="user_2")) is None
    assert cache.get(key(adapter="web")) is None
    assert cache.get(key(identity_scope="T123")) is None
    assert cache.get(key(identity_type="slack")) is None
