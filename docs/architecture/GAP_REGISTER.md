# Fire Allowance Tracker — Gap Register (Current → Projected)

> **Status:** maintained authority for every difference between
> [`CURRENT_MODEL.md`](CURRENT_MODEL.md) and [`PROJECTED_MODEL.md`](PROJECTED_MODEL.md).
> **Invariant:** every Projected − Current difference is known, intentional,
> evidence-backed, operator-approved and **owned** by a Linear Issue. A row closes only when
> CURRENT_MODEL is updated to show the Projected behaviour as verified reality.
> This register never describes a future state that PROJECTED_MODEL does not contain.

Established 2026-10-01 by [WORK-164](https://linear.app/catalyst-app-development/issue/WORK-164).
Provenance keys: **E1** = WORK-164 comment `e848ae43` (Current evidence), **E2** =
`b64faf7d` (candidate gaps), **A** = operator approval `8cac4810` (D1–D9).

## Classes

| Class | Meaning |
|---|---|
| **APG** | Approved Projected gap — new/changed capability or architecture |
| **SEC/DEF** | Current defect or security remediation required by Projected |
| **DOC** | Documentation only |
| **FUT** | Separately scoped future capability approved into Projected (D8) |
| **EVID** | Evidence / rule / policy verification required before implementation |

## Register

| ID | Current → Projected | Class | Category | Risk | Owner (state) | Prod approval | Policy evidence | Provenance |
|---|---|---|---|---|---|---|---|---|
| G01 | PROD lacks canonical 15–18 integrity locks/status check → parity | SEC/DEF | data / security | High | [WORK-165](https://linear.app/catalyst-app-development/issue/WORK-165) (Backlog) | Yes | No | E1, D9g |
| G02 | PROD lacks canonical 19 `user_feature_flags` → parity | SEC/DEF | data | Med | WORK-165 (Backlog) | Yes | No | E1 |
| G03 | PROD `fat` default ACL / anon grants unhardened → canonical 21 posture | SEC/DEF | security | High | [WORK-166](https://linear.app/catalyst-app-development/issue/WORK-166) (Active; migration `20261004120000_fat_harden_privileges`, PROD pending approval); DEV provenance WORK-93 | Yes | No | E1 |
| G04 | PROD lacks no-PUBLIC-execute trigger; legacy PUBLIC-exec fns both DBs → enforced | SEC/DEF | security | High | WORK-166 (Active; same migration); DEV provenance WORK-103 | Yes | No | E1 |
| G05 | Anon-executable SECURITY DEFINER FAT functions in PROD → none | SEC/DEF | security | High | [WORK-167](https://linear.app/catalyst-app-development/issue/WORK-167) (Backlog) | Yes | No | E1, WORK-144 record |
| G06 | Legacy `fire_allowance_tracker` anon/auth grants (latent) → revoked; exposure verified | SEC/DEF | security | Med | [WORK-144](https://linear.app/catalyst-app-development/issue/WORK-144) (Investigation), [WORK-145](https://linear.app/catalyst-app-development/issue/WORK-145) (Backlog) | Yes (145) | No | E1 |
| G07 | Legacy schema + `public.fat_*` present → archived then retired | APG | data / migration | Med | [WORK-168](https://linear.app/catalyst-app-development/issue/WORK-168) (Backlog, blocked by WORK-145) | Yes | Yes (archive location/retention) | E1, D2 |
| G08 | Generators recall/retain/spoilt/delayed return `[]` → all types generate | APG | architecture | Med | [WORK-173](https://linear.app/catalyst-app-development/issue/WORK-173) (Backlog, blocked by WORK-171, WORK-172) | Later (deploy) | Yes (rules) | E1, D1/D4/D9b/D9d |
| G09 | Two payment truths (SB/MD) → single truth | APG | architecture / data | High | [WORK-171](https://linear.app/catalyst-app-development/issue/WORK-171) (plan, [`CUTOVER_PLAN.md`](CUTOVER_PLAN.md)); execution: WORK-191 (C3), WORK-193 (C5), WORK-194 (C6) | Later | No | E1, D6 |
| G10 | Prototype per-type + parent/child storage primary → canonical primary via verified transform-copy; prototype read-only then retired | APG | migration | High | WORK-171 (plan, [`CUTOVER_PLAN.md`](CUTOVER_PLAN.md)); execution: WORK-189 (C1), WORK-190 (C2), WORK-192 (C4), WORK-193 (C5), WORK-194 (C6), WORK-195 (C7) | Yes (data migration) | No | E1, D1/D2/D9c |
| G11 | Code constants + per-user `user_rates`; retain constant truncated → global versioned rate/rule model, full precision, audited per-claim override | APG | data / architecture | Med | [WORK-172](https://linear.app/catalyst-app-development/issue/WORK-172) (Backlog) | Later | Yes (rate values / effective dates) | E1, D4/D9e |
| G12 | Fake $0 Recall Excess Travel child → none; real entitlement only under a verified rule | SEC/DEF | product | Low | [WORK-174](https://linear.app/catalyst-app-development/issue/WORK-174) (Backlog); rule part in WORK-173 | Later (runtime promotion) | No | E1, D9d |
| G13 | SB/M&D excess travel ungated → evidence-derived rule, fail closed | EVID | product | Med | [WORK-170](https://linear.app/catalyst-app-development/issue/WORK-170) (Backlog); implementation in WORK-173 | No | **Yes — exact rule unknown** | E2, D3 |
| G14 | ~~DEV friends/replication layer (untracked, cross-user risk) → removed~~ **Closed 2026-10-01:** removed from DEV (ledger `20261001232645`); never present in PROD | SEC/DEF | security | — | [WORK-169](https://linear.app/catalyst-app-development/issue/WORK-169) (completed) | No (DEV only; nothing to promote) | No | E1, D5 |
| G15 | Payments dark; reconciliation sees SB/MD only → enabled only after prerequisites | APG | product | High if early | [WORK-175](https://linear.app/catalyst-app-development/issue/WORK-175) (Backlog, blocked by WORK-165, WORK-166) | Yes | Operator go decision | E1, D6 |
| G16 | OCR dark, PII/retention unresolved → policy first; OCR off outside DEV until approved | EVID | product / security | Med | [WORK-176](https://linear.app/catalyst-app-development/issue/WORK-176) (Backlog) | Yes (to enable) | **Yes** | E1, D7 |
| G17a | No user-data export → full CSV/JSON export | FUT | product | Low | [WORK-177](https://linear.app/catalyst-app-development/issue/WORK-177) (Backlog) | Later | No | A (D8) |
| G17b | No Sheets backup → user-controlled structured Google Sheets backup | FUT | product | Low | [WORK-178](https://linear.app/catalyst-app-development/issue/WORK-178) (Backlog) | Later | Yes (cadence/target) | A (D8) |
| G17c | No calendar sync → dedicated FAT-managed work-shift calendar | FUT | product | Low | [WORK-179](https://linear.app/catalyst-app-development/issue/WORK-179) (Backlog) | Later | Yes (event scope) | A (D8) |
| G18 | Ledger drift (dup 19, out-of-band 19/20, abandoned dual_write/ffh) → ledger = repo | SEC/DEF | data | Med | [WORK-180](https://linear.app/catalyst-app-development/issue/WORK-180) (Backlog) | Only for any PROD record fix | No | E1 |
| G19 | No test runner / build CI on `dev` → tests + CI | SEC/DEF | testing | Med | [WORK-181](https://linear.app/catalyst-app-development/issue/WORK-181) (Backlog) | No | No | E1 |
| G20 | Stale/contradictory docs → reconciled to `docs/architecture/` | DOC | documentation | Med | WORK-164 (pointers, Active); [WORK-185](https://linear.app/catalyst-app-development/issue/WORK-185) (residual, Backlog) | No | No | E1 trust map |
| G21 | Vercel preset CRA; env vars unverified → audited, corrected | SEC/DEF | deployment | Med | [WORK-182](https://linear.app/catalyst-app-development/issue/WORK-182) (Backlog) | Yes (if changed) | Operator dashboard | E1 |
| G23 | 7 manifest validation findings; stale Linear label → clean | DOC | governance | Low | [WORK-183](https://linear.app/catalyst-app-development/issue/WORK-183) (Backlog) | No | No | WORK-163/110 discoveries |
| G24 | Phantom `payment_components` write, dead code, committed local settings → removed | SEC/DEF | architecture | Low | [WORK-184](https://linear.app/catalyst-app-development/issue/WORK-184) (Backlog) | No | No | E1 |
| G25 | Leaked-password protection off (shared auth) → on | SEC/DEF | security | Med | [WORK-186](https://linear.app/catalyst-app-development/issue/WORK-186) (Backlog, Shared scope) | Yes | No | E1 advisors |
| G26 | Manifest only, no SW, installability unverified → verified installable mobile-first PWA | SEC/DEF | product | Low | [WORK-187](https://linear.app/catalyst-app-development/issue/WORK-187) (Backlog) | Later | No | E1, D9i |

### Not a model gap (justified)

| ID | Item | Why it is not owned here |
|---|---|---|
| G22 | `main` (`0f80f5b`) lags `dev` (governance/docs/SQL only; no app-code delta) | Release mechanics, not an architecture difference; promotion is governed by CLAUDE.md §4 and needs Danny's explicit approval. `docs/PROD_ROLLOUT_CHECKLIST.md` must be rewritten first (WORK-185). |

## Implementation ordering (D9g)

```
Tier 0 — independent, can start now
  WORK-169 (G14, done)  WORK-180 (G18)  WORK-181 (G19)  WORK-182 (G21)  WORK-183 (G23)
  WORK-184 (G24)  WORK-185 (G20)  WORK-187 (G26)  WORK-174 (G12)
  WORK-170 (G13 evidence)  WORK-176 (G16 policy)
  WORK-177 / 178 / 179 (G17 — do not depend on Phase 3; must respect isolation)
        │
Tier 1 — PROD parity & security (precedes every tier below)
  WORK-165 (G01/G02)  WORK-166 (G03/G04)  WORK-167 (G05)
  WORK-144 → WORK-145 (G06)  WORK-186 (G25)
        │
Tier 2 — revised target & rules
  WORK-171 (G09/G10 plan)  WORK-172 (G11)
        │
Tier 3 — generators
  WORK-173 (G08; SB/M&D gating needs WORK-170)
        │
Tier 4 — cutover execution (WORK-189…195 = C1–C7, see CUTOVER_PLAN.md): transform-copy +
          parity, single payment truth, prototype read-only → retired
        │
Tier 5 — Payments activation: WORK-175 (G15)
        │
Tier 6 — legacy retirement: WORK-168 (G07; after WORK-145 and verified archive)
```

Rule: **no Phase-3 activation, canonical cutover or Payments enablement before Tier 1 is
complete.**

## Residual open questions (owned, not hidden)

- Exact SB/M&D excess-travel eligibility rule — WORK-170.
- Authoritative current rate values and effective dates — WORK-172.
- Payslip PII/retention policy — WORK-176.
- Sheets cadence/target, calendar event scope — WORK-178, WORK-179.
- PostgREST exposed-schema list, Vercel env inventory — WORK-144, WORK-182.

## Maintenance

When an owner Issue completes: verify the new reality, update `CURRENT_MODEL.md`, close or
amend the row here, and confirm `PROJECTED_MODEL.md` still matches. New gaps require an
owner before they are added; Projected changes require recorded operator approval.
