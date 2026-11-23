import unittest
from types import SimpleNamespace

from maprender import _things, obstacle_kind


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


if __name__ == "__main__":
    unittest.main()
