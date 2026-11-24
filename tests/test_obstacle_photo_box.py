import gzip
import unittest

from robot import parse_obstacle_photo_response, photo_dimensions, photo_matches_box

IMAGE = b"\xff\xd8\xff\xd9"


def block(kind, payload=b"", header=b""):
    size = 8 + len(header)
    return (kind.to_bytes(2, "little") + size.to_bytes(2, "little")
            + len(payload).to_bytes(4, "little") + header + payload)


def detection_header():
    header = bytearray(28)
    header[8:10] = (640).to_bytes(2, "little")
    header[10:12] = (480).to_bytes(2, "little")
    header[20:22] = (100).to_bytes(2, "little")
    header[22:24] = (120).to_bytes(2, "little")
    header[24:26] = (220).to_bytes(2, "little")
    header[26:28] = (300).to_bytes(2, "little")
    return bytes(header[8:])


class ObstaclePhotoBoxTest(unittest.TestCase):
    def test_cropped_variant_does_not_match_full_frame_box(self):
        def jpeg(width, height):
            return (b"\xff\xd8\xff\xc0\x00\x0b\x08"
                    + height.to_bytes(2, "big") + width.to_bytes(2, "big")
                    + b"\x01\x01\x11\x00\xff\xd9")

        box = {"imageWidth": 640, "imageHeight": 480, "x": 23, "y": 222, "w": 260, "h": 91}
        self.assertEqual(photo_dimensions(jpeg(320, 320)), (320, 320))
        self.assertFalse(photo_matches_box(jpeg(320, 320), box))
        self.assertTrue(photo_matches_box(jpeg(640, 480), box))

    def test_metadata_after_image(self):
        payload = block(3, IMAGE) + block(4, header=detection_header())
        photo, box = parse_obstacle_photo_response(payload)
        self.assertEqual(photo, IMAGE)
        self.assertEqual(box, {"imageWidth": 640, "imageHeight": 480,
                               "x": 100, "y": 120, "w": 120, "h": 180})

    def test_metadata_before_image(self):
        payload = block(4, header=detection_header()) + block(3, IMAGE)
        self.assertEqual(parse_obstacle_photo_response(gzip.compress(payload))[1]["x"], 100)

    def test_saros_photo_uses_dimension_and_rectangle_payload_blocks(self):
        # Observed on a Saros 20 Sonic: 640x480 with corners (23,222)-(283,313).
        payload = (block(1, bytes.fromhex("8002e001"))
                   + block(2, bytes.fromhex("1700de001b013901"))
                   + block(3, IMAGE)
                   + block(4, bytes.fromhex("ebb05c01")))
        self.assertEqual(
            parse_obstacle_photo_response(payload),
            (IMAGE, {"imageWidth": 640, "imageHeight": 480,
                     "x": 23, "y": 222, "w": 260, "h": 91}),
        )

    def test_plain_image_has_no_invented_box(self):
        self.assertEqual(parse_obstacle_photo_response(IMAGE), (IMAGE, None))


if __name__ == "__main__":
    unittest.main()
