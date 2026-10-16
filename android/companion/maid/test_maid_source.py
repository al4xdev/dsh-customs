"""Offline asset/source checks only; no Gradle, decoder runtime, device, model or network."""
import hashlib
import json
from pathlib import Path
import re
import struct
import unittest


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
MAIN = ROOT / "app/src/main"
ASSETS = MAIN / "assets/companion/maid"
PLAYLIST = MAIN / "assets/companion/maid_playlist"
ORIGINAL = REPO / "frontend/dsh-tui/assets/whaleGirl/img"
LOADING = MAIN / "kotlin/dev/alex/dsh/companion/ui/loading"
EXPECTED = {
    "idle": 21, "idle-look": 13, "idle-spout": 11, "thinking": 17, "typing": 14,
    "music": 8, "conducting": 12, "building": 24, "error": 10, "happy": 11,
    "notification": 8, "compacting": 10, "carrying": 8, "sleeping": 6, "waking": 11,
    "poke-left": 11, "poke-right": 11, "tickle": 14, "drag": 10, "swim": 8,
    "smile-hearts": 16, "thumbs-up": 13,
}


def digest(paths):
    value = hashlib.sha256()
    for path in sorted(paths):
        value.update(path.relative_to(ASSETS).as_posix().encode() + b"\0")
        value.update(hashlib.sha256(path.read_bytes()).digest())
    return value.hexdigest()


