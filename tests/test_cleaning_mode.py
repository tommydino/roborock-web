"""The clean-then-mop mode uses Roborock's separate sequence switch."""

import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from robot import CLEAN_THEN_MOP_COMMAND, DeviceController  # noqa: E402


class CleaningModeTest(unittest.IsolatedAsyncioTestCase):
    def controller(self):
        status = SimpleNamespace(
            repeat=1,
            set_cleaning_mode=AsyncMock(),
            rpc_channel=SimpleNamespace(send_command=AsyncMock()),
        )
        controller = DeviceController.__new__(DeviceController)
        controller._p = SimpleNamespace(
            status=status,
            device_features=SimpleNamespace(
                is_clean_then_mop_mode_supported=True,
                is_ctm_with_repeat_supported=True,
            ),
        )
        controller._repeat = None
        controller._room_status = {}
        return controller, status

    async def test_clean_then_mop_sets_base_mode_and_sequence_flag(self):
        controller, status = self.controller()
        with patch("robot.get_cleaning_mode_parameters", return_value=[{
            "fan_power": 102, "water_box_mode": 235, "mop_mode": 300,
        }]):
            await controller._set_cleaning_mode("vac_then_mop")

        status.set_cleaning_mode.assert_awaited_once()
        status.rpc_channel.send_command.assert_awaited_once_with(CLEAN_THEN_MOP_COMMAND, params=[{
            "fan_power": 102, "water_box_mode": 235, "mop_mode": 300, "type": 1, "repeat": 1,
        }])
        self.assertEqual(controller._room_status["sequence"], 1)

    async def test_ordinary_mode_disables_sequence_flag(self):
        controller, status = self.controller()
        with patch("robot.get_cleaning_mode_parameters", return_value=[{
            "fan_power": 102, "water_box_mode": 200, "mop_mode": 300,
        }]):
            await controller._set_cleaning_mode("vacuum")

        status.set_cleaning_mode.assert_awaited_once_with("vacuum")
        self.assertEqual(status.rpc_channel.send_command.await_args.kwargs["params"][0]["type"], 0)
        self.assertEqual(controller._room_status["sequence"], 0)

    async def test_forced_status_refresh_does_not_return_cached_mode(self):
        controller, status = self.controller()
        status.state = object()
        status.converter = SimpleNamespace(convert=lambda raw: object())
        status.rpc_channel.send_command.return_value = [{"seq_type": 1}]
        controller._status_at = time.monotonic()  # cache is still inside the ordinary TTL
        controller._status_failed_at = 0.0
        controller._status_lock = asyncio.Lock()
        controller._status_error = None
        controller._status_message = ""

        with patch("robot.merge_trait_values"), patch.object(
            controller, "_status_payload", return_value={"mode": "fresh"}
        ):
            result = await controller.status(force=True)

        status.rpc_channel.send_command.assert_awaited_once()
        self.assertEqual(controller._room_status["sequence"], 1)
        self.assertEqual(result, {"mode": "fresh"})


if __name__ == "__main__":
    unittest.main()
