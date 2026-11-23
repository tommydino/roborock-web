import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from history import History, Run
from robot import DeviceController
from timeline import cleaned_segments, read_timeline, timeline_rows


class RecordTimelineTest(unittest.TestCase):
    def test_paged_run_including_same_minute_steps(self):
        # Synthetic protocol fixture matching the documented test run sequence.
        begin = 1000

        def event(offset, code, **fields):
            return {"t": begin + offset, "i": code, "e": fields}

        first = [
            event(0, 25, **{"252": 3, "8": 1, "254": [0, 0, 1]}),
            event(1, 25, **{"252": 3, "8": 1, "254": [0, 0, 1]}),
            event(1, 56, **{"7": 1}),
            event(120, 42, **{"2": 16, "3": 2, "4": 0, "5": 0, "6": 1}),
            event(360, 54, **{"541": 2}),
            event(420, 55, **{"7": 1}),
            event(420, 52),
        ]
        second = [
            first[-1],
            event(600, 13, **{"131": 1}),
            event(600, 42, **{"2": 16, "3": 5, "4": 2, "5": 1, "6": 1, "9": 2, "11": 15}),
            event(1020, 52, **{"521": 2, "522": 1}),
            event(1440, 61, **{"611": 3}),
            event(1440, 42, **{"2": 36}),
            event(1620, 12),
        ]
        channel = AsyncMock()
        channel.send_command.side_effect = [
            [{"from": 0, "num": len(first), "more": 1, "events": first}],
            {"result": {"from": len(first), "num": len(second), "more": 0, "events": second}},
        ]
        rows = timeline_rows(asyncio.run(read_timeline(channel, begin)), {16: "Bathroom"})
        self.assertEqual(channel.send_command.call_args.kwargs["params"],
                         {"begin": begin, "id": 0, "type": 0, "from": len(first)})
        self.assertEqual([row["label"] for row in rows], [
            "Start selective room cleaning", "Detaching mop cloth mounts", "Clean Bathroom",
            "Auto Emptying", "Installing mop cloth mounts", "Wash Mop", "Resume",
            "Clean Bathroom", "Wash Mop", "Automatic Re-Mopping", "Cleaning Finished",
        ])
        self.assertEqual(sum(row["label"].startswith("Start ") for row in rows), 1)
        self.assertEqual(rows[0]["detail"].split(" · "), ["Comprehensive Home Environment Perception",
                         "Smart Dynamic Path Planning", "High Coverage", "Vac followed by Mop"])
        self.assertEqual([rows[i]["detail"] for i in [2, 3, 7, 8]],
                         ["Vacuum · ×1", "Balanced", "Mop · ×1", "Deep · Warm Water"])
        self.assertEqual(rows[4]["at"], rows[5]["at"])
        self.assertEqual(rows[2]["clean"], {"mode": "Vacuum", "clean_mode": 102,
                         "water_mode": 200, "mop_mode": 300, "repeat_count": 1,
                         "mop_type": None, "mop_power": None})
        self.assertEqual(rows[7]["clean"], {"mode": "Mop", "clean_mode": 105,
                         "water_mode": 202, "mop_mode": 301, "repeat_count": 1,
                         "mop_type": 2, "mop_power": 15})
        self.assertEqual(cleaned_segments(first + second), {16})
        self.assertEqual(cleaned_segments(first + second, mopped=True), {16})
        history = History(None)
        now = int(time.time())
        history.add(Run("summary", now - 1620, now, duration=900, complete=True,
                        wash_count=2, dust_collected=True, device_events=first + second))
        summary = history.list()[0]
        self.assertEqual(summary["empty_count"], 1)
        self.assertTrue(summary["remopped"])
        self.assertEqual(summary["wash_count"], 2)
        self.assertTrue(summary["dust_collected"])
        history._observations.close()

    def test_saros_string_fragments_match_app_timeline(self):
        begin = 1795256547

        def event(offset, code, fields):
            return {"t": begin + offset, "i": code, "e": json.dumps(fields)}

        events = [
            event(1, 25, {"254": [8388883, 402724881, 589299713, 4113]}),
            event(1, 25, {"0": 254}),
            event(1, 25, {"253": 0, "8": 0}),
            event(1, 25, {"251": 2, "252": 3, "3": 2, "4": 35, "5": 0, "6": 1, "11": 1}),
            event(1, 52, {"521": 3, "522": 0}),
            event(181, 13, {"131": 14}),
            event(181, 42, {"2": 6, "3": 2, "4": 35, "5": 0, "6": 1, "11": 1}),
            event(421, 54, {"541": 2}),
            event(481, 52, {"521": 2, "522": 2}),
            event(841, 61, {"611": 3}),
            event(841, 42, {"2": 36, "421": 3}),
            event(961, 12, {}),
            event(1021, 52, {"521": 2, "522": 1}),
        ]
        rows = timeline_rows(events, {6: "Kitchen1"})
        self.assertEqual([row["label"] for row in rows], [
            "Start selective room cleaning", "Wash Mop", "Resume", "Clean Kitchen1",
            "Auto Emptying", "Wash Mop", "Automatic Re-Mopping", "Cleaning Finished", "Wash Mop",
        ])
        self.assertEqual(rows[0]["detail"].split(" · "), [
            "Comprehensive Home Environment Perception", "Smart Dynamic Path Planning",
            "High Coverage", "Vac & Mop",
        ])
        self.assertEqual(rows[3]["detail"], "Vac & Mop · ×1")
        self.assertEqual(rows[4]["detail"], "Balanced")
        self.assertEqual(rows[5]["detail"], "Deep · Hot Water")
        self.assertIn("dirty area is detected", rows[6]["detail"])
        self.assertEqual(rows[8]["detail"], "Deep · Warm Water")

        history = History(None)
        history.add(Run(str(begin), begin, begin + 1021, wash_count=2, device_events=events))
        self.assertEqual(history.detail(str(begin))["wash_count"], 3)
        history._observations.close()

    def test_incomplete_or_repeated_page_is_not_cached_as_complete(self):
        channel = AsyncMock()
        channel.send_command.return_value = {"more": 1, "num": 0, "events": []}
        with self.assertRaises(ValueError):
            asyncio.run(read_timeline(channel, 1000))

    def test_unconfirmed_events_do_not_gain_app_labels(self):
        rows = timeline_rows([{"t": 1, "i": 56, "e": {}}, {"t": 2, "i": 47, "e": {}},
                              {"t": 3, "i": 42, "e": {"2": 36}}], {})
        self.assertEqual(rows, [])

    def test_malformed_string_event_is_ignored_without_losing_valid_events(self):
        rows = timeline_rows([
            {"t": 1, "i": 25, "e": "not-json"},
            {"t": 2, "i": 12, "e": "{}"},
        ], {})
        self.assertEqual([row["label"] for row in rows], ["Start cleaning", "Cleaning Finished"])

    def test_existing_run_loads_and_persists_independently_of_map_and_summary(self):
        begin = int(time.time()) - 300
        rid = str(begin)
        channel = AsyncMock()
        channel.send_command.return_value = {"from": 0, "more": 0, "events": [
            {"t": begin + 2, "i": 55, "e": {"7": 1}},
        ]}
        properties = SimpleNamespace(device_features=SimpleNamespace(is_clean_history_time_line_supported=True),
                                     clean_summary=SimpleNamespace(rpc_channel=channel))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            history = History(path)
            run = Run(rid, begin, begin + 30, source="robot", route={"map": "abc"}, record_details={})
            history.add(run)
            device = SimpleNamespace(duid="test", v1_properties=properties)
            controller = DeviceController(device, history=history)
            self.assertTrue(controller.needs_timeline(rid))
            detail = asyncio.run(controller.run_detail(rid))
            self.assertEqual(detail["device_timeline"][0]["label"], "Installing mop cloth mounts")
            self.assertFalse(controller.needs_timeline(rid))
            # A map fetch started before the timeline arrived may save its older Run object later.
            history.add(run)
            restored = History(path)
            self.assertEqual(restored.detail(rid)["device_timeline"], detail["device_timeline"])
            history._observations.close()
            restored._observations.close()
