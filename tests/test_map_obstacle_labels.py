import unittest
from types import SimpleNamespace

from maprender import _restore_modern_photo_ids, _things, obstacle_kind


class MapObstacleLabelsTest(unittest.TestCase):
    def test_known_labels_ignore_case(self):
        self.assertEqual(obstacle_kind("Shoes"), ("shoes", "Shoes"))

    def test_unknown_marker_explains_missing_robot_data(self):
        expected = ("obstacle", "Unidentified obstacle")
        self.assertEqual(obstacle_kind(None), expected)
        self.assertEqual(obstacle_kind("?"), expected)

    def test_unknown_marker_preserves_robot_type_code(self):
        self.assertEqual(obstacle_kind(None, 62), ("obstacle", "Unidentified obstacle (Roborock type 62)"))

    def test_boolean_is_not_mistaken_for_robot_type_code(self):
        self.assertEqual(obstacle_kind(None, True), ("obstacle", "Unidentified obstacle"))

    def test_new_robot_description_is_preserved(self):
        self.assertEqual(obstacle_kind("floor_lamp"), ("obstacle", "Floor lamp"))

    def test_photo_copy_wins_when_obstacle_is_reported_twice(self):
        def obstacle(photo_name=None):
            return SimpleNamespace(
                details=SimpleNamespace(type=62, description="Shoes", photo_name=photo_name),
                to_img=lambda _dimensions: SimpleNamespace(x=10, y=20),
            )

        map_data = SimpleNamespace(
            image=SimpleNamespace(dimensions=object()),
            obstacles=[obstacle()],
            obstacles_with_photo=[obstacle("photo-123")],
            path=None,
            mop_path=None,
            no_carpet_areas=[],
            zones=[],
            goto=None,
            predicted_path=None,
        )

        result = _things(map_data)

        self.assertEqual(len(result["obstacles"]), 1)
        self.assertTrue(result["obstacles"][0]["photo"])
        self.assertEqual(result["obstacles"][0]["photo_id"], "photo-123")

    def test_saros_36_byte_obstacle_record_restores_photo_id(self):
        photo_id = b"002OP8DjMLKGBRnX"
        record = bytearray(36)
        record[0:2] = (1234).to_bytes(2, "little")
        record[2:4] = (5678).to_bytes(2, "little")
        record[4:6] = (2).to_bytes(2, "little")
        record[12:28] = photo_id

        map_header = bytearray(20)
        map_header[2:4] = (20).to_bytes(2, "little")
        block_header = bytearray(12)
        block_header[0:2] = (15).to_bytes(2, "little")
        block_header[2:4] = (12).to_bytes(2, "little")
        block_header[4:8] = len(record).to_bytes(4, "little")
        block_header[8:10] = (1).to_bytes(2, "little")

        obstacle = SimpleNamespace(
            x=1234,
            y=5678,
            details=SimpleNamespace(photo_name=None),
        )
        map_data = SimpleNamespace(
            obstacles_with_photo=[obstacle],
            ignored_obstacles_with_photo=[],
        )

        _restore_modern_photo_ids(bytes(map_header + block_header + record), map_data)

        self.assertEqual(obstacle.details.photo_name, photo_id.decode())


if __name__ == "__main__":
    unittest.main()
