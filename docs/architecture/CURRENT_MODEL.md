# Fire Allowance Tracker — Current Model

> **Status:** maintained architecture authority for *what FAT is now*.
> **Companions:** [`GAP_REGISTER.md`](GAP_REGISTER.md) (every difference, owned) →
> [`PROJECTED_MODEL.md`](PROJECTED_MODEL.md) (the approved destination).
> **Rule:** this file describes verified reality only. It is never edited to make
> reality look closer to Projected. When reality changes, update this file **and** the
> affected Gap Register rows in the same change.

## Authority and purpose

This document is the single maintained description of Fire Allowance Tracker (FAT) as
it actually behaves and is actually stored today. Established by
[WORK-164](https://linear.app/catalyst-app-development/issue/WORK-164) under operator
decision D9h (`docs/architecture/` is the durable home).

It **supersedes as current authority** every older document that describes FAT's
present state (see the document trust map at the end). It does **not** describe future
intent — that is [`PROJECTED_MODEL.md`](PROJECTED_MODEL.md).

> **`main` / `dev` ≠ Current / Projected.** `main` and `dev` are release mechanics
> (CLAUDE.md §3–§4). They currently carry *identical application code*. "Current" is
> spread across three separate surfaces described below; "Projected" is a separate
> approved model, not a branch.

## Verification date / provenance

Verified read-only on **2026-10-01** (no production mutation):

| Surface | Evidence |
|---|---|
| Code | `origin/dev` `62f52b2`, `origin/main` `0f80f5b` (merge base `e192f7e`) |
| Deployment | Vercel project `prj_d1cCc7dHXCKw04TNbwg1Wb130nBP` (team `catalystappdev`) |
| PROD database | Supabase `wgcqzamuspuqpedqasbc` "PROD (Live)" — catalog SELECTs and row counts only |
| DEV database | Supabase `kctctvpobbizhkiqkgqw` "DEV (Testing)" — catalog SELECTs and row counts only |
| Governance | snapshot `94d9aeb833abc03f1d4a4431f759b0f74c2d7a3d4989a2778ed131bc7d479ce5`; manifest `chatgpt.governance_mode: LIVE` |
| Records | WORK-164 comments `e848ae43` (Current evidence), `b64faf7d` (candidate/gaps), freshness re-check in Investigation Record `f1f1f6ac` |

Code references below are paths on `origin/dev` at `62f52b2`.

## Three current surfaces

```
          CODE / RUNTIME                PROD DATABASE                 DEV DATABASE
  main 0f80f5b == dev 62f52b2      wgcqzamuspuqpedqasbc         kctctvpobbizhkiqkgqw
  (identical app code)             canonical 01–14 only         canonical 01–22 + hardening
  Vercel PROD = main@0f80f5b       unhardened privileges        hardened privileges
  Vercel preview = dev@62f52b2     legacy schemas present       friends layer removed
```

They are **not** one deployment. The same code runs against two materially different
database states.

## Product scope

A web app (Next.js 15.5.15, React 18, JavaScript, App Router, mostly client components)
for FRV firefighters to record operational events, compute allowance amounts, and track
payment. Live in PROD with light real use (3 users). Personal-tool origins; no
multi-tenant controls beyond Supabase RLS owner scoping.

## User/auth model

- Supabase email/password auth, entirely client-side (`lib/supabaseClient.js`,
  `app/login`, `app/signup`, `app/forgot-password`, `app/reset-password`). **No
  middleware.** Each page checks `getSession` and redirects.
- `fat.handle_new_user` trigger on `auth.users` seeds the FAT profile
  (`on_auth_user_created_fat`).
- The Supabase auth pool is **shared with other apps** (MICA, CAB, Dog Log, …).
- API routes (`/api/travel/google`, `/api/payslip/extract`) validate the caller's JWT
  with the anon key; RLS applies. Service-role key appears only in `scripts/*.mjs`.

## Current claim lifecycle

```
ClaimForm → engine calc (lib/calculations/engine.js, prototype)
  → increment_claim_sequence RPC (claim number)
  → fat.claim_groups (parent)  → per-type row  → auto-children rows   [PRIMARY]
  → (Standby / M&D only) canonicalBridge → fat.operational_claims + *_details
        → fat.claim_entitlements (hours-first, rate snapshot)          [MIRROR, non-fatal]
  → dashboard lists grouped claims; Mark Paid writes payment_status on prototype rows
```

- Parent status is derived from children (`lib/claims/ClaimsContext.js`).
- Editing changes date/amount/status/shift only; no recalculation.
- Child-insert and canonical-mirror failures are logged, not surfaced.

## Current claim types

| UI type | Storage | Notes |
|---|---|---|
| Recall | `fat.recalls` | Callback-Ops, Excess Travel and meal children |
| Retain | `fat.retain` | "Maint stn N/N" child; hours-first + dollars (see rates) |
| Standby | `fat.standby` | night meal + Excess Travel children; mirrored to canonical |
| Muster & Dismiss (M&D) | `fat.standby` (`standby_type='M&D'`) | virtual type; mirrored to canonical |
| Spoilt meal | `fat.spoilt_meals` (`meal_type='Spoilt'`) | 5-digit Firecall Number required |
| Delayed meal | `fat.spoilt_meals` (`meal_type='Delayed'`) | 5-digit Firecall Number required |

## Current grouping/child-claim behaviour

Prototype parent + artificial auto-child rows (`getAutoChildDefinitions`). **Defect:**
the Recall "Excess Travel" child is always **$0** — `ClaimsContext.js:125` reads
`breakdown.excessTravelAmount`, which `calcRecallClaim` never returns.

## Current calculation/rate behaviour

- **Rates (WORK-172; DEV after migration `20261005060000`, PROD pending):** global versioned
  `fat.rates` / `fat.rate_versions` with classification, provenance and withdrawal, resolved
  per claim date by `RatesContext.ratesForDate` (prototype) and `ctx.rateLookup` /
  `ctx.overtimeLookup` (canonical). See [`RATE_RULE_MODEL.md`](RATE_RULE_MODEL.md).
  `fat.user_rates` is no longer read or written (table retained until C7/Neon); `/settings` is
  read-only plus classification history. `DEFAULT_RATES` is an offline fallback only
  (km 1.50, small meal 10.90, large meal 20.55).
- Retain $ = round(hours × round(BasePay[classification] × 0.9093 ÷ 36, 2) × 2, 2); fails
  closed (hours only) without a recorded classification. `retain_rate_used` is unconstrained
  `numeric`; the full version snapshot is in `calculation_inputs.retainRate`. The cents-rounded
  base is the FAT best-fit **estimate convention** (WORK-246), not FRV payroll's formula. LFF 4 h
  estimate $404.08 vs payslip $404.09; 12.25 h $1,237.50 vs $1,237.53 (accepted estimate error).
- km = `travel_per_km` industrial history (1.37 → 1.50 from 2023-06-17, PR765587); the
  workbook 1.20 version is withdrawn. Small/large meal remain workbook-provenance codes
  (industrial `meal_allowance` / `spoilt_meal_allowance` seeded; mapping is WORK-173).
- Canonical entitlement overrides are audited in `fat.entitlement_overrides` (reason required;
  generation fields immutable).
- Stored amounts are static historical records (not recalculated).
- Financial year: July–June, labelled `NNNNFY`, auto-created per user
  (`lib/fy/FinancialYearContext.js`, `fat.financial_years`).
- Claim numbers: user-visible, from `fat.increment_claim_sequence`.

## Current travel behaviour

- Home → station: geocode (Photon/Nominatim), route via `/api/travel/google` (Google
  Directions, server key) → OSRM fallback; cached in `fat.home_address`,
  `fat.station_distances`.
- Recall rostered → recall station leg: FRV Index matrix (`fat.travel_matrix_cells`).
- Standby: Google km for reimbursement + FRV matrix hours (`fat.travel_matrix_lookup`).
- M&D petty-cash km = `max(0, Home→Rostered − Home→M&D)` — **reversed** relative to EBA
  cl. 85.8.1 (excess over home→rostered); correction owned by WORK-173 (WORK-170 rule).
- **No excess-travel eligibility gate** for Standby/M&D (canonical generators emit when
  rostered ≠ target; prototype children pay km × rate). The confirmed rule (WORK-170;
  PROJECTED_MODEL D3) is not yet implemented — WORK-173.
- Stations: 83 rows, explicit ids; Training Academy FS60; Spring Street id 100
  (non-fire location). Platoon: deterministic 8-day A/A/D/D/C/C/B/B rotation anchored
  2026-01-03 (`lib/platoon/resolveOperationalPlatoon.js`).

## Current payment behaviour

- **Reachable in PROD:** dashboard Mark Paid toggles `payment_status` on prototype rows
  (plus a write to `fat.payment_components`, a table no SQL defines).
- **Built but dark:** canonical Payments/Reconciliation — `payment_records`,
  `entitlement_payment_links` (N:M), `reconciliation_audit`, RPCs
  (`create_payment_record`, `retract_payment`, `link/unlink_entitlement_payment`,
  `recompute_entitlement_status`, `route_entitlement`), UI `/payments`.
  Gate: `isPaymentsEnabled()` (OFF for the PROD Supabase ref) **and** per-user row in
  `fat.user_feature_flags` (table absent in PROD → fails closed).
- **Two payment truths** exist for SB/MD (prototype status vs canonical entitlement status).
- Reconciliation can only see SB/MD entitlements.

## Current payslip/OCR behaviour

Built, Payments-gated, dark in PROD: `fat.payslip_imports` / `payslip_import_lines`,
matcher (suggest-only), fingerprint duplicate detection, private screenshot bucket,
`confirm_payslip_import_line`. OCR adapter: OpenAI (`gpt-4o-mini`) or Anthropic
(`claude-haiku-4-5`) via `PAYSLIP_OCR_PROVIDER`; returns 503 without a provider key;
deterministic stub only in non-production with `PAYSLIP_OCR_ALLOW_STUB`. PII/retention
policy unresolved.

## Current export/backup/calendar behaviour

- Tax page: CSV download, copy, print-to-PDF — the **only** export.
- `lib/reconciliation/exportUtils.js` (CSV/JSON builders) — dead code.
- **No** user-data export, **no** Google Sheets backup, **no** calendar sync in FAT.
  (DEV migration `add_google_calendar_sync` belongs to CAB, not FAT.)

## Current PWA behaviour

`public/manifest.json` (standalone, portrait) + Apple web-app meta; **no service
worker**; installability not verified.

## Current external integrations

Supabase (auth, Postgres, storage), Google Directions (server), OSRM, Photon /
Nominatim, OpenAI / Anthropic (dark), Vercel hosting.

## Current code/release topology

- `dev` = development branch; `main` = production (Vercel auto-deploys `main`).
- `main` `0f80f5b` (2026-07-16) and `dev` `62f52b2` (2026-10-01) have identical app
  code; `dev` adds governance, CI (Head Branch Gate only), docs and SQL packages.
- Vercel PROD deployment `dpl_GYqYBZN2Z7GLgUDaHCRXUUYMkL31` = `main@0f80f5b` at
  `fire-allowance-tracker.vercel.app`; latest dev preview `dpl_ADbkbXsK…` = `62f52b2`.
- Vercel framework preset shows `create-react-app` (app is Next.js; `vercel.json`
  overrides). Environment variable names unverified (403).
- No test runner installed; no build/test CI on PRs into `dev`.

## Current PROD database

Supabase `wgcqzamuspuqpedqasbc` (shared multi-app). Schema `fat`: **35 tables, 15
functions, RLS on every table.**

- Canonical migrations applied: 01–14 (ledger `fat_parity_01…19`, 2026-06-12/14) plus
  abandoned-branch `fat_parity_20_canonical_dual_write_provenance` and
  `fat_parity_21_canonical_ffh_home_distances`.
- **Absent:** canonical 15 (payment_status check), 16 (over-allocation `FOR UPDATE`),
  17 (duplicate-confirm advisory lock), 18 (retract reopen), 19 `user_feature_flags`,
  GOV-89 / APP-92 cleanup. (Canonical 21/22 posture applied 2026-10-04 by WORK-166 — see
  *Current security posture*.)
- Data (counts): auth.users 3, `fat.profiles` 3, `claim_groups` 4, `recalls` 4,
  `spoilt_meals` 2, `financial_years` 2, `claim_sequences` 2; canonical claim /
  entitlement / payment tables 0; reference: stations 83, station_distance_matrix 6642,
  station_time_matrix 2736, travel_matrix_cells 4689, rates 5.
- Extra PROD-only objects: `fat._stations_pre_frv_backup` (0 rows, RLS, no policy),
  `fat.distance_cache` (0 rows).
- Legacy: schema `fire_allowance_tracker` (11 tables; `fire_allowance_claims` 1 row,
  `station_distances` 82) and `public.fat_*` / old per-type tables (`fat_stations` 48,
  `recalls` 5, `retain` 1, `spoilt` 2, `standby` 1, …), 4 enums,
  `public.fat_set_updated_at`.

## Current DEV database

Supabase `kctctvpobbizhkiqkgqw` (shared multi-app). Schema `fat`: **34 tables, 16
functions, RLS on every table.**

- Canonical 01–22 applied (`canonical_*`, `fat_*_15…18`, `user_feature_flags`,
  `app93_*`, `app103_*`), GOV-89 and APP-92 cleanup applied; no `fat` default ACLs;
  event trigger `fat_enforce_no_public_execute`.
- Data (counts): auth.users 2, `operational_claims` 4, `claim_entitlements` 9,
  `reconciliation_audit` 4, prototype claim tables mostly empty.
- **Friends/replication layer removed** (WORK-169): the untracked layer from ledger
  `20260515223705` (3 empty tables, 10 SECURITY DEFINER functions, no app code) was
  dropped by ledger `20261001232645 work169_drop_fat_friends_replication_v1`. Package and
  verbatim provenance: `supabase/dev-cleanup/work-169-friends-replication/`.

## PROD vs DEV divergence

| Aspect | PROD | DEV |
|---|---|---|
| Canonical migrations | 01–14 (+ dual_write/ffh) | 01–22 (+ dual_write/ffh) |
| `user_feature_flags` | absent | present |
| Integrity locks 15–18 | absent | present |
| Default privileges | none (hardened, WORK-166) | none (hardened) |
| No-PUBLIC-execute trigger | present (WORK-166; `ensure_rls` also present) | present |
| anon privileges on `fat` tables / functions | none (WORK-166) | none (WORK-166) |
| Friends/replication | absent | absent (removed, WORK-169) |
| Legacy `fire_allowance_tracker` / `public.fat_*` | present | removed |

A blind DEV → PROD schema copy is **unsafe** (the remaining divergences above are not
promotable as-is).

## Current security posture

- `fat`, both projects (WORK-166, verified 2026-10-04; PROD ledger
  `20261004222427 work166_fat_harden_privileges`, DEV `20261004202335`): no `fat` default
  ACLs; anon holds no privilege on any `fat` table (PROD 0/36, DEV 0/34; RLS on all);
  no `fat` function is PUBLIC- or anon-executable; event trigger
  `fat_enforce_no_public_execute` enabled. `authenticated`/`service_role` table grants
  unchanged (least-privilege trim: WORK-237).
- `fat.increment_claim_sequence`, both projects (WORK-167, verified 2026-10-05; PROD
  ledger `20261005003435 work167_fat_claim_sequence_caller_check`, DEV `20261004234921`):
  SECURITY INVOKER, `search_path = ''`, and rejects (`42501`) any call where `auth.uid()`
  is null or differs from `p_user_id`; the `claim_sequences` RLS policy `users_manage_own`
  applies. A signed-in user can advance only their own claim sequence. EXECUTE:
  `authenticated`, `service_role` only. No `fat` SECURITY DEFINER function is executable by
  an API role. **Neon (GOV-481):** carry the invariant "a claim sequence advances only for
  the authenticated caller" with identity from the server-side session, not by porting
  `auth.uid()`.
- PROD `public` (not `fat`): `public.fat_set_updated_at` (legacy FAT trigger function, PROD
  only; retired with WORK-168) and `public.rls_auto_enable` (shared/platform `ensure_rls`
  event trigger, not FAT-owned) remain SECURITY DEFINER and anon-executable per the
  advisors.
- PROD legacy `fire_allowance_tracker` (WORK-144, verified 2026-10-04): anon/authenticated
  hold direct `arwdDxtm` grants on all 11 tables and `fire_allowance_claims` has `true` CRUD
  policies, but the schema is **not externally reachable**: PostgREST exposes only `public,
  graphql_public, fat, mica, shared, cab, dog_log` (live `PGRST106`), no API role (anon,
  authenticated, service_role, authenticator) has schema USAGE, and `pg_graphql` is not
  enabled. Latent only; disposition is retire with Supabase (WORK-168), not standalone
  revocation. Guardrail: never expose it or grant USAGE on it before retirement.
- Leaked-password protection off (both projects).
- `.claude/settings.local.json` committed with a private Google Sheet URL.

## Current migration/ledger drift

- Ledger names ≠ repo filenames (`fat_parity_*`, `canonical_*`).
- Two repo files numbered 19.
- `19_seed_spring_street_station` and `20_rename_station60` effects present in both DBs
  with no ledger entry.
- Abandoned-branch `dual_write_provenance` / `ffh_home_distances` applied in both DBs.

## Current known defects / dark / stubbed behaviour

| Item | Class |
|---|---|
| Canonical generators recall / retain / spoilt / delayed return `[]` | STUBBED |
| SB/MD canonical mirror only; prototype primary | PARTIAL / HYBRID |
| Recall Excess Travel child always $0 | DEFECT |
| Retain rate truncated to 2 dp | RESOLVED in DEV (WORK-172); PROD pending |
| Two payment truths (SB/MD) | DEFECT (architectural) |
| `fat.payment_components` phantom write | LEGACY / UNCERTAIN |
| Payments, payslip import, OCR | IMPLEMENTED BUT DARK |
| `exportUtils.js`, `ClaimList.js`, `/dashboard`, `/paths` | LEGACY BUT PRESENT |
| PWA service worker | ABSENT |
| Jest tests | NOT RUNNABLE |

## Current Linear-owned remediation work

Every difference from Projected is listed with its owner in
[`GAP_REGISTER.md`](GAP_REGISTER.md). Pre-existing owners: WORK-144, WORK-145. Owners
created by WORK-164: WORK-165 – WORK-187.

## Document trust map (as of 2026-10-01)

| Document | Rating | Reason |
|---|---|---|
| `docs/architecture/*` | CURRENT AUTHORITY | this baseline |
| `.catalyst/app.yml`, `CLAUDE.md`, `.claude/rules.md` | CURRENT AUTHORITY (identity/workflow) | reconciled 2026-10-01 |
| `docs/PLATOON_RESOLVER.md`, `docs/STATION_TIME_MATRIX_IMPORT_v1.0.md` | CURRENT BUT PARTIAL | match code; narrow scope |
| `docs/PAYMENTS_FEATURE_FLAG.md` | CURRENT BUT PARTIAL | omits per-user DB layer; cites missing runbook |
| `docs/FAT_SCHEMA_ARCHITECTURE.md` | CONTRADICTORY | hardening sections current; inventory/PROD statements stale |
| `docs/CALCULATION_RULES.md`, `docs/FINANCIAL_VERIFICATION_CHECKLIST.md` | STALE (partly) | retain "UNRESOLVED/0", M&D label, missing newer rules |
| `README.md` | STALE (partly) | wrong rates, missing folder |
| `docs/PROD_ROLLOUT_CHECKLIST.md` | STALE | prototype-only, impossible Phase-5 check |
| `docs/WORKFLOW.md` | STALE (partly) | `npm test`, §2 vs §4 |
| OCR / PAYMENT / PAYSLIP design docs | FUTURE-DESIGN INPUT | say "not built"; now built and dark |
| REBUILD_PLAN / REBUILD_AUDIT, ENGINE_CONTRACTS, CLAIM_LIFECYCLE, RECONCILIATION_STATE | FUTURE-DESIGN INPUT | June 2026 target; status stale |
| CURRENT_STATE_GAP_ANALYSIS, SCHEMA_READINESS | STALE | overtaken |
| Activation / seed reports, SALVAGE, BRANCH_DISPOSITION | HISTORICAL | SALVAGE is the only FFH record |
| Root `DISTANCE-SYSTEM-DEPLOY-REPORT.md`, `FAT_SCHEMA_AUDIT_REPORT.md`, `supabase-migration-v4-*.sql` | HISTORICAL | — |
| governance-system `chatgpt-project-sources/fire-allowance-tracker/*_v1.0.md` — now held in FAT at [`docs/legacy/chatgpt-project-sources/`](../legacy/chatgpt-project-sources/README.md) (WORK-220) | FUTURE-DESIGN INPUT / provenance | Draft; false greenfield premise |

Reconciliation of stale documents is owned by WORK-185.
