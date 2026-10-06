# WORK-255 evidence — FAT cross-database C2/C3 transform + Neon DEV rehearsal (2026-10-06)

Governance v2 `main` `27c024e`, Projected `sha256:e1d30f105abaa9de2e880472262a49221cf49b74afd15594b5dcaf8ad303d3c5`.
Executor: Claude Code session `session_014F1HRWYdESH6qdvHBQv96w`. Tool `fat-c2-transform` **2.0.0**
(contract: [`C2_TRANSFORM_CONTRACT.md` § 11](../../architecture/C2_TRANSFORM_CONTRACT.md)).
No secret appears in any file here; all database access went through the Neon / Supabase connectors
(no connection string was fetched).

| Endpoint | Identity | Role in this run |
|---|---|---|
| Supabase DEV | `kctctvpobbizhkiqkgqw` | legacy source, **read-only** (5 selects in total — `results/supabase-call-audit.txt`) |
| Supabase PROD | `wgcqzamuspuqpedqasbc` | **not addressed** |
| Neon `dev` | `cool-meadow-70196410` / `br-wispy-dew-a7vd4v6k` | rehearsal target (governed data loads) |
| Neon `main` | `br-red-credit-a77927m4` | production target — read only, **empty before and after** |

## Rehearsal source

Supabase DEV prototype tables are **empty** (all five at 0 rows). The real DEV source was extracted
read-only (`snapshots/source-real-dev.json`), its Neon target snapshot md5-verified, and planned
(`plans/planReal`, batch `c2:dev:2.0.0:e11f4436…`, all gates pass, admission `apply`); it was **not
applied** (an empty batch proves nothing). The rehearsal therefore used the repository's synthetic
source (`lib/fat/migration/c2/synthetic.js`, evidence class `synthetic`): two owners
`5eed0255-…0a/…0b` with `@example.invalid` e-mails, stations 9001/9002, three migrated groups
(RC, RT, SM — incl. a G12 artifact, a preserved adjustment and paid/unpaid payment state) and
**three `EMPTY_CLAIM_GROUP` groups** (one owned by A, two by B, who has no other data). No real or
Production data reached Neon.

## Plan A (the rehearsed batch)

