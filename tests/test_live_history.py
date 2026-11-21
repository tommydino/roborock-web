import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from history import History, Run
from robot import DeviceController, S


class LiveTimelineTest(unittest.IsolatedAsyncioTestCase):
    async def test_detailed_timeline_capture_is_scheduled_once(self):
        history = History(None)
        device = SimpleNamespace(duid="test", v1_properties=None)
        controller = DeviceController(device, history=history)
        controller._supports_timeline = lambda: True
        controller._capture_timeline = AsyncMock()

        controller._schedule_timeline("run-1")
        controller._schedule_timeline("run-1")
        await asyncio.sleep(0)

        controller._capture_timeline.assert_awaited_once_with("run-1")
        history._observations.close()

    async def test_transitions_survive_late_records_and_restart(self):
        begin = int(time.time()) - 1800
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history-test.json"
            history = History(path)
            properties = SimpleNamespace(
                status=SimpleNamespace(repeat=1, replenish_mode=0),
                dust_collection_mode=SimpleNamespace(refresh=AsyncMock(), mode=SimpleNamespace(name="balanced")),
                wash_towel_mode=SimpleNamespace(refresh=AsyncMock(), wash_mode=SimpleNamespace(value="deep")),
                command=SimpleNamespace(send=AsyncMock(return_value=[{"wash_water_temperature": 1}])),
                device_features=SimpleNamespace(is_hot_wash_towel_supported=True),
            )
            controller = DeviceController(SimpleNamespace(duid="test", v1_properties=properties), history=history)
            controller._room_names = {7: "Office"}
            controller._room_status = {"segment_id": 7, "sequence": 1}

            async def tick(seconds, state, phase, job):
                controller.status = AsyncMock(return_value={"state": state.name, "phase": phase, "job": job})
                with patch("robot.time.time", return_value=begin + seconds):
                    controller._history_push({121: state.value})
                    await controller._history_tick()

            await tick(1, S.detaching_the_mop, "dock", False)
            await tick(60, S.segment_clean_mop_cleaning, "cleaning", True)
            await tick(61, S.segment_clean_mop_cleaning, "cleaning", True)
            await tick(300, S.emptying_the_bin, "dock", True)
            await tick(330, S.attaching_the_mop, "dock", True)
            await tick(360, S.washing_the_mop, "dock", True)
            await tick(500, S.segment_clean_mop_mopping, "cleaning", True)
            await tick(660, S.washing_the_mop_2, "dock", True)
            properties.status.replenish_mode = 1
            await tick(900, S.segment_clean_mop_mopping, "cleaning", True)
            # Simulate a process restart before the cloud publishes either record.
            restored = History(path)
            restored.add(Run("later", begin + 1200, begin + 1400))
            rid = str(begin)
            restored.add(Run(rid, begin, begin + 1000, duration=750, complete=True))
            controller.history = restored
            properties.clean_summary = SimpleNamespace(rpc_channel=SimpleNamespace(send_command=AsyncMock(
                return_value=[{"begin": begin, "clean_type": 3, "dirty_replenish": 1250000, "manual_replenish": 0}]
            )))
            await controller._load_record_details(rid)
            detail = restored.detail(rid)
            self.assertEqual(detail["record_details"], {"rooms": True, "dirty_replenish": 1.25, "manual_replenish": 0})
            events = detail["events"]
            self.assertEqual(restored.detail("later")["events"], [])
            labels = [event["label"] for event in events]
            self.assertEqual(labels[0], "Detaching mop mounts")
            self.assertEqual(labels.count("Cleaning Office"), 3)
            self.assertEqual(labels.count("Resuming cleaning"), 2)
            self.assertEqual(labels.count("Replenishment mode observed while mopping"), 1)
            empty = next(event for event in events if event["label"] == "Emptying dustbin")
            self.assertEqual(empty["detail"], "Dock setting: Balanced")
            washes = [event for event in events if event["label"] == "Washing mop"]
            self.assertEqual([event["at"] - begin for event in washes], [360, 660])
            self.assertEqual(washes[1]["detail"], "Dock setting: Deep | Warm Water")
            restored.remove(rid)
            self.assertEqual(restored._observations.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)
            restored._observations.close()
            history._observations.close()

    def test_mount_changes_between_polls_and_explicit_state_are_recorded_once(self):
        begin = int(time.time()) - 600
        history = History(None)
        controller = DeviceController(SimpleNamespace(duid="test", v1_properties=None), history=history)
        history.add(Run("first", begin, begin + 600))
        for seconds, mounted in [(0, 1), (5, 0), (10, 0), (20, 1), (200, 0)]:
            with patch("robot.time.time", return_value=begin + seconds):
                controller._observe_mop_mount(mounted, active=True)
                if seconds == 5:
                    controller._record_run_event({"state": "detaching_the_mop"})
                if seconds == 10:
                    controller._record_run_event({"state": "attaching_the_mop"})
        self.assertEqual([(e["at"] - begin, e["label"]) for e in history.detail("first")["events"]],
                         [(5, "Detaching mop mounts"), (10, "Installing mop mounts")])
        history._observations.close()
