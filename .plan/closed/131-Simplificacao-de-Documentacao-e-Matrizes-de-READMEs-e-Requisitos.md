# Plan 131 — Documentation Simplification, README Directory, and Plugin Matrix

## Objective
Improve the repository documentation for public open-source release by adding a welcoming high-level introduction to the root `README.md`, clarifying historical/internal scope notes in `tools/` READMEs, and providing comprehensive matrices for plugin requirements in `plugins/README.md` and documentation paths in `README.md`.

---

## 1. Executive Introduction in Root `README.md`
- Add a clear, welcoming summary at the top of `README.md` introducing the repository as a modular monorepo/lab with three core pillars:
  1. Modular DSH plugins and extensions (`plugins/`).
  2. Native Android Companion application built with Jetpack Compose (`android/companion/`).
  3. Bootstrap tooling, offline prompt audits, and container recipes (`tools/`).
- Preserve existing deep technical specifications intact.

---

## 2. Internal/Historical Context Notes in `tools/`
- Add scope clarification notes at the top of maintenance/historical docs:
  - `tools/workshop/README.md`
  - `tools/installation-consolidation/README.md`
  - `tools/pi-ai-fork/README.md`
  - `tools/task10-profile/README.md`
- State clearly that they document developer machine maintenance and are not required for using plugins or applications.

---

## 3. Plugin Requirement and Coupling Matrix (`plugins/README.md`)
Create a comprehensive matrix categorizing:
- **Standalone:** Independent plugins running on any standard DSH install (`trash`, `list`, `apply-patch`, `grammar-fix`, `codex-transient-close`, `workspace-context`, `managed-plans`, `llm-resilience`, `agent-self-heal`).
- **External Dependencies:** Plugins requiring external binaries or services (`browser`, `music`, `research`).
- **Companion Ecosystem:** Plugins bound to the Android app and mobile transport (`companion-api`, `companion-transport`, `companion-download`, `companion-workspace`, `session`, `session-create`).

---

## 4. Documentation Directory Map
Compile a table mapping primary tracked README files across the repository, their topic scope, and target audience.
