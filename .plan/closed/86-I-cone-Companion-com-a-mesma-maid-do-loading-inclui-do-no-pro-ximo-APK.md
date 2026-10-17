# Loading maid as app icon

## Request and observed origin
The owner requested 'change the app icon, use the maid from the loading gif' and told to proceed without the phone, notifying when needed. Android loading uses its own PNGs already bundled in assets/companion/maid/{thinking,typing}; original image thinking/00.png was inspected, 301x288px, recognizable alpha/pixel art, SHA256 c4132f28c128c06d86874f61e7ba7ae8b6d305708127879cbc36c6ed3e7e4319. It is artwork provided by the owner for personal use, not an official logo. Current icon is vector drawable/ic_companion.xml; manifest points android:icon to it.

## Minimal implementation
1. Reuse a static frame of the SAME maid already loaded (preference thinking/00.png), without generating another character, network/image-generation, modifying loader, character colors, timings, or original files. Derive launcher PNG resources with preserved alpha/pixel art, using already available tools and documented offline transformation; no new runtime dependency.
2. Create adaptive icon with discreet graphite background aligned with palette 85 and centered maid foreground / safe padding for circle/squircle masks. Do not clip face/ribbon; nearest-neighbor scaling for pixel art. If including monochrome, derive from the silhouette itself and ensure it does not revert to the old symbol. Android icon is static; loading animation remains as is.
3. Point icon and roundIcon in Manifest to the appropriate resource. Retain applicationId/label/permissions/activities/UID/vault/preset/signature. Do not touch layout, typography, motion, toolbar, or loading. Eliminate launcher reference to the old symbol, without deleting files outside scope.
4. Document source frame / origin and transformation / attribution. Parent coordinates version 9 together with task 85 (not another conflicting version), centralized Gradle/ADB.

## Validation
Verify resources/manifest in strict build/lint, PackageManager / adaptive drawable tests and safe bounds / circle + rounded square only with synthetic images of the artwork itself. Inspect final image via read_image; icon rendering on own emulator 5039/5580 if necessary, without private account/data. Prove original loader unchanged / hash. Same signature as APK8; do not claim physical installation/result.

## Delivery and limits
Include in upcoming APK9 prepared with palette/copy 85. Do NOT install/open/operate phone now; notify owner and obtain new safe condition prior to upgrade. No restart/activation of backend/profile/tools 82/83/model, real session/project/grant/prompt/delete, SDK/TUI/HA/network/OAuth/global, commit/push/publication. Do not create backup/thumbnails of private screenshots. Approved plan and current goal guide execution.
