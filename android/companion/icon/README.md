# Companion Icon — Same Maid from Loading Animation

The launcher uses **a static frame from the exact artwork already bundled in the loading animation**. The loading view remains animated; none of its frames, timing, or code was altered. No image generation, network calls, repainting, blurring, or newly installed libraries were used for this conversion.

## Provenance and Integrity

- Original frame: `app/src/main/assets/companion/maid/thinking/00.png`, 301×288px, with alpha.
- Original SHA256: `c4132f28c128c06d86874f61e7ba7ae8b6d305708127879cbc36c6ed3e7e4319`.
- Artwork provided by owner for personal use in this app; not an official logo. No commercial license or repackaging rights are implied.
- All 32 original files in `assets/companion/maid` remain byte-identical. Sorted digest of path+SHA256: `79adf5586518472860e0f67eedd0f739da6c888eb5a2eb6c912d3678619391c6`.
- Derived foreground: `app/src/main/res/drawable-nodpi/ic_companion_maid_foreground_pixels.png`, 432×432px RGBA.
- Foreground SHA256: `57f67d45a9b4a7ca165c06ba809ab91a470ccda3d21682d897416ac1b54471c4`.

## Offline Recipe

Standard Python 3 + existing ImageMagick. From the repository root:

```fish
uv run --no-project --offline python android/companion/icon/generate_maid_icon.py
uv run --no-project --offline python android/companion/icon/generate_maid_icon.py --check
uv run --no-project --offline python android/companion/icon/test_maid_icon.py
```

The script rejects any differing source hash. It strips only fully transparent padding, resizes the alpha bounding box with a `point`/nearest-neighbor filter, and centers it on a transparent 432px canvas (108dp at 4px/dp). The alpha crop measures 202×197px. All visible pixels preserve existing RGBA values from the original; the script rejects new colors/alpha.

Maximum visible pixel center radius is 130.201767px, inside the 131px margin and 132px radius of the 66dp circular safe zone. The margin also keeps pixel corners within this zone. Neither circle nor squircle masks crop face, hair, ribbon, or tail. This validates the resource asset; it does not claim physical testing across every OEM launcher.

Encoding strips volatile metadata and uses PNG32 / compression level 9. `--check` mandates bit-for-bit equality with the recipe under the available ImageMagick; future encoder versions may require byte revalidation without altering the pixel/alpha contract.

## Android Resources

- `mipmap-anydpi/ic_companion_maid.xml`: Canonical adaptive icon; regular and `roundIcon` target it. App requires API 34; qualifier-v26 and legacy fallback are unnecessary.
- `drawable/ic_companion_maid_foreground.xml`: Bitmap without filter/antialias/dither; transparency is preserved.
- `values/launcher_icon_colors.xml`: Charcoal background exclusive to launcher icon, `#0E0E12`; does not alter app theme/palette.
- No reinterpretive monochrome: maid retains original frame colors and details.
- Legacy unreferenced `drawable/ic_companion.xml` and v26 duplicate were removed. Only a single foreground wrapper exists, with no dead resources or obsolete chat symbols.
- No changes to label, package name, permissions, activities, signing key, UID, keystore, or version. Parent integrates into APK9 alongside approved palette/copy adjustments.

## Verification

`test_maid_icon.py` verifies unchanged source pack, manifest, resources, reproducibility, and circular/squircle bounds. `MaidLauncherIconTest` is the Android fixture for PackageManager/adaptive drawable, background, filter, alpha-safe bounds, and original frame hash in APK; Gradle/emulator execution is handled by the parent workflow.

The derived PNG was visually verified as an actual image. No physical phone was connected, unlocked, captured, or operated during this task. Physical launcher validation requires new owner approval/safe conditions; it is not required to produce these resources.
