import gzip
import unittest

from roborock.roborock_message import RoborockMessage

from roborock_compat import create_multipart_blob_decoder


class MultipartBlobDecoderTest(unittest.TestCase):
    def test_reassembles_full_photo_delivered_in_two_frames(self):
        request_id = 20008
        image_payload = b"full-photo-payload"
        compressed = gzip.compress(image_payload)
        header_size = 56
        payload = bytearray(header_size + len(compressed))
        payload[:8] = b"ROBOROCK"
        payload[8:12] = request_id.to_bytes(4, "little")
        payload[16:18] = header_size.to_bytes(2, "little")
        payload[20:24] = len(compressed).to_bytes(4, "little")
        payload[header_size:] = compressed
        split = 64

        decoder = create_multipart_blob_decoder()
        first = RoborockMessage(protocol=300, payload=bytes(payload[:split]), seq=1, random=7, timestamp=9)
        last = RoborockMessage(protocol=301, payload=bytes(payload[split:]), seq=2, random=7, timestamp=9)

        self.assertIsNone(decoder(first))
        result = decoder(last)

        self.assertIsNotNone(result)
        self.assertEqual(result.request_id, request_id)
        self.assertEqual(result.data, image_payload)

    def test_still_decodes_single_frame_thumbnail(self):
        request_id = 42
        image_payload = b"thumbnail"
        compressed = gzip.compress(image_payload)
        header_size = 24
        payload = bytearray(header_size + len(compressed))
        payload[:8] = b"ROBOROCK"
        payload[8:12] = request_id.to_bytes(4, "little")
        payload[16:18] = header_size.to_bytes(2, "little")
        payload[20:24] = len(compressed).to_bytes(4, "little")
        payload[header_size:] = compressed

        result = create_multipart_blob_decoder()(
            RoborockMessage(protocol=301, payload=bytes(payload), seq=1, random=1, timestamp=2)
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.data, image_payload)


if __name__ == "__main__":
    unittest.main()
