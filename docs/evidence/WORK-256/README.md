# WORK-256 evidence — FAT Neon N2 on DEV

Target: Neon project `cool-meadow-70196410` (`aws-ap-southeast-2`), branch **`dev`**
`br-wispy-dew-a7vd4v6k`. Branch `main` `br-red-credit-a77927m4` untouched. Supabase untouched.
Synthetic users only (`@example.invalid`). Design: [`NEON_APP_RUNTIME.md`](../../architecture/NEON_APP_RUNTIME.md).

## Backend mutations (`preflight/`)

Every Neon mutation was preflighted with `governance-v2/scripts/backend-preflight.js` and
verified after it was applied.

| Request | Operation | Preflight | Verify-applied |
|---|---|---|---|
| `r1-roles` | `schema-migration` `20261006090000_fat_neon_app_server_roles` | allow | verified |
| `r2-role-credentials` | `auth-config` `fat-dev-app-server-credentials-20261006` (role passwords; functional login proof) | allow | verified |
| `r3-neon-auth` | `auth-config` `fat-dev-neon-auth-20261006` (Neon Auth on `dev`) | allow | verified |

Negative checks:

| Request | Expected | Result |
|---|---|---|
| `neg-main` (same change against `main`) | refuse | refused: dev not verified, no rollback, no Production clearance |
| `neg-wrong-project` | refuse | refused |
| `neg-wrong-target-id` | refuse | refused |
| `neg-no-change` | refuse | refused |
| `neg-mismatched-change` (verify-applied) | unverified | unverified |

No credential value appears in any request or result file.

## Proofs (`proofs/`)

- **`rls-proof.json`** — 20/20, run with `scripts/neon-dev-rls-proof.mjs` against the app's
  own data-layer functions. It proves:
  - an unset identity sees 0 rows in all 10 owner-scoped tables;
  - A sees only A's rows and B only B's, and both hold claims, so the check is not vacuous;
  - A cannot update, delete, read, insert or advance B's sequence (0 rows, or 42501);
  - `fat_app` cannot read `identity_links`, provision or resolve an identity, and sees only its
    own identity;
  - neither login role reads anything without `SET ROLE`, neither can switch to the other role,
    and both are NOBYPASSRLS and not superuser.
- **`e2e-report.json`** — 87/87, run with `scripts/neon-dev-e2e.mjs` over HTTP against a local
  `next start` build with `FAT_BACKEND=neon`. It covers:
  - auth (12): sign-up, sign-in, sign-out, wrong password, session persistence, an invalid
    session, and a reserved-domain-only provisioning refusal;
  - identity (5), including a concurrent first-request burst;
  - FY, profile, rates and stations;
  - claims (24) for all six canonical types, with rule values checked (RC overtime 5.5 h, travel
    0.75 h, mileage $63.75, relieving $35.11, 2 × meal; RT 4 h plus 0.75 h travel home; SB 0.5 h;
    MD 1 h; SM $20.52; DM $20.53);
  - numbering, duplicate-meal refusal, override with required reason, and delete;
  - A↔B isolation (10), unauthenticated denial, Payments dark, and the surface (no Payments ops,
    payslip extract 404).
- SB excess travel did not generate, because the synthetic stations have no matrix data. This is
  expected and fails closed.

## UI smoke (`ui-smoke/`)

`report.json` — 19/19 in Chromium against the same build, with **0 external hosts contacted**
(no Supabase traffic). The run covers:

- sign-up → dashboard;
- profile and settings;
- spoilt and retain claims through the form with the live canonical preview;
- the hours list with the estimate, and no Mark Paid control;
- an override with a reason that persists across reload;
- the canonical tax summary;
- Payments dark;
- delete;
- sign-out → protected route redirects;
- sign-in restores data.

The logged `ERR_ABORTED` requests come from the script's own navigations; the 401s are the
expected signed-out session probe. Screenshots are included. The script is `ui-smoke.mjs`; it
needs `playwright-core`, which is not an app dependency.

## Static checks

- Unit tests: `node --test __tests__/*.test.mjs __tests__/*.test.js`.
  - This branch: 169 tests, 165 pass.
  - Baseline `origin/dev`: 146 tests, 142 pass.
  - The same four Jest-style files fail identically on both, because the node runner cannot run
    them: `grouped-claims`, `platoon-resolver`, `recall-retain-entitlements`, `travel-format`.
- Build: `next build` passes with `FAT_BACKEND=neon` and with the default Supabase mode.
- Client bundle scan of the 41 files in `.next/static`, for both role passwords, the cookie
  secret, `postgres://` / `postgresql://`, the env variable names, both role names and
  `SUPABASE_SERVICE_ROLE`: **0 hits**. Server output contains no literal secret.
- Supabase runtime audit — every remaining Supabase reference is one of:
  1. the unchanged Supabase-mode path (selected only when `FAT_BACKEND≠neon`);
  2. Payments/payslip services, which are unreachable on Neon because `isPaymentsEnabled` is
     forced off, extract returns 404 and the upload client throws;
  3. JSDoc type references.

  On Neon, `lib/supabaseClient.js` exports throwing guards, so an accidental call fails loudly
  instead of reaching Supabase.

## Neon `main` (read-only, 2026-10-06)

Schemas: `public` only. 0 user relations. No `fat*` roles. Neon Auth not enabled (404).
