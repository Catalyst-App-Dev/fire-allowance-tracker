# Fire Allowance Tracker — Neon application runtime (N2, DEV)

WORK-256. Builds on [`NEON_BACKEND.md`](NEON_BACKEND.md) (N0–N1 schema, identity seam) and
WORK-255 (C2/C3 transform). Scope is **Neon `dev` only**: Neon `main` is empty, Production keeps
running on Supabase, and nothing here changes a Production setting.

## 1. Routing and rollback

| `FAT_BACKEND` | Runtime |
|---|---|
| unset / `supabase` (default) | Unchanged Supabase client-side app (CLAUDE.md §7). |
| `neon` | Server-side Neon data layer + Neon Auth. Supabase clients become throwing guards. |

`next.config.mjs` inlines the choice as `NEXT_PUBLIC_FAT_BACKEND` at build time, so a change
needs a **redeploy**. There is no hybrid mode: on `neon` no code path reaches Supabase (proved by
the UI smoke — zero external hosts — and by the guard in `lib/supabaseClient.js`).

**Rollback** = set `FAT_BACKEND=supabase` (or remove it) and redeploy. Honest limits:

- Neon Auth sessions are not Supabase sessions. Members signed in on Neon are signed out and must
  sign in again with their Supabase credentials.
- Data written on Neon `dev` stays on Neon `dev`; it is not copied back to Supabase. On DEV this
  is synthetic data only, so nothing is lost that matters.
- The Supabase path is unchanged by this work (both builds pass; `origin/dev` behaviour preserved).

## 2. Server data layer (`lib/server/`)

Every member request is `POST /api/fat/<op>` → `memberRoute`:

1. Neon mode only (otherwise 404).
2. Validate the Neon Auth session server-side (`auth.js`, cookie proxied through
   `/api/auth/[...path]`). No session → 401.
3. Resolve the FAT app identity (`identity.js`, §4). A browser-supplied UUID is never used —
   operation inputs never carry an owner id.
4. `withMemberTx`: one transaction on `FAT_DATABASE_URL` (`fat_app_server`) →
   `SET LOCAL ROLE fat_app` → `set_config('fat.app_user_id', <identity>, true)` → operation →
   commit. RLS on every owner-scoped table does the rest.
5. 42501 maps to 403; validation errors to 400; anything else to 500 without detail.

`OPERATIONS` (`ops/index.js`) is a frozen, prototype-free allowlist. `fatClient.js` gives
operations a PostgREST-shaped builder over parameterised SQL with allowlisted tables/RPCs and
identifier checks, so the existing repositories run unchanged on both backends. Unfiltered
update/delete is refused before reaching the database. There are no Payments operations.

## 3. Database roles (migration `20261006090000_fat_neon_app_server_roles`)

| Role | Attributes | Membership | Used for |
|---|---|---|---|
| `fat_app_server` | LOGIN, NOINHERIT, NOBYPASSRLS | `fat_app` with `INHERIT FALSE, SET TRUE` | every member transaction |
| `fat_identity_provisioner` | LOGIN, NOINHERIT, NOBYPASSRLS | `fat_service` with `INHERIT FALSE, SET TRUE` | identity resolution / provisioning only — never CRUD |

Neither login role can read anything without `SET ROLE`, neither can switch to the other's role,
and neither bypasses RLS (RLS proof checks 15–20). Passwords are set outside the repository
(§8); the migration contains none. Rollback: `neon/rollbacks/20261006090000_…rollback.sql`.

## 4. Neon Auth and identity

Neon Auth (Managed Better Auth) is provisioned on **`dev` only**: e-mail/password, sign-up,
sign-in, sign-out, session persistence (HTTP-only cookies), password reset. E-mail verification
is not required on DEV; the identity policy compensates:

- `identityPolicy.js` (pure, unit-tested): on DEV a new identity is provisioned **only** for a
  reserved synthetic domain (`RESERVED_TEST_EMAIL`: `.invalid`, `.test`, `.example`, `.localhost`,
  `example.com/.net/.org`). Any other address is
  refused with 403 `NOT_SYNTHETIC` — no real member can be created on Neon DEV.
- An existing identity is linked to a new Neon Auth subject only if the session e-mail is
  **verified**; an unverified sign-up never takes over an identity. Disabled identities are never
  linked or resolved.
- `identity.js` runs in a `fat_service` transaction: resolve link → per-e-mail
  `pg_advisory_xact_lock` → re-resolve → `ensure_app_identity` → insert `identity_links`
  (`on conflict do nothing`) → re-resolve. The lock fixes the concurrent first-request race
  (burst test in the E2E). Results are cached for 60 s.
- Invalid or expired session → 401 → the client raises `AUTH_EXPIRED_EVENT` and returns to
  `/login`.

## 5. Canonical claims (Decision 1 = A)

The Neon path reads and writes the canonical model directly — `operational_claims`, the six
detail tables and `claim_entitlements`. Prototype claim tables are **not** recreated.

| App type | Canonical | Detail table |
|---|---|---|
| `recalls` | RC | `recall_details` |
| `retain` | RT | `retain_details` |
| `standby` | SB | `standby_details` |
| `md` (muster/dismiss) | MD | `muster_dismiss_details` |
| `spoilt` | SM | `spoilt_meal_details` |
| `delayed_meal` | DM | `delayed_meal_details` |

