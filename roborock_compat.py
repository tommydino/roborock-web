"""Small compatibility fixes for Roborock protocol variants used by this app."""

from __future__ import annotations

from collections.abc import Callable

from roborock.devices.rpc import v1_channel
from roborock.exceptions import RoborockException
from roborock.protocol import Utils
from roborock.protocols import v1_protocol
from roborock.protocols.v1_protocol import BlobResponse
from roborock.roborock_message import RoborockMessage

_MAP_RESPONSE_PART = 300
_MAP_RESPONSE = 301
_MAX_PENDING = 4


def create_multipart_blob_decoder() -> Callable[[RoborockMessage], BlobResponse | None]:
    """Decode both single-frame thumbnails and multi-frame full obstacle photos."""
    pending: dict[tuple[int, int], dict[int, tuple[bool, bytes]]] = {}

    def decode_payload(payload: bytes) -> BlobResponse | None:
        if not payload.startswith(b"ROBOROCK") or len(payload) < 24:
            return None
        request_id = int.from_bytes(payload[8:12], "little")
        header_size = int.from_bytes(payload[16:18], "little")
        payload_size = int.from_bytes(payload[20:24], "little")
        end_offset = header_size + payload_size
        if header_size < 24 or end_offset > len(payload):
            raise RoborockException("Invalid V1 blob response format")
        return BlobResponse(request_id=request_id, data=Utils.decompress(payload[header_size:end_offset]))

    def remember(key: tuple[int, int], parts: dict[int, tuple[bool, bytes]]) -> None:
        pending[key] = parts
        while len(pending) > _MAX_PENDING:
            del pending[next(iter(pending))]

    def add_part(key: tuple[int, int], message: RoborockMessage, is_last: bool) -> BlobResponse | None:
        parts = pending.pop(key, {})
        parts[message.seq] = (is_last, message.payload or b"")
        seqs = sorted(parts)
        complete = (
            parts[seqs[-1]][0]
            and seqs == list(range(seqs[0], seqs[-1] + 1))
            and parts[seqs[0]][1].startswith(b"ROBOROCK")
        )
        if not complete:
            remember(key, parts)
            return None
        return decode_payload(b"".join(parts[seq][1] for seq in seqs))

    def decode(message: RoborockMessage) -> BlobResponse | None:
        protocol = int(message.protocol)
        if protocol not in (_MAP_RESPONSE_PART, _MAP_RESPONSE) or not message.payload:
            return None
        key = (message.random, message.timestamp)
        is_last = protocol == _MAP_RESPONSE
        if protocol == _MAP_RESPONSE_PART or key in pending or not message.payload.startswith(b"ROBOROCK"):
            return add_part(key, message, is_last)
        return decode_payload(message.payload)

    return decode


def install_multipart_blob_decoder() -> None:
    """Install before the device manager creates its obstacle-photo RPC channel."""
    v1_protocol.create_blob_response_decoder = create_multipart_blob_decoder
    v1_channel.create_blob_response_decoder = create_multipart_blob_decoder
