"""Offline source invariants only: no Gradle, image generation, device, cofre or network."""
import hashlib
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "app/src/main"
KOTLIN = MAIN / "kotlin/dev/alex/dsh/companion"
ANDROID = "{http://schemas.android.com/apk/res/android}"


class CompanionStartupSourceTest(unittest.TestCase):
    def test_platform_splash_and_window_are_black_with_existing_maid(self):
        styles = ET.parse(MAIN / "res/values/styles.xml").getroot()
        theme = styles.find("style[@name='Theme.Companion']")
        items = {item.attrib["name"]: item.text for item in theme.findall("item")}
        for key in ("windowBackground", "windowSplashScreenBackground", "statusBarColor", "navigationBarColor"):
            self.assertEqual("@color/companion_startup_black", items["android:" + key])
        self.assertEqual("@mipmap/ic_companion_maid", items["android:windowSplashScreenAnimatedIcon"])
        for key in ("windowLightStatusBar", "windowLightNavigationBar", "enforceStatusBarContrast", "enforceNavigationBarContrast"):
            self.assertEqual("false", items["android:" + key])
        colors = ET.parse(MAIN / "res/values/startup_colors.xml").getroot()
        self.assertEqual("#000000", colors.find("color[@name='companion_startup_black']").text)
        self.assertNotIn("android:windowSplashScreenAnimationDuration", items)

    def test_manifest_and_launcher_background_remain_approved(self):
        application = ET.parse(MAIN / "AndroidManifest.xml").getroot().find("application")
        self.assertEqual("@style/Theme.Companion", application.attrib[ANDROID + "theme"])
        self.assertEqual("@mipmap/ic_companion_maid", application.attrib[ANDROID + "icon"])
        self.assertEqual("@mipmap/ic_companion_maid", application.attrib[ANDROID + "roundIcon"])
        colors = ET.parse(MAIN / "res/values/launcher_icon_colors.xml").getroot()
        self.assertEqual("#0E0E12", colors.find("color[@name='maid_launcher_background']").text)

    def test_all_32_loading_assets_and_icon_pixels_keep_the_approved_hashes(self):
        base = MAIN / "assets/companion/maid"
        paths = [base / "subsettimings.json"]
        for mood, count in (("thinking", 17), ("typing", 14)):
            paths.extend(base / mood / f"{index:02}.png" for index in range(count))
        digest = hashlib.sha256()
        for path in sorted(paths):
            digest.update(path.relative_to(base).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
        self.assertEqual(32, len(paths))
        self.assertEqual("79adf5586518472860e0f67eedd0f739da6c888eb5a2eb6c912d3678619391c6", digest.hexdigest())
        foreground = MAIN / "res/drawable-nodpi/ic_companion_maid_foreground_pixels.png"
        self.assertEqual("57f67d45a9b4a7ca165c06ba809ab91a470ccda3d21682d897416ac1b54471c4",
                         hashlib.sha256(foreground.read_bytes()).hexdigest())

    def test_root_selects_startup_before_constructing_the_existing_route(self):
        source = (KOTLIN / "MainActivity.kt").read_text()
        self.assertIn("Surface(Modifier.fillMaxSize(), color = Color.Black)", source)
        self.assertRegex(source, r"if \(state.initializing\)\s*\{\s*CompanionStartupScreen\(\)\s*}\s*else\s*\{\s*CompanionScreen\(state, controller(?:\)|,)")
        self.assertNotIn("setKeepOnScreenCondition", source)

    def test_flag_defaults_false_and_only_initial_viewmodel_creation_sets_true(self):
        contract = (KOTLIN / "ui/UiContract.kt").read_text()
        source = (KOTLIN / "CompanionViewModel.kt").read_text()
        self.assertIn("val initializing: Boolean = false", contract)
        self.assertEqual(1, source.count("initializing = true"))
        self.assertIn("MutableStateFlow(CompanionUiState(initializing = true))", source)
        self.assertIn("init { restoreLogin(initial = true) }", source)
        self.assertIn("override fun restoreLogin() = restoreLogin(initial = false)", source)

    def test_restore_release_is_in_finally_fenced_by_initial_and_current_generation(self):
        source = (KOTLIN / "CompanionViewModel.kt").read_text()
        restore = source.split("private fun restoreLogin(initial: Boolean)", 1)[1].split("override fun logout()", 1)[0]
        self.assertIn("restoringStartup(initial, { epoch == generation }", restore)
        self.assertIn("it.copy(initializing = false)", restore)
        self.assertIn("if (error is CancellationException) throw error", restore)
        self.assertEqual(1, restore.count("transport.restoreLogin()"))
        self.assertEqual(1, restore.count('unary("companion/listChats"'))
        self.assertEqual(1, restore.count("refresh()"))
        self.assertRegex(source, r"finally\s*\{\s*if \(initial && current\(\)\) finish\(\)")

    def test_stateless_screen_reuses_original_loader_and_handles_short_windows(self):
        source = (KOTLIN / "ui/loading/CompanionStartupScreen.kt").read_text()
        for fragment in ("background(Color.Black)", "safeDrawingPadding()", "verticalScroll(rememberScrollState())",
                         "widthIn(max = 320.dp)", "MaterialTheme.typography.bodyMedium", "LiveRegionMode.Polite",
                         '"Verificando login salvo…"', 'MaidLoader(modifier = Modifier.testTag("startup-maid"), reduceMotion = reduceMotion)'):
            self.assertIn(fragment, source)
        for forbidden in ("LaunchedEffect", "delay(", "OwnerTransport", "CompanionViewModel", "BitmapFactory", "Image("):
            self.assertNotIn(forbidden, source)

    def test_existing_rpc_has_total_deadline_and_no_bootstrap_network_was_added(self):
        policy = (KOTLIN / "net/OwnerHttpPolicy.kt").read_text()
        transport = (KOTLIN / "net/OwnerTransport.kt").read_text()
        self.assertIn("UNARY_TIMEOUT_MILLIS = 45_000L", policy)
        self.assertIn("it.timeout().timeout(timeoutMillis, TimeUnit.MILLISECONDS)", policy)
        self.assertIn("return executeRpc(method, envelope, MAX_RESPONSE_BYTES)", transport)
        self.assertIn("maximumCallMillis: Long? = null", transport)
        self.assertIn('executeRpc("goalPush/unregister", envelope, 64L * 1024, 2500)', transport)
        self.assertRegex(transport, r"OwnerHttpPolicy\.unaryCall\(client, request\)\.also \{ call ->\s*maximumCallMillis\?\.let \{ call\.timeout\(\)\.timeout\(it, java\.util\.concurrent\.TimeUnit\.MILLISECONDS\) }\s*}\.execute\(\)")
        self.assertIn("fun restoreLogin(): Boolean = cookies.restore()", transport)

    def test_owned_source_and_test_files_have_no_trailing_whitespace(self):
        files = [KOTLIN / relative for relative in (
            "MainActivity.kt", "CompanionViewModel.kt", "ui/UiContract.kt", "ui/loading/CompanionStartupScreen.kt",
        )]
        files.extend(MAIN / "res/values" / name for name in ("styles.xml", "startup_colors.xml"))
        files.extend([
            ROOT / "app/src/test/kotlin/dev/alex/dsh/companion/CompanionStartupRestoreTest.kt",
            ROOT / "app/src/androidTest/kotlin/dev/alex/dsh/companion/ui/loading/CompanionStartupScreenTest.kt",
            ROOT / "app/src/androidTest/kotlin/dev/alex/dsh/companion/ui/loading/CompanionStartupThemeTest.kt",
            Path(__file__).resolve(),
        ])
        for path in files:
            for index, line in enumerate(path.read_text().splitlines(), 1):
                self.assertEqual(line.rstrip(), line, f"{path}:{index}")


if __name__ == "__main__":
    unittest.main()
