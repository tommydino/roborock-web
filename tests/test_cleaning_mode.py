"""The clean-then-mop mode uses Roborock's separate sequence switch."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from robot import CLEAN_THEN_MOP_COMMAND, DeviceController


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


if __name__ == "__main__":
    unittest.main()
