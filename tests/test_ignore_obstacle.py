import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from robot import DeviceController


class IgnoreObstacleTest(unittest.IsolatedAsyncioTestCase):
    async def test_sends_selected_map_object_position(self):
        command = SimpleNamespace(send=AsyncMock(return_value=["ok"]))
        controller = SimpleNamespace(
            _map=SimpleNamespace(things={"obstacles": [
                {"photo_id": "pedestal", "origin_x": 1234, "origin_y": 5678,
                 "type": 42, "ignored": False},
            ]}),
            _p=SimpleNamespace(status=SimpleNamespace(current_map=0), command=command),
        )

        self.assertEqual(await DeviceController.ignore_obstacle(controller, ["pedestal"]), {"ok": True})
        command.send.assert_awaited_once_with("set_ignore_identify_area", [[1, 0], [2, 1234, 5678, 42]])


if __name__ == "__main__":
    unittest.main()
