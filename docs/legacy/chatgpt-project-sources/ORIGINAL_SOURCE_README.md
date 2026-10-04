# Fire Allowance Tracker — ChatGPT Project Source (app-specific)

Status: Placeholder
Local Path: `C:\Users\Admin\Apps\fire-allowance-tracker\`
Last Updated: 2026-05-26

## Purpose

App-specific governance, architecture, and operational notes for the Fire Allowance
Tracker. Files placed here are scoped to this one TARGET APP and are NOT part of the
shared ChatGPT Project Source set (`CORE_RULES.md § 7.3`).

The shared modules are edited in [`canonical-shared-governance/`](../../canonical-shared-governance/)
and uploaded from the generated bundle
[`chatgpt-upload-bundles/governance-system/`](../../chatgpt-upload-bundles/governance-system/)
(`CORE_RULES.md § 15.1`). The `../shared/` sibling folder this file used to point at
no longer exists.

This folder itself is app-specific content sitting in the shared repository, which
Scope × Purpose routes to the owning app's own repository (`CORE_RULES.md § 12`). The
compliance audit reports it as a standing WARN; relocating it is its own Linear Issue,
not something to do incidentally.

Use this folder for:

- Architecture notes (e.g. `ALLOWANCE_ARCHITECTURE.md`).
- Per-app overrides of master defaults (cross-referenced from the app's
  `docs/LOCAL_RULES.md`).
- Notable app-specific decisions, landmines, and conventions.

## Conventions

- Versioned doc filenames use the `_vMAJOR.MINOR.PATCH` suffix (same
  convention as shared files — `CORE_RULES.md § 7.1`).
- Unversioned working drafts (like this `README.md`) are fine.
- Reference shared governance with the bare logical identifier only — no path, no
  scope prefix, no version suffix (e.g. `CORE_RULES.md § 6`, never
  `CORE_RULES.md § 6`). `CORE_RULES.md § 7.6.2`.

## Special Note

The Fire Allowance Tracker auth pattern is currently called out in the repo-level
`apps/fire-allowance-tracker/README.md` — see that file for the latest auth status.
