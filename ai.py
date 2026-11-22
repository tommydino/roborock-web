"""AI assistant: turn plain requests into robot steps, and explain runs, with the Claude API.

Claude only proposes steps. Every step is checked here against an allow-list and the robot's
real rooms and modes; nothing runs until the person presses Run in the browser.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import Body, FastAPI, HTTPException

log = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
BETAS = ["server-side-fallback-2026-07-01"]
KEY_FILE = Path(__file__).resolve().parent / "data" / "anthropic.json"
NOT_SET_UP = "Add your Anthropic API key in Settings → AI assistant"

# Steps Claude may propose, with the params each one takes (see action() in robot.py / demo.py).
ALLOWED: dict[str, tuple[str, ...]] = {
    "start": ("repeat",),
    "pause": (),
    "resume": (),
    "stop": (),
    "dock": (),
    "locate": (),
    "clean_rooms": ("rooms", "repeat"),
    "set_repeat": ("repeat",),
    "set_cleaning_mode": ("mode",),
    "set_fan": ("code",),
    "set_water": ("code",),
    "set_mop": ("code",),
    "empty_bin": (),
    "wash_mop": (),
}

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "say": {"type": "string"},
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": list(ALLOWED)},
                    "rooms": {"type": "array", "items": {"type": "integer"}},
                    "repeat": {"type": "integer"},
                    "mode": {"type": "string"},
                    "code": {"type": "integer"},
                },
                "required": ["action"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["say", "actions"],
    "additionalProperties": False,
}

PLAN_SYSTEM = """You help someone run their Roborock robot vacuum from a web app.
You get the robot's rooms (with ids, size, when last cleaned and when due), its status and
cleaning-mode options, and things that come and go on the floor ("suspects").
Reply with "say": one or two short, friendly sentences, and "actions": the steps to do it, in order.
Use only these actions: start (whole home), pause, resume, stop, dock, locate (robot beeps),
clean_rooms {rooms: [room ids], repeat: 1-3}, set_repeat {repeat}, set_cleaning_mode {mode},
set_fan {code}, set_water {code}, set_mop {code}, empty_bin, wash_mop.
Use only room ids, modes and codes that appear in the context. Set the cleaning mode before cleaning.
If it's a question (for example "what got missed this week?"), answer in "say" and return no actions.
If you can't do what was asked, say so briefly and return no actions."""

EXPLAIN_SYSTEM = """You explain a robot vacuum's cleaning run or error to its owner.
Write 2-3 short plain sentences: what happened, the likely cause, and one thing to do.
No headings, no lists, no jargon."""


# ---------- credentials ----------

def saved_key() -> str | None:
    try:
        key = json.loads(KEY_FILE.read_text()).get("api_key")
    except (OSError, ValueError, AttributeError):
        return None
    return key if isinstance(key, str) and key.strip() else None


def save_key(key: str) -> None:
    key = key.strip()
    if not key:
        KEY_FILE.unlink(missing_ok=True)
        return
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"api_key": key}, f)
    os.chmod(KEY_FILE, 0o600)


def key_source() -> str | None:
    if saved_key():
        return "settings"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "environment"
    if (Path.home() / ".config" / "anthropic").exists() or (Path.home() / ".anthropic").exists():
        return "profile"
    return None


def make_client() -> Any:
    import anthropic

    key = saved_key()
    try:
        return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
    except Exception:  # no credentials anywhere
        raise HTTPException(400, NOT_SET_UP) from None


# ---------- calling Claude ----------

def ask_claude(client: Any, system: str, prompt: str, effort: str, schema: dict | None = None) -> str:
    import anthropic

    output_config: dict[str, Any] = {"effort": effort}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=2000,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config=output_config,
            betas=BETAS,
            fallbacks="default",
        )
    except anthropic.AuthenticationError:
        raise HTTPException(400, "Your Anthropic API key didn't work. Check it in Settings → AI assistant.") from None
    except anthropic.RateLimitError:
        raise HTTPException(429, "Claude is busy right now. Try again in a minute.") from None
    except anthropic.APIStatusError as e:
        log.warning("Claude API error %s", e.status_code)
        raise HTTPException(502, "Claude couldn't answer just now. Try again in a bit.") from None
    except anthropic.APIConnectionError:
        raise HTTPException(502, "Couldn't reach Claude. Check your internet connection.") from None
    except TypeError:  # the SDK found no API key or login profile
        raise HTTPException(400, NOT_SET_UP) from None
    if response.stop_reason == "refusal":
        raise HTTPException(422, "Claude can't help with that one.")
    return next((b.text for b in response.content if b.type == "text"), "")


# ---------- validation ----------

