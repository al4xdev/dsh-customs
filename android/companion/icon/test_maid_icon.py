"""Offline asset/source fixtures; no Gradle, Android connection, network or private screenshots."""
import hashlib
import sys
import shutil
import unittest
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
import generate_maid_icon as icon

ANDROID = "{http://schemas.android.com/apk/res/android}"


class MaidIconSourceTest(unittest.TestCase):
    def test_original_frame_and_entire_loading_pack_are_unchanged(self):
        self.assertEqual(icon.SOURCE_SHA256, hashlib.sha256(icon.SOURCE.read_bytes()).hexdigest())
        self.assertEqual((32, "79adf5586518472860e0f67eedd0f739da6c888eb5a2eb6c912d3678619391c6"), icon.loader_digest())

    def test_only_launcher_references_change_and_normal_round_share_art(self):
        root = ET.parse(icon.MAIN / "AndroidManifest.xml").getroot()
        application = root.find("application")
        self.assertIsNotNone(application)
        self.assertEqual("@mipmap/ic_companion_maid", application.attrib[ANDROID + "icon"])
        self.assertEqual(application.attrib[ANDROID + "icon"], application.attrib[ANDROID + "roundIcon"])
        self.assertEqual("Companion", application.attrib[ANDROID + "label"])
        self.assertEqual("false", application.attrib[ANDROID + "allowBackup"])
        self.assertEqual("false", application.attrib[ANDROID + "usesCleartextTraffic"])
        self.assertEqual("@style/Theme.Companion", application.attrib[ANDROID + "theme"])
        self.assertEqual(["android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS"],
                         [value.attrib[ANDROID + "name"] for value in root.findall("uses-permission")])
        activity = application.find("activity")
        self.assertEqual(".MainActivity", activity.attrib[ANDROID + "name"])
        self.assertEqual("true", activity.attrib[ANDROID + "exported"])
        self.assertEqual("adjustResize", activity.attrib[ANDROID + "windowSoftInputMode"])

    def test_adaptive_background_and_unfiltered_foreground_are_icon_specific(self):
        adaptive = ET.parse(icon.MAIN / "res/mipmap-anydpi/ic_companion_maid.xml").getroot()
        self.assertEqual("adaptive-icon", adaptive.tag)
        self.assertEqual("@color/maid_launcher_background", adaptive.find("background").attrib[ANDROID + "drawable"])
        self.assertEqual("@drawable/ic_companion_maid_foreground", adaptive.find("foreground").attrib[ANDROID + "drawable"])
        bitmap = ET.parse(icon.MAIN / "res/drawable/ic_companion_maid_foreground.xml").getroot()
        self.assertEqual("false", bitmap.attrib[ANDROID + "filter"])
        self.assertEqual("false", bitmap.attrib[ANDROID + "antialias"])
        color = ET.parse(icon.MAIN / "res/values/launcher_icon_colors.xml").getroot().find("color")
        self.assertEqual("maid_launcher_background", color.attrib["name"])
        self.assertEqual("#0E0E12", color.text)
        self.assertFalse((icon.MAIN / "res/mipmap-anydpi-v26").exists())
        self.assertFalse((icon.MAIN / "res/drawable/ic_companion.xml").exists())

    @unittest.skipUnless(shutil.which("magick"), "Requires an already-installed ImageMagick, never installs it")
    def test_committed_foreground_matches_recipe_and_both_safe_masks(self):
        magick = shutil.which("magick")
        png, _, radius, _ = icon.generate(magick)
        self.assertEqual(icon.OUTPUT.read_bytes(), png)
        self.assertEqual("57f67d45a9b4a7ca165c06ba809ab91a470ccda3d21682d897416ac1b54471c4", hashlib.sha256(png).hexdigest())
        self.assertLessEqual(radius, icon.PIXEL_CENTER_RADIUS)
        width, height, pixels = icon.rgba(magick, png)
        self.assertEqual((432, 432), (width, height))
        # A circle is the stricter bound; the centered fourth-power squircle cannot cut more art.
        for x, y, _ in icon.visible(pixels, width):
            dx = (x + .5 - width / 2) / icon.SAFE_RADIUS
            dy = (y + .5 - height / 2) / icon.SAFE_RADIUS
            self.assertLessEqual(dx * dx + dy * dy, 1)
            self.assertLessEqual(dx ** 4 + dy ** 4, 1)


if __name__ == "__main__":
    unittest.main()
