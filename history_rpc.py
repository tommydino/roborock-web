"""Read-only Roborock history transport and diagnostic helpers."""

from __future__ import annotations

import asyncio
import base64
import importlib
import time
from typing import Any

from roborock.roborock_typing import RoborockCommand

HISTORY_COMMAND_TIMEOUT = 45.0
_HISTORY_RPC_LOCK = asyncio.Lock()


async def send_history_command(
    channel: Any,
    method: RoborockCommand | str,
    params: list[Any] | dict[str, Any],
    timeout: float = HISTORY_COMMAND_TIMEOUT,
) -> Any:
    """Give large historical records more time than the RPC default."""
    module = importlib.import_module(type(channel).__module__)
    original_timeout = getattr(module, "_TIMEOUT", None)
    async with _HISTORY_RPC_LOCK:
        try:
            if original_timeout is not None:
                module._TIMEOUT = timeout
            return await asyncio.wait_for(channel.send_command(method, params=params), timeout=timeout + 5)
        finally:
            if original_timeout is not None:
                module._TIMEOUT = original_timeout


async def probe_history_map(
    channel: Any, method: str, params: dict[str, Any], timeout: float
) -> tuple[Any, list[dict[str, Any]], dict[str, Any] | None]:
    """Probe a map command and observe its MQTT frames without saving payloads."""
    events: list[dict[str, Any]] = []
    transport_monitor = "unavailable"
    unsubscribe = None
    module = importlib.import_module(type(channel).__module__)
    inner_timeout_supported = getattr(module, "_TIMEOUT", None) is not None

    def capture(message: Any) -> None:
        protocol = getattr(message, "protocol", None)
        try:
            protocol_number = int(protocol)
        except (TypeError, ValueError):
            return
        if protocol_number not in {101, 102, 300, 301} or len(events) >= 40:
            return
        payload = getattr(message, "payload", None)
        events.append({
            "event": "mqtt_message",
            "seq": getattr(message, "seq", None),
            "protocol": protocol_number,
            "payload_bytes": len(payload) if isinstance(payload, bytes) else None,
            "random": getattr(message, "random", None),
            "timestamp": getattr(message, "timestamp", None),
        })

    try:
        strategies_cb = getattr(channel, "_rpc_strategies_cb", None)
        strategies = strategies_cb() if callable(strategies_cb) else []
        mqtt = next((item.channel for item in strategies if getattr(item, "name", None) == "mqtt"), None)
        subscribe = getattr(mqtt, "subscribe", None)
        if callable(subscribe):
            unsubscribe = await subscribe(capture)
            transport_monitor = "mqtt"
            events.append({"event": "monitor_started", "transport": transport_monitor})
        else:
            events.append({"event": "trace_unavailable", "reason": "map MQTT channel not exposed"})
    except Exception as err:  # diagnostics must survive unavailable private transport details
        events.append({"event": "trace_unavailable", "reason": type(err).__name__})

    started = time.monotonic()
    try:
        raw = await send_history_command(channel, method, params, timeout=timeout)
        return raw, events, None
    except Exception as err:
        return None, events, {
            "error": str(err) or type(err).__name__,
            "error_type": type(err).__name__,
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "rpc_module": type(channel).__module__,
            "inner_timeout_seconds": timeout if inner_timeout_supported else None,
            "transport_monitored": transport_monitor,
        }
    finally:
        if unsubscribe:
            unsubscribe()


def map_diagnostics(raw: Any) -> dict[str, Any]:
    """Describe saved-map blocks and retain the original bytes for analysis."""
    if not isinstance(raw, bytes):
        return {"available": False, "response": raw}

    blocks: list[dict[str, Any]] = []
    offset = int.from_bytes(raw[2:4], "little") if raw[:2] == b"rr" else len(raw)
    while 20 <= offset <= len(raw) - 8:
        block_type = int.from_bytes(raw[offset : offset + 2], "little")
        header_length = int.from_bytes(raw[offset + 2 : offset + 4], "little")
        payload_length = int.from_bytes(raw[offset + 4 : offset + 8], "little")
        end = offset + header_length + payload_length
        if header_length < 8 or end > len(raw):
            break
        block: dict[str, Any] = {
            "type": block_type,
            "header_length": header_length,
            "payload_length": payload_length,
        }
        if block_type == 34:
            entries = []
            for pos in range(offset + header_length, end - 4, 5):
                entries.append({
                    "type": raw[pos],
                    "unix_time": int.from_bytes(raw[pos + 1 : pos + 5], "little"),
                })
            block["timestamp_entries"] = entries
        blocks.append(block)
        offset = end

    return {
        "available": True,
        "byte_length": len(raw),
        "blocks": blocks,
        "raw_base64": base64.b64encode(raw).decode("ascii"),
    }
