import unittest
from unittest.mock import AsyncMock

from history_rpc import map_diagnostics, send_history_command

_TIMEOUT = 10


class DummyChannel:
    def __init__(self, result):
        self.send_command = AsyncMock(return_value=result)


class HistoryRpcTest(unittest.IsolatedAsyncioTestCase):
    async def test_extended_timeout_is_restored(self):
        global _TIMEOUT
        channel = DummyChannel({"ok": True})
        result = await send_history_command(channel, "get_clean_record", [1], timeout=45)
        self.assertEqual(result, {"ok": True})
        self.assertEqual(_TIMEOUT, 10)
        channel.send_command.assert_awaited_once_with("get_clean_record", params=[1])

    def test_map_diagnostics_decodes_nonce_timestamps(self):
        timestamp = 1_795_256_547
        prefix = b"rr" + (20).to_bytes(2, "little") + bytes(16)
        block = (34).to_bytes(2, "little") + (8).to_bytes(2, "little") + (5).to_bytes(4, "little")
        raw = prefix + block + bytes([42]) + timestamp.to_bytes(4, "little")
        diagnostics = map_diagnostics(raw)
        self.assertTrue(diagnostics["available"])
        self.assertEqual(diagnostics["blocks"][0]["timestamp_entries"], [{"type": 42, "unix_time": timestamp}])

    def test_map_diagnostics_preserves_non_binary_response(self):
        self.assertEqual(map_diagnostics(None), {"available": False, "response": None})
