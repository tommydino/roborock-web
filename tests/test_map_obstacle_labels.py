import unittest

from maprender import obstacle_kind


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


if __name__ == "__main__":
    unittest.main()
