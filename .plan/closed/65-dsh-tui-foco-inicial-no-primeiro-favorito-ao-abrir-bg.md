# Initial focus of /bg on Favorites

Request: keep Favorites as default tab and start the cursor on the first favorite session, not on the projects column.

- Preserve all existing fork changes and do not commit/push without a new request.
- Adjust only initial state/focus of sessions screen: sessions column when entering with `initialView=favorites`, first favorite once catalog/cache is available; do not seize focus after user navigation. Without favorites, maintain usable fallback; `/home` and other backends preserved.
- Add regression tests to existing headless script for opening, Enter on correct favorite, and favorites loaded asynchronously / without favorites; brief EN/ZH documentation if necessary.
- Compile and run focused/boundary regression tests without login, providers, or inference. Do not manually edit generated lib; do not restart existing TUIs.
- Goal tracks execution until validation and instructions for user to reopen `/bg` in a new execution.
