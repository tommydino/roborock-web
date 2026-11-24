import gzip
import unittest

from robot import parse_obstacle_photo_response

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
    def test_metadata_after_image(self):
        payload = block(3, IMAGE) + block(4, header=detection_header())
        photo, box = parse_obstacle_photo_response(payload)
        self.assertEqual(photo, IMAGE)
        self.assertEqual(box, {"imageWidth": 640, "imageHeight": 480,
                               "x": 100, "y": 120, "w": 120, "h": 180})

    def test_metadata_before_image(self):
        payload = block(4, header=detection_header()) + block(3, IMAGE)
        self.assertEqual(parse_obstacle_photo_response(gzip.compress(payload))[1]["x"], 100)

    def test_plain_image_has_no_invented_box(self):
        self.assertEqual(parse_obstacle_photo_response(IMAGE), (IMAGE, None))


if __name__ == "__main__":
    unittest.main()