- **Create** (`claims.create`, one transaction): FY ownership → canonical detail built from form
  fields plus explicit facts (`model.js`, C2 §4 derivations) → duplicate meal-event refusal
  (SM/DM) → claim number → claim + detail → WORK-173 generators → hours-first entitlements with
  rate snapshots. Rules are the record; the prototype breakdown is not persisted.
- **Preview** (`claims.preview`): the same generators as a dry run, shown live in the form
  together with any facts still missing.
- **Edit** = audited override of one entitlement (`edited_amount` / `edited_hours` with a
  required reason; the trigger writes `entitlement_overrides`). Generated values stay
  write-once. Refused once a payment links the entitlement.
- **Delete / retract** = the whole claim; refused (409) when any entitlement is payment-linked.
- **Numbering**: `increment_claim_sequence` keyed by (owner, FY, canonical type), with a
  skip-taken loop (max 50) against the uniqueness scope (owner, FY, canonical type,
  claim_number). Deterministic on DEV.
- **Root-cause fix:** the standby small-meal trigger used `Date#getHours()` (runtime time zone).
  It worked only by accident in a Melbourne browser; on the server (UTC) it never fired. It now
  compares Melbourne-local seconds; regression test covers UTC, Melbourne and Los Angeles.

### Paid / payment status (Payments dark)

`payment_status` is derived, never fabricated: `Paid` only when a payment record links the
entitlement, otherwise `Pending`. Mark-Paid / QuickPay controls are hidden and the context
refuses the calls. No payment records are created by this work.

### User-visible differences on the Neon path

1. List rows show canonical entitlement labels; hours entitlements show hours with "≈ $X est."
2. Mark-Paid / QuickPay toggles are not shown; status is read-only (above).
3. "Edit" is a per-entitlement override with a required reason ("Adj" badge), not a free edit.
4. Individual entitlement rows cannot be deleted; delete removes the whole claim.
5. The claim form asks for the canonical facts it needs (e.g. Sunday/PH travel, night shift
   interrupted, delay notice) and shows a live preview; submit needs ≥ 1 entitlement.
6. The tax summary is computed from canonical rows (meal counts, mileage km/$).
7. Payments, payslip upload and OCR are unavailable.
8. Accounts are Neon Auth accounts; Supabase sessions and passwords do not carry over.

## 6. Storage (Decision 2 = C)

Neon Object Storage is `region_unavailable` in `aws-ap-southeast-2`. No vendor is chosen. On
the Neon path `/api/payslip/extract` returns 404, the upload client throws, and Payments is
forced off (`isPaymentsEnabled` rule 0). Follow-up: **WORK-257** (blocks WORK-175).

## 7. What WORK-193 still owns

DEV application code moved into WORK-256. WORK-193 keeps Production parity and sign-off,
cutover preparation, the routing switch, every Production action, and:

- **Sequence alignment.** After the C4 copy, set each `fat.claim_sequences` row to at least
  `max(claim_number)` per (owner, FY, canonical type). Without it the skip-taken loop absorbs at
  most 50 collisions and then refuses creation (`SEQUENCE_EXHAUSTED`).
- Production Neon Auth provisioning, trusted domains, real-member identity linking by verified
  e-mail, and the member password-reset communication.
- Lifting the DEV synthetic-only identity rule for Production (a deliberate, reviewed change).
- Vercel function region. The project currently runs functions in `iad1`, while Neon is in
  `aws-ap-southeast-2`; each member request opens a transaction across the Pacific. Pin functions
  to `syd1` before Production.
- Neon Auth trusted domains for the Production origin. DEV trusts only the WORK-256 Preview
  branch alias, plus localhost through the provider's localhost setting.

## 8. Environment variables (server-only unless noted)

FAT convention: every application-specific variable carries the `FAT_` prefix. The environment
is the **Vercel scope**, never part of the key — e.g. `FAT_DATABASE_URL — Preview` and, later,
`FAT_DATABASE_URL — Production` are the same key in two scopes. WORK-256 sets **Preview only**
(branch `task/WORK-256-neon-dev-app-auth`); no Production variable exists or is created.

| Key — scope | Value |
|---|---|
| `FAT_BACKEND — Preview` | `neon` (literal) — build-time; inlined as `NEXT_PUBLIC_FAT_BACKEND` |
| `FAT_DATABASE_URL — Preview` | Postgres URL for `fat_app_server` on the Neon `dev` endpoint |
| `FAT_DATABASE_SERVICE_URL — Preview` | Postgres URL for `fat_identity_provisioner` on the Neon `dev` endpoint |
| `FAT_NEON_AUTH_BASE_URL — Preview` | Neon Auth URL of the `dev` branch (not secret) |
| `FAT_NEON_AUTH_COOKIE_SECRET — Preview` | random secret, ≥ 32 characters (enforced at startup) |

Only `FAT_BACKEND` reaches the browser (as the literal `neon`/`supabase`); the four others are read
only by `lib/server/` (`__tests__/neon-env-contract.test.mjs` pins this). The client-bundle scan
finds no credential, secret, role name or variable name. Role passwords are set by the operator in
the Neon console and never committed.