def validate_actions(raw: Any, rooms: set[int], status: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep only allowed actions with valid params; drop everything else."""
    mode = status.get("mode") or {}
    modes = set(mode.get("cleaning_options") or [])
    codes = {k: {o.get("code") for o in mode.get(f"{k}_options") or []} for k in ("fan", "water", "mop")}
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        name = item.get("action")
        if name not in ALLOWED:
            continue
        params: dict[str, Any] = {}
        ok = True
        for p in ALLOWED[name]:
            v = item.get(p, (item.get("params") or {}).get(p) if isinstance(item.get("params"), dict) else None)
            if p == "rooms":
                ids = [int(r) for r in v or [] if isinstance(r, (int, float, str)) and str(r).lstrip("-").isdigit()]
                ids = [r for r in dict.fromkeys(ids) if r in rooms]
                ok = bool(ids)
                params["rooms"] = ids
            elif p == "repeat":
                if v is None:
                    if name == "set_repeat":
                        ok = False
                    elif name == "clean_rooms":
                        params["repeat"] = 1
                    continue
                try:
                    params["repeat"] = max(1, min(3, int(v)))
                except (TypeError, ValueError):
                    ok = False
            elif p == "mode":
                ok = isinstance(v, str) and v in modes
                params["mode"] = v
            elif p == "code":
                ok = isinstance(v, int) and v in codes[name.removeprefix("set_")]
                params["code"] = v
            if not ok:
                break
        if ok:
            out.append({"action": name, "params": params})
    return out[:12]


# ---------- context ----------

def _ago(ts: Any, now: float) -> str | None:
    if not ts:
        return None
    days = (now - ts) / 86400
    return f"{days:.1f} days ago"


async def _context(c: Any) -> tuple[dict[str, Any], dict[str, Any], set[int]]:
    status = await c.status()
    m = await c.map()
    fresh = await c.freshness()
    try:
        sus = await c.suspects()
    except Exception:  # optional
        sus = {}
    now = time.time()
    fr = {r["id"]: r for r in fresh.get("rooms") or []}
    names = {r["id"]: r.get("name") or f"Room {r['id']}" for r in m.get("rooms") or []}
    rooms = []
    for r in m.get("rooms") or []:
        f = fr.get(r["id"], {})
        due_in = None
        if f.get("last_cleaned") and f.get("interval"):
            due_in = round(f["interval"] - (now - f["last_cleaned"]) / 86400, 1)
        rooms.append({
            "id": r["id"], "name": names[r["id"]], "area_m2": r.get("area"),
            "last_cleaned": _ago(f.get("last_cleaned"), now), "last_mopped": _ago(f.get("last_mopped"), now),
            "interval_days": f.get("interval"), "due_in_days": due_in, "overdue": f.get("overdue"),
        })
    mode = status.get("mode") or {}
    ctx = {
        "rooms": rooms,
        "status": {
            "phase": status.get("phase"), "state": status.get("state"), "battery": status.get("battery"),
            "error": status.get("error"),
            "cleaning_mode": mode.get("cleaning"), "cleaning_options": mode.get("cleaning_options"),
            "fan_options": mode.get("fan_options"), "water_options": mode.get("water_options"),
            "mop_options": mode.get("mop_options"), "repeat": mode.get("repeat"),
        },
        "recent_runs": [
            {"when": _ago(r.get("begin"), now), "minutes": round((r.get("duration") or 0) / 60),
             "area_m2": r.get("area"), "complete": r.get("complete"), "mopped": r.get("mopped"),
             "rooms": [names.get(i, f"Room {i}") for i in r.get("rooms") or []]}
            for r in (fresh.get("runs") or [])[:10]
        ],
        "suspects": [
            {"name": s.get("name") or "unnamed", "room": names.get(s.get("room"), s.get("room")), "status": s.get("status")}
            for s in (sus.get("suspects") or [])[:15]
        ],
    }
    return ctx, status, set(names)


# ---------- routes ----------

def register_ai_routes(app: FastAPI, get_controller: Callable[[str], Awaitable[Any]]) -> None:
    @app.get("/api/ai")
    async def ai_state():
        src = key_source()
        return {"configured": src is not None, "source": src}

    @app.post("/api/ai/key")
    async def ai_key(key: str = Body("", embed=True)):
        save_key(key or "")
        src = key_source()
        return {"configured": src is not None, "source": src}

    @app.post("/api/devices/{duid}/ai/plan")
    async def ai_plan(duid: str, text: str = Body(..., embed=True)):
        text = text.strip()[:500]
        if not text:
            raise HTTPException(400, "Type what you'd like it to do")
        c = await get_controller(duid)
        ctx, status, rooms = await _context(c)
        client = make_client()
        prompt = f"Context:\n{json.dumps(ctx)}\n\nRequest: {text}"
        raw = ask_claude(client, PLAN_SYSTEM, prompt, "low", PLAN_SCHEMA)
        try:
            data = json.loads(raw)
        except ValueError:
            raise HTTPException(502, "Claude's answer didn't make sense. Try again.") from None
        return {"say": str(data.get("say") or ""), "actions": validate_actions(data.get("actions"), rooms, status)}

    @app.post("/api/devices/{duid}/ai/explain")
    async def ai_explain(duid: str, body: dict[str, Any] = Body(...)):
        c = await get_controller(duid)
        ctx, status, _ = await _context(c)
        if body.get("error"):
            what = {"current_error": status.get("error"), "dock_error": status.get("dock_error"),
                    "state": status.get("state"), "battery": status.get("battery")}
            ask = "Explain the robot's current error."
        else:
            begin = body.get("run_begin")
            fresh = await c.freshness()
            run = next((r for r in fresh.get("runs") or [] if r.get("begin") == begin), None)
            if run is None:
                raise HTTPException(404, "That run isn't in the history any more")
            names = {r["id"]: r["name"] for r in ctx["rooms"]}
            what = {
                "run": {"minutes": round((run.get("duration") or 0) / 60), "area_m2": run.get("area"),
                        "complete": run.get("complete"), "mopped": run.get("mopped"),
                        "rooms_covered": [names.get(i, f"Room {i}") for i in run.get("rooms") or []]},
                "typical_speed": await c.estimates(),
            }
            ask = "Explain this cleaning run."
        prompt = f"{ask}\n{json.dumps(what)}\n\nHome context:\n{json.dumps({'rooms': ctx['rooms'], 'status': ctx['status']})}"
        say = ask_claude(make_client(), EXPLAIN_SYSTEM, prompt, "medium")
        return {"say": say.strip()}