class MaidSourceTest(unittest.TestCase):
    def test_full_manifest_matches_all_original_animations_and_exact_delays(self):
        self.assertEqual((ORIGINAL / "timings.json").read_bytes(), (PLAYLIST / "timings.json").read_bytes())
        manifest = json.loads((PLAYLIST / "timings.json").read_text())
        self.assertEqual(EXPECTED, {key: len(rows) for key, rows in manifest.items()})
        self.assertEqual(22, len(manifest))
        self.assertEqual(267, sum(map(len, manifest.values())))
        self.assertLessEqual((PLAYLIST / "timings.json").stat().st_size, 8 * 1024)
        for rows in manifest.values():
            for index, row in enumerate(rows):
                self.assertEqual({"dur", "file"}, set(row))
                self.assertEqual(f"{index:02}.png", row["file"])
                self.assertIs(type(row["dur"]), int)
                self.assertGreaterEqual(row["dur"], 60)
                self.assertLessEqual(row["dur"], 10_000)

    def test_all_267_pngs_are_original_bytes_without_processing_or_new_art(self):
        expected = {PLAYLIST / "timings.json", ASSETS / "subsettimings.json"}
        for directory, count in EXPECTED.items():
            for index in range(count):
                root = ASSETS if directory in ("thinking", "typing") else PLAYLIST
                path = root / directory / f"{index:02}.png"
                expected.add(path)
                data = path.read_bytes()
                self.assertEqual((ORIGINAL / directory / path.name).read_bytes(), data)
                self.assertLessEqual(len(data), 128 * 1024)
                self.assertEqual(b"\x89PNG\r\n\x1a\n", data[:8])
                self.assertEqual((301, 288), struct.unpack(">II", data[16:24]))
        self.assertEqual(269, len(expected))
        legacy = {path for path in ASSETS.rglob("*") if path.is_file()}
        additional = {path for path in PLAYLIST.rglob("*") if path.is_file()}
        self.assertEqual(32, len(legacy))
        self.assertEqual(237, len(additional))
        self.assertEqual(expected, legacy | additional)

    def test_original_32_file_digest_and_accepted_icon_are_not_rebased(self):
        legacy = [ASSETS / "subsettimings.json"]
        for directory, count in (("thinking", 17), ("typing", 14)):
            legacy.extend(ASSETS / directory / f"{index:02}.png" for index in range(count))
        self.assertEqual(32, len(legacy))
        self.assertEqual("79adf5586518472860e0f67eedd0f739da6c888eb5a2eb6c912d3678619391c6", digest(legacy))
        self.assertEqual("c4132f28c128c06d86874f61e7ba7ae8b6d305708127879cbc36c6ed3e7e4319",
                         hashlib.sha256((ASSETS / "thinking/00.png").read_bytes()).hexdigest())
        self.assertEqual("57f67d45a9b4a7ca165c06ba809ab91a470ccda3d21682d897416ac1b54471c4",
                         hashlib.sha256((MAIN / "res/drawable-nodpi/ic_companion_maid_foreground_pixels.png").read_bytes()).hexdigest())

    def test_emote_catalog_is_complete_and_not_an_error_success_state_machine(self):
        source = (LOADING / "MaidAnimation.kt").read_text()
        declared = dict((directory, int(count)) for directory, count in
                        re.findall(r'\b\w+\("([a-z-]+)", (\d+)\)', source))
        self.assertEqual(EXPECTED, declared)
        self.assertIn('Frown("error", 10)', source)
        self.assertIn('Cheer("happy", 11)', source)
        loader = (LOADING / "MaidLoader.kt").read_text()
        self.assertIn("mood: MaidMood = MaidMood.Decorative", loader)
        self.assertIn("contentDescription = null", loader)
        for forbidden in ("LiveRegionMode", "stateDescription", "ResponsePhase", "UiContract", "success", "error("):
            self.assertNotIn(forbidden, loader.replace("error/success/receipt signals", "expressions"))

    def test_catalog_does_not_decode_and_frames_are_serial_off_main_with_bounded_lru(self):
        source = (LOADING / "MaidLoader.kt").read_text()
        catalog = source.split("suspend fun loadCatalog", 1)[1].split("suspend fun loadFrame", 1)[0]
        self.assertNotIn("BitmapFactory", catalog)
        self.assertNotIn(".png", catalog)
        self.assertEqual(2, source.count("= withContext(Dispatchers.IO)"))
        self.assertIn("mutex.withLock", source)
        self.assertIn("cached.size >= MaidAssetLimits.MAX_CACHED_FRAMES", source)
        self.assertIn("decodedBytes + MaidAssetLimits.MAX_FRAME_DECODED_BYTES", source)
        self.assertIn("iterator.remove()", source)
        for forbidden in (".recycle()", "Timer(", "Thread(", "GlobalScope", "async {", "launch {"):
            self.assertNotIn(forbidden, source)

    def test_motion_gate_is_before_clock_and_disabled_art_uses_original_poster(self):
        loader = (LOADING / "MaidLoader.kt").read_text()
        clock = loader.split("LaunchedEffect(context, mood, canTick)", 1)[1].split("// Choose the accepted poster", 1)[0]
        self.assertRegex(clock, r"if \(canTick\)\s*\{")
        self.assertIn("tickMaidCycles(", clock)
        self.assertIn("val displayed = if (canTick) rendered else null", loader)
        helper = (LOADING / "MaidAnimation.kt").read_text()
        self.assertIn("active && resumed && visible && !reduceMotion && motionScale > 0f", helper)
        self.assertIn("MaidMood.Thinking, MaidMood.Decorative -> MaidEmote.Thinking", helper)
        self.assertIn("if (elapsed >= animation.totalMillis) break", helper)
        self.assertIn("delay(animation.millisUntilNextFrame(afterDecode))", helper)

    def test_owned_sources_have_no_trailing_whitespace(self):
        files = [LOADING / "MaidAnimation.kt", LOADING / "MaidLoader.kt", Path(__file__).resolve()]
        for kind, name in (("test", "MaidAnimationTest.kt"), ("androidTest", "MaidLoaderTest.kt")):
            files.append(ROOT / f"app/src/{kind}/kotlin/dev/alex/dsh/companion/ui/loading" / name)
        for path in files:
            for index, line in enumerate(path.read_text().splitlines(), 1):
                self.assertEqual(line.rstrip(), line, f"{path}:{index}")


if __name__ == "__main__":
    unittest.main()
