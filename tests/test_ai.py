"""AI assistant: allow-list validation and routes, with the Claude client mocked (no real API calls)."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ai  # noqa: E402

STATUS = {"mode": {"cleaning_options": ["vacuum", "vac_and_mop"],
                   "fan_options": [{"code": 102, "name": "balanced"}],
                   "water_options": [], "mop_options": []}}


def test_validate_keeps_only_allowed_and_valid():
    raw = [
        {"action": "set_cleaning_mode", "mode": "vacuum"},
        {"action": "clean_rooms", "rooms": [16, 99, 16], "repeat": 7},
        {"action": "set_volume", "value": 100},          # not allowed
        {"action": "set_cleaning_mode", "mode": "turbo"},  # unknown mode
        {"action": "clean_rooms", "rooms": [99]},          # no real rooms
        {"action": "set_fan", "code": 102},
        {"action": "set_fan", "code": 5},                  # unknown code
        {"action": "set_repeat"},                          # missing repeat
        {"action": "dock", "params": {"evil": 1}},
        "nonsense",
    ]
    out = ai.validate_actions(raw, {16, 17}, STATUS)
    assert out == [
        {"action": "set_cleaning_mode", "params": {"mode": "vacuum"}},
        {"action": "clean_rooms", "params": {"rooms": [16], "repeat": 3}},
        {"action": "set_fan", "params": {"code": 102}},
        {"action": "dock", "params": {}},
    ]


def fake_client(text, stop="end_turn", calls=None):
    def create(**kw):
        if calls is not None:
            calls.append(kw)
        return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="text", text=text)])
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(ai, "KEY_FILE", tmp_path / "anthropic.json")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from server import create_app
    with TestClient(create_app(demo=True)) as c:
        yield c


def test_key_save_and_remove(app, tmp_path, monkeypatch):
    monkeypatch.setattr(ai, "key_source", lambda: "settings" if ai.saved_key() else None)
    r = app.post("/api/ai/key", json={"key": "sk-test"}).json()
    assert r == {"configured": True, "source": "settings"}
    assert "sk-test" not in json.dumps(app.get("/api/ai").json())
    assert (tmp_path / "anthropic.json").stat().st_mode & 0o777 == 0o600
    assert app.post("/api/ai/key", json={"key": ""}).json()["configured"] is False


def test_plan_filters_actions(app, monkeypatch):
    calls = []
    answer = json.dumps({"say": "Cleaning the kitchen.", "actions": [
        {"action": "clean_rooms", "rooms": [17], "repeat": 1},
        {"action": "set_volume", "value": 100},
    ]})
    monkeypatch.setattr(ai, "make_client", lambda: fake_client(answer, calls=calls))
    duid = app.get("/api/devices").json()
    duid = (duid[0] if isinstance(duid, list) else duid["devices"][0])["duid"]
    r = app.post(f"/api/devices/{duid}/ai/plan", json={"text": "clean the kitchen"}).json()
    assert r["say"] == "Cleaning the kitchen."
    assert r["actions"] == [{"action": "clean_rooms", "params": {"rooms": [17], "repeat": 1}}]
    kw = calls[0]
    assert kw["model"] == "claude-opus-5-5" and kw["fallbacks"] == "default"
    assert kw["output_config"]["effort"] == "low" and kw["output_config"]["format"]["type"] == "json_schema"
    assert "Kitchen" in kw["messages"][0]["content"]


def test_refusal_and_explain(app, monkeypatch):
    duid = app.get("/api/devices").json()
    duid = (duid[0] if isinstance(duid, list) else duid["devices"][0])["duid"]
    monkeypatch.setattr(ai, "make_client", lambda: fake_client("", stop="refusal"))
    assert app.post(f"/api/devices/{duid}/ai/plan", json={"text": "x"}).status_code == 422
    begin = app.get(f"/api/devices/{duid}/freshness").json()["runs"][0]["begin"]
    monkeypatch.setattr(ai, "make_client", lambda: fake_client("It finished the kitchen."))
    r = app.post(f"/api/devices/{duid}/ai/explain", json={"run_begin": begin})
    assert r.json() == {"say": "It finished the kitchen."}
    assert app.post(f"/api/devices/{duid}/ai/explain", json={"error": True}).status_code == 200
