"""Historical cleaning timeline reported by the robot's get_clean_detail RPC."""
from __future__ import annotations

import json
from typing import Any


def number(value: Any) -> int | None:
    if type(value) is int:
        return value
    if isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 12:
        return int(value)
    return None


async def read_timeline(channel, begin: int) -> list[dict]:
    offset = 0
    events = []
    seen = set()
    for _ in range(128):
        page = await channel.send_command("get_clean_detail", params={"begin": begin, "type": 0, "id": 0, "from": offset})
        if isinstance(page, list) and len(page) == 1:
            page = page[0]
        if isinstance(page, dict) and "result" in page:
            page = page["result"]
        if not isinstance(page, dict) or not isinstance(page.get("events"), list):
            raise ValueError("Missing events in cleaning detail response")
        if number(page.get("from", offset)) != offset or number(page.get("begin", begin)) != begin:
            raise ValueError("Cleaning detail page belongs to another request")
        for item in page["events"]:
            if not isinstance(item, dict) or number(item.get("i")) is None or number(item.get("t")) is None:
                continue
            key = json.dumps(item, sort_keys=True, separators=(",", ":"))
            if key not in seen:
                seen.add(key)
                events.append(item)
        more = page.get("more", 0)
        if more in (0, "0"):
            return events
        if more not in (1, "1"):
            raise ValueError("Invalid cleaning detail continuation flag")
        count = number(page.get("num"))
        if not count or count < 0 or not page["events"]:
            raise ValueError("Cleaning detail cursor did not advance")
        offset += count
    raise ValueError("Too many cleaning detail pages")


def field(fields, key):
    if isinstance(fields, dict):
        return fields.get(str(key))
    if isinstance(fields, list) and key < len(fields):
        return fields[key]
    return None


def attribute(fields, key):
    return number(field(fields, key))


def cleaning_plan(fields):
    details = []
    preferences = field(fields, 254)
    if (attribute(fields, 253) != 1 and attribute(fields, 252) is not None
            and isinstance(preferences, list) and len(preferences) >= 3
            and all(type(part) is int for part in preferences[:3])):
        direction = (preferences[0] >> 28) & 15
        sequence = (preferences[0] >> 24) & 15
        collision = preferences[2] & 15
        details.append("Comprehensive Home Environment Perception")
        details.append({1: "Sequential Room Cleaning", 2: "Custom Room Cleaning Sequence",
                        3: "Default Room Cleaning Sequence"}.get(sequence))
        details.append({1: "Cleaning Along Floor Direction", 2: "Automatic Cleaning Direction Switch"}.get(
            direction, "Smart Dynamic Path Planning"))
        details.append({1: "High Coverage", 2: "Less Collision"}.get(collision))
    if attribute(fields, 8) == 1:
        details.append("Vac followed by Mop")
    return details


def timeline_rows(events, rooms):
    rows = []
    replenish = None
    for event in sorted(events, key=lambda item: number(item.get("t")) or 0):
        at = number(event.get("t"))
        if at is None or at <= 0:
            continue
        code = number(event.get("i"))
        fields = event.get("e")
        label = None
        detail = []
        if code == 25:
            label = {1: "Start full cleaning", 2: "Start zone cleaning", 3: "Start selective room cleaning",
                     11: "Start combined cleaning"}.get(
                attribute(fields, 252), "Start cleaning")
            detail = cleaning_plan(fields)
        elif code == 12:
            label = "Cleaning Finished"
        elif code in (55, 56) and attribute(fields, 7) == 1:
            label = "Installing mop cloth mounts" if code == 55 else "Detaching mop cloth mounts"
        elif code == 54:
            label = "Auto Emptying"
            detail.append({0: "Smart", 1: "Light", 2: "Balanced", 3: "Turbo", 4: "Max"}.get(attribute(fields, 541)))
        elif code == 52:
            mode = attribute(fields, 521)
            label = {6: "Dock self-cleaning", 7: "Dock self-cleaning", 12: "On-board dirty water tank draining",
                     13: "Autonomous mop washing at the dock", 14: "Robot water tank refilling"}.get(mode, "Wash Mop")
            if mode in (0, 1, 2, 8, 10):
                detail.append({0: "Quick", 1: "Daily", 2: "Deep", 8: "Super Deep", 10: "Smart"}[mode])
                detail.append({0: "Normal Water", 1: "Warm Water", 2: "Hot Water", 3: "Steam"}.get(attribute(fields, 522)))
        elif code == 13 and attribute(fields, 131) in (1, 2, 7, 14, 16):
            label = "Resume"
        elif code == 61:
            if attribute(fields, 611) not in (None, 5):
                replenish = attribute(fields, 611)
        elif code == 42:
            segment = attribute(fields, 2)
            if segment is not None and 1 <= segment <= 31:
                label = "Clean " + (rooms.get(segment) or f"Room {segment}")
                fan, water = attribute(fields, 3), attribute(fields, 4)
                if water == 0:
                    detail.append("Vacuum")
                elif fan == 5:
                    detail.append("Mop")
                passes = attribute(fields, 6)
                if passes is not None and passes > 0:
                    detail.append(f"×{passes}")
            elif segment is not None and 35 <= segment <= 50:
                reason = attribute(fields, 611) if segment == 36 else None
                if reason is None or reason == 5:
                    reason = replenish
                if reason in (1, 2):
                    label = "Supplementary cleaning"
                elif reason == 4:
                    label = "Heavy Dirt/Stain Recognition"
                    detail.append("Heavy stains detected. High-intensity mopping started.")
                elif reason == 3:
                    label = "Automatic Re-Mopping"
                    detail.append("The robot detected a dirty area, washed the mop and mopped the area again.")
        if label:
            rows.append({"at": at, "label": label, "detail": " · ".join(filter(None, detail))})
    return rows
