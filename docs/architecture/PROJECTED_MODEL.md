# Fire Allowance Tracker — Projected Model

> **Status:** maintained architecture authority for *what FAT has been approved to
> become*. **Companions:** [`CURRENT_MODEL.md`](CURRENT_MODEL.md) (verified reality) →
> [`GAP_REGISTER.md`](GAP_REGISTER.md) (every difference, owned) → this file.
> **Rule:** this file contains only operator-approved intent. Any change to it requires
> recorded operator approval and a matching Gap Register update. It never silently
> absorbs an unowned delta.

## Authority and approval

- Established by [WORK-164](https://linear.app/catalyst-app-development/issue/WORK-164).
  Per **D9h**, `docs/architecture/` in this repository is the durable, maintained home of
  the FAT Current Model, Projected Model and Gap Register; historical governance-system
  ChatGPT Project Source copies remain provenance/input only.
- Approval evidence: WORK-164 comment `8cac4810-0ff9-4e62-8e47-d250ec250f39`
  (2026-10-01T11:27:47Z) — operator approved decisions **D1–D9**; recorded as Investigation
  Evidence Blocks `work-164-questions-r1…r6` and Investigation Record
  `work-164-investigation-record-20261001`.
- **Inputs, not authority:** the June-2026 target set
  (`governance-system/chatgpt-project-sources/fire-allowance-tracker/*_v1.0.md`,
  `docs/REBUILD_PLAN_v1.0.md`, `docs/REBUILD_AUDIT_v1.0.md` and related design docs). They
  assumed "not live / no production data / greenfield", which is **false**. Their concepts
  appear here only where re-approved.
- `main` / `dev` are release mechanics, not architecture states.

## Product purpose

FAT lets firefighters record each operational event once, see the allowance entitlements
that event generates under versioned rules, route each entitlement to its payment stream,
and verify payment — while keeping portable control of their own data.

## Multi-user isolation model (D9a)

- FAT is a **multi-user product** for independent subscribed users.
- Strict per-user isolation: one user's records are never visible or writable by another
  user (RLS owner scoping, no SECURITY DEFINER path that crosses users, least-privilege
  grants).
- **No implicit friend/social sharing.** The DEV friends/replication layer is not part of
  the product (D5). Any future sharing is a fresh, separately approved Idea.

## User-facing product model

Retained from Current (intentionally): email/password auth without middleware;
dashboard; station reference data; home address and distance services; platoon
resolver; **user-visible claim numbers**; **July–June financial-year grouping** (D9f);
tax summary export. Added: full user-data export, Google Sheets backup, dedicated
work-shift calendar sync (D8). The UI may display a claim's entitlements grouped beneath
it (D9c).

## Operational claim model (D1, D9b, D9c)

```
User records one operational event
        ↓
Operational Claim  (core row: user, date, type, claim number, FY, status)
  + type-specific factual detail  (recall | retain | standby | muster_dismiss |
                                    spoilt_meal | delayed_meal | …)
```

- One operational claim per event. **No prototype parent + artificial child-claim storage.**
- Delayed Meal and Spoilt Meal are separate semantic types with separate rules/rates; they
  may share implementation infrastructure.
- Claims store facts (inputs, distances snapshot, platoon), never derived payments.

## Generated entitlement model (D1, D3, D4, D9d)

```
Operational Claim → Versioned entitlement engine → 0..N Generated Entitlements
```

- Every relevant claim type has a generator. Entitlements are **hours-first** where the
  entitlement is time-based; no implicit hours-to-dollars conversion.
- Each entitlement carries: rule identity and explanation, rate/rule **version snapshot**,
  generated quantity and unit, optional derived estimate, payment route, status, and an
  audited manual-override trail (original, override, reason, actor, time).
- **Excess travel (SB / M&D) — D3 (rule confirmed by WORK-170, 2026-10-05):** source is
  FRV EBA 2020 Div A cl. 85.8.1 (M&D / detailed elsewhere) and cl. 85.8.4 (intra-shift
  move). Let R = rostered location, T = duty/standby/M&D location,
  `bands = ceil(radius_km(R, T) / 6)` (straight-line "radius", 6 km or part thereof).
  - **Eligibility (both):** `d(home, T) > d(home, R)` — strictly further from residence;
    equal or closer → no Excess Travel.
  - **M&D:** 1.0 h overtime allowance always; Excess Travel `0.25 h × bands × 2`
    (15 min each way) at ordinary rate, payslip hours.
  - **Standby, remained at T until shift end (85.8.4(b)):** 0.5 h overtime allowance;
    Excess Travel `0.25 h × bands` (one way). **Returned to R during the shift
    (85.8.4(a)):** no Excess Travel time and no 0.5 h — reasonable-transport
    reimbursement only.
  - **Fail closed:** no Excess Travel entitlement when R, T, the residence/FFH
    determination, the radius, or (Standby) the remained/returned fact is unavailable;
    base allowances unaffected.
  - Excess Travel is time, never km × rate. Fare/transport/mileage reimbursement is a
    separate entitlement (no double counting): basis is cost **in excess of** the ordinary
    home→rostered journey (distance form `max(0, d(home,T) − d(home,R))`); mileage only
    where cl. 85.9 applies (Division A Motor Vehicle / Mileage rate history in `fat.rate_versions`, `travel_per_km`; see `RATE_RULE_MODEL.md`). Implementation:
    WORK-173. Evidence record: WORK-170.
- **Recall / Retain / Spoilt / Delayed — approved rules (WORK-173, PROMPT #15):**
  [`CANONICAL_ENTITLEMENT_RULES.md`](CANONICAL_ENTITLEMENT_RULES.md). Recall: 4 h minimum at
  double time (cl 128.2), travelling time at ordinary rates (×1.5 Sunday/public holiday) and
  mileage for the actual home → work → home trip on **every** recall (cl 128.4 — no
  further-from-home gate, not the SB/M&D radius rule), Relieving Allowance when recalled to
  another station (cl 85.8.10), meals per cl 85.6.3. Retain: ≥ 60 min → 4 h minimum at double
  time (cl 128.5), shorter → cl 128.1 overtime, nearest quarter hour, notice irrelevant
  (cl 128.7), travel home after an interrupted night shift (cl 85.8.9), meals per cl 85.6.4.
  Spoilt (cl 85.7.1, `spoilt_meal_allowance`) and Delayed (cl 85.6.6/85.6.7, `meal_allowance`)
  are separate types.
- **Recall excess travel — D9d:** an entitlement is generated only when an authoritative
  rule establishes one; never a cosmetic $0 row.
- **Retain — D4:** hours-first; any displayed estimate derives from the applicable
  versioned enterprise/overtime rate rule.

## Rates and rule versioning (D4, D9e)

- Global, versioned rate/rule tables keyed by entitlement/classification context, with
  effective dates.
- Full internal precision; the applicable version is snapshotted on each entitlement.
- No magic constant (e.g. `101.02`) as architectural truth. Implemented contract:
  [`RATE_RULE_MODEL.md`](RATE_RULE_MODEL.md) (WORK-172).
- Explicit **per-claim** manual override with audit/provenance. Persistent arbitrary
  per-user rate overrides are **not** the primary model.
- A payslip is reconciliation evidence, never the canonical source of entitlement hours.

## Travel / distance model

Retained: Google Directions (server key) with routing fallback for home↔station distances;
FRV Index matrices for station-to-station km and hours; per-claim distance snapshots.
Excess-travel eligibility per D3. Inputs required by the verified rule are captured as
claim facts: R, T, residence location (or a reliable further-from-home determination),
`radius_km(R, T)`, and for Standby whether the member remained at T until shift end.

## Payment and reconciliation model (D6)

```
Generated Entitlements
        ↓  payment route
   ↙                 ↘
Payslip stream        Petty-cash stream
(pending → paid)      (outstanding → claimed)
   ↘                 ↙
Payment records ←N:M→ entitlement allocation links
        ↓
Append-only reconciliation audit → verified / outstanding state
```

- **One payment/reconciliation truth.** Prototype `payment_status` toggles are retired.
- Manual reconciliation paths always available.
- Integrity controls: over-allocation lock, duplicate-confirm lock, status checks,
  retract/reopen behaviour.
- **Remains dark** until (1) PROD parity/security is complete, (2) relevant claim types
  generate canonical entitlements, (3) a single payment truth exists (WORK-175).

## Payslip ingestion model (D7)

```
raw / import → parsed lines → matching candidates → user confirmation → reconciliation
```

A separate subsystem. Manual entry and confirmation are first-class. The matcher only
suggests; the user confirms. Duplicate detection by content fingerprint.

## OCR boundary (D7)

OCR is an optional extraction adapter at the "parsed lines" step. It stays **disabled
outside DEV** until an explicit, approved PII/retention policy exists (WORK-176). No
production stub fallback.

## Backup / portability model (D8)

Each user can export **all** of their FAT data in durable portable formats (CSV/JSON as
appropriate), strictly scoped to that user (WORK-177).

## Google Sheets backup model (D8)

A **user-controlled** backup in the user's own Google Sheets, laid out in a structured way
comparable to FAT's records (not an opaque dump). It is a backup/portability surface,
**not** FAT's canonical database; FAT never reads it back as truth. OAuth with
least-privilege, revocable scopes; tokens server-side only (WORK-178). Sync cadence and
target-spreadsheet choice remain product decisions inside WORK-178.

## Calendar-sync model (D8)

FAT creates and uses a **dedicated FAT-managed calendar** for the user's work shifts. FAT
creates/updates/removes only events it owns inside that calendar and never destructively
modifies the user's existing personal calendars. Provider-neutral intent: Google Calendar
first, iCal/ICS-compatible direction (WORK-179). Event content scope and roster-change
reconciliation remain product decisions inside WORK-179.

## PWA/mobile model (D9i)

FAT is an installable, mobile-first PWA. **Full offline operation is not part of this
baseline**; it would be a separate future capability.

## Data architecture

Single `fat` schema per environment (PostgREST-exposed), three layers:

| Layer | Tables (indicative) |
|---|---|
| Operational | `operational_claims` + per-type `*_details`; claim numbering; financial years |
| Entitlement | `claim_entitlements`; `rates` / `rate_versions` (rule versions) |
| Payment / reconciliation | `payment_records`, `entitlement_payment_links`, `reconciliation_audit`; payslip `payslip_imports` / `payslip_import_lines` |
| Reference | stations, station distance/time matrices, travel matrix versions |
| User | profiles, home address, integration connections (Sheets/Calendar tokens, server-only) |

Prototype per-type tables, `claim_groups` and `user_rates` (as primary) are retired only
after verified migration. No legacy `fire_allowance_tracker` schema or `public.fat_*`
objects. Every schema change is a ledgered migration matching a repo file.

## Security architecture

- Client-side auth, no middleware; service role server-side only (CLAUDE.md §7).
- RLS owner scoping on every user table; least-privilege grants; hardened `fat` default
  privileges; no-PUBLIC-execute enforcement for new functions; no anon-executable
  SECURITY DEFINER functions; no cross-user write paths.
- Leaked-password protection enabled on the shared auth pools.
- OAuth tokens for Google integrations stored server-side; least-privilege scopes.
- DEV and PROD Supabase and Vercel environments remain separate.

## Audit / provenance / overrides

Rule and rate versions snapshotted per entitlement; manual overrides record original,
new value, reason, actor and time; reconciliation audit is append-only; stored historical
amounts are never silently recalculated.

## Migration architecture (D1, D2, D9g)

**The Projected architecture is NOT permission to rebuild PROD from scratch.** Transition
is incremental and evidence-gated:

1. **PROD parity and security first** (WORK-165, WORK-166, WORK-167, WORK-145, WORK-186).
2. Revised canonical target and cutover plan approved (WORK-171; see [`CUTOVER_PLAN.md`](CUTOVER_PLAN.md)).
3. Versioned rate/rule model (WORK-172); verified rules (WORK-170); generators (WORK-173).
4. **Transform-copy** prototype data into canonical tables, prove parity; keep prototype
   storage **read-only** until verification sign-off.
5. Single payment truth; only then Payments activation (WORK-175).
6. Export/archive legacy data, then retire legacy objects (WORK-168).

No destructive step without verified archive and explicit Production approval.

## Deployment architecture

`task/<ID>` → PR → `dev` → (explicitly approved) PR → `main`; Vercel preview per PR and
production from `main`; separate DEV/PROD Supabase; database changes via ledgered
migrations applied in DEV, then PROD under approval. Vercel configuration audited and
recorded (WORK-182).

## Legacy-retirement strategy

Archive (with checksums and an agreed location) → prove no readers → drop under approval.
Applies to `fire_allowance_tracker`, `public.fat_*`, prototype per-type tables (after
cutover), abandoned-branch objects, and the DEV friends layer (removal, WORK-169).

## Explicitly excluded / separately scoped capabilities

- Full offline operation (future, separate).
- Social/friends/sharing (future fresh Idea only).
- Treating Google Sheets as a database.
- Modifying users' personal calendars.
- OCR in production before the PII/retention policy.
- Any historical formula or June-2026 assumption not re-approved here.