| Item | Value |
|---|---|
| batch key / change id | `c2:dev:2.0.0:c7dd894ad0445e4a573d746a4a65e5de` / `fat-c2-dev-c7dd894ad0445e4a573d746a` |
| plan sha256 | `799e83aade84ebd36277e877fd19b607c47153953f7a5b438c17a7c46ae986ca` |
| source checksum | `41af1c55913f344fc89c05f1416fca43dee5fed515c4c5e2a72bfef83ebea570` |
| full report sha256 | `11c463d2cd5a47f2ca6b2278ba7367defe5c35d88a4dd708b573567213f22014` |
| target reference md5 | `cc9177cebe965908f66374134d04f206` |
| gates | R, I, 1–7 pass; 8 (C4) and 9 (C5) not evaluated |
| planned rows | identities 2, FY 1 (B's FY carries no data and is not created), claims 3, details 3, entitlements 5 (1 adjustment), payment records 4, links 4, ledger 14 (claim 6, entitlement 4, excluded 4 = 3 `EMPTY_CLAIM_GROUP` + 1 G12) |
| groups | 6 total: claimed 3, excluded_empty 3, refused 0 |

## Sequence on Neon `dev` (all results in `results/`, preflight / verify-applied in `preflight/`)

| # | Step | Preflight | Outcome | verify-applied |
|---|---|---|---|---|
| 1 | apply A (`apply1.json`) | a1 allow | inserted everything; batch `6a21fbbb…`; plan sha `799e83aa…` echoed by the DB | a1 **verified** |
| 2 | identical rerun (`apply2-identical-rerun.json`) | a2 allow | **0 inserted**, every row `verified_existing` | a2 verified |
| 3 | verify (`verify1.json`) | verify1 allow (`data-write`) | all counters 0; `check` ok; $159.70 = $159.70; 4.25 h = 4.25 h; paid 555.25 = allocated 555.25; RLS probe owner 3/3, other 0, unset 0, ledger closed to `fat_app` | — |
| 4 | admission with fresh state | — | `already_applied`; re-plan from that state byte-identical (`plans/planA-replan`) | — |
| 5 | changed sources B, C | — | admission **refuse** (14 `source_row_held_by_other_batch` + 3 `claim_held_by_other_batch`) | — |
| 6 | conflict Cm in the DB (`conflict-Cm.json`) — one empty group's notes changed | conflict-Cm allow | `C2 conflict: migration_source_rows 9e73d0a6… differs`; nothing persisted (ledger checksum unchanged `f30d2a0a…`) | **unverified** (not-applied) |
| 7 | stale plan in the DB (`stale.json`) | stale allow | `C2 stale plan` (see note 2) | — |
| 8 | rollback A (`rollback.json`) | rollback allow (`…-rollback`) | removed 3 claims, 5 entitlements, 4 records (+4 links, 4 audit, 1 override cascaded), 14 ledger, batch; residue all 0; identities 2 / FY 1 / WORK-254 batch / native fingerprint `de50f2eb…` intact | rollback **verified**; apply change **unverified** |
| 9 | admission after rollback (`admit-after-rollback.json`) | — | `apply`; re-plan byte-identical (`plans/planA-replan2`) | — |
| 10 | rerun after rollback (`apply3-rerun.json`) | a3 allow | all batch rows inserted again; identities 2 + FY 1 reused (`verified_existing`); batch `5ab867c8…` | a3 verified |
| 11 | verify again (`verify2.json`, `check2.json`) | verify2 allow | identical to verify1 except the batch id; `check` ok | — |
| 12 | WORK-254 verify suite (`work254-verify-suite.json`) | verify-suite allow | 62/62 | — |

Negative preflights (all **refuse**): `neg-main` (main: `dev-not-verified`, `no-rollback`,
`clearance-required`), `neg-wrong-project` (`project-mismatch`), `neg-wrong-target-id`
(`target-mismatch`), `neg-no-change` (`no-change-id`). Mismatched change id:
`neg-mismatched-change` verify-applied → **unverified** (`not-applied`).

Final Neon `dev` data loads: `fat-c2-dev-c7dd894ad0445e4a573d746a`,
`fat-c2-dev-c7dd894ad0445e4a573d746a-rollback`, `fat-dev-synthetic-20261006`. The synthetic batch
stays on `dev` as the DEV-proven state.

## Final-state proofs (`results/baselines.json`)

- **Neon `main` empty** before (06:56:47Z) and after (07:33:18Z): schema `public` only, 0
  relations, 0 functions, `plpgsql` only, no `fat*` roles, no event triggers.
- **Supabase read-only**: every Supabase call of the session is listed in
  `results/supabase-call-audit.txt` — five read-only `select`s against DEV and one
  `list_projects`; no write keyword. The end-of-run Supabase DEV re-read could not be taken:
  the Supabase connector returned `FGA Authentication Error. Unauthorized` for every call from
  07:33Z (see note 3).

## Local replica (`local/`)

The same sequence ran first against a local PostgreSQL 16 replica of the Neon migrations and
seed (non-superuser owner, as on Neon) using `local-rehearsal.sh` with the full verbatim
`apply.sql` files, including the full stale-plan apply.

## Honesty notes

1. **Apply #1 transmission.** The SQL submitted for step 1 omitted three detail-insert loops
   that iterate over **empty** arrays in plan A (standby, muster/dismiss, delayed meal) and two
   comment lines. The embedded plan was byte-exact (the transport guard compared its sha256 in
   the database and the DB echoed `799e83aa…`), and the omitted loops would have inserted zero
   rows. Every later submission (rerun, conflict, rerun after rollback, verify ×2, rollback,
   residue) was the generated file verbatim; step 10 re-created the batch from the verbatim
   file after the rollback, so the final state on `dev` is the product of the full SQL.
2. **Stale test transmission.** Step 7 sent `planStale/apply.sql` verbatim up to and including
   the stale-reference guard, followed by an added unreachable `raise` and the block
   terminators; the rest of the apply code (unreachable once the guard raises) was not sent.
   The transport guard passed (embedded plan sha `dc1530b1…` matched). The full verbatim stale
   apply raised the same error in the local replica.
3. **Supabase end-state re-read** is missing for the connector reason above; the read-only
   claim rests on the call audit, not on a final re-read.
