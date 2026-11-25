import asyncio
import unittest

from demo import DemoController


class DemoParityTest(unittest.TestCase):
    def test_demo_photos_timeline_and_ignore_are_simulated(self):
        async def check():
            demo = DemoController()
            status = await demo.status()
            self.assertIn("Saros 20 Sonic", status["name"])
            self.assertIn("vac_then_mop", status["mode"]["cleaning_options"])

            before = await demo.map()
            photos = [o["photo_id"] for o in before["obstacles"] if o["photo_id"]]
            self.assertIn("demo-cable", photos)
            self.assertIn("demo-cable-2", photos)
            content, media_type, box = await demo.obstacle_photo("demo-cable")
            self.assertEqual(media_type, "image/svg+xml")
            self.assertIn(b"DEMO IMAGE", content)
            self.assertEqual(box["imageWidth"], 800)

            run = await demo.run_detail((await demo.runs())[0]["id"])
            self.assertGreater(len(run["device_timeline"]), 3)
            self.assertIsNotNone(run["route"])

            await demo.action("set_cleaning_mode", {"mode": "vac_then_mop"})
            self.assertEqual((await demo.status())["mode"]["cleaning"], "vac_then_mop")
            await demo.ignore_obstacle(["demo-cable", "demo-cable-2"])
            after = await demo.map(since=before["version"])
            self.assertFalse(after.get("unchanged"))
            self.assertNotIn("demo-cable", [o["photo_id"] for o in after["obstacles"]])

        asyncio.run(check())
