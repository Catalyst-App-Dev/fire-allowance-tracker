# FAT Neon backend artifacts

Repository-controlled SQL for FAT's application-owned Neon backend (WORK-254). Design and the
Supabase → Neon adaptation matrix: [`docs/architecture/NEON_BACKEND.md`](../docs/architecture/NEON_BACKEND.md).
The target is declared in [`.catalyst/app.yml`](../.catalyst/app.yml) `backend:`.

| Path | Purpose |
|---|---|
| `migrations/` | Ordered schema migrations `YYYYMMDDHHMMSS_fat_<name>.sql` (forward-only; never edit an applied file) |
| `rollbacks/` | One `<same>.rollback.sql` per migration; destructive ones say so at the top |
| `dev-seed/` | Synthetic DEV fixtures (data-load operations). **Never applied to `main`** |
| `verify/fat_neon_verify.sql` | 62 behavioural checks, each in an always-rolled-back sub-transaction |
| `verify/fat_catalog_fingerprint.sql` | Read-only catalog fingerprint; runs unchanged on Neon and Supabase |

## Applying a migration (governed)

Merging is not applying. Each apply is a separate, deliberate act on one declared target:

1. Fresh provider read of the target branch (Neon `list_branches` / `describe_branch`).
2. `node governance-v2/scripts/backend-preflight.js preflight <request.json> --manifest .catalyst/app.yml`
   with the exact app, provider `neon`, project, target, operation (`schema-migration` or
   `data-load`) and change id (the migration version, or the data-load change id). Must return
   `allow`. A `main` (prod) target additionally needs verified DEV evidence for the same change,
   a named rollback and explicit Production clearance for that exact operation.
3. Execute the file inside the checksum-guarded block below, so the database refuses anything
   that is not byte-identical to the repository file and records the ledger row atomically:

   ```sql
   do $fatapply$
   declare
     src text := $fatsrc$<exact file content>$fatsrc$;
     v_sum text := 'sha256:' || encode(sha256(convert_to(src, 'UTF8')), 'hex');
   begin
     if v_sum <> 'sha256:<sha256 of the file>' then
       raise exception 'checksum mismatch: %', v_sum;
     end if;
     execute src;
     insert into fat_migrations.schema_migrations (version, name, checksum)
     values ('<version>', '<name>', v_sum);
     -- data loads: insert into fat_migrations.data_loads (change_id, kind, checksum) ...
   end;
   $fatapply$;
   ```

4. Read `fat_migrations.schema_migrations` (or `data_loads`) back from the same target and run
   `backend-preflight.js verify-applied` with that history. Must return `verified`.

## Verifying

- `verify/fat_neon_verify.sql` (owner session, one transaction): every row `ok = t`; leaves no
  rows, grants or settings behind.
- `verify/fat_catalog_fingerprint.sql`: compare against a fresh empty-database replay (identical)
  and against Supabase DEV (differences limited to NEON_BACKEND.md §4).

## C2/C3 transform-copy (WORK-255)

The cross-database C2/C3 tool (`scripts/c2-transform.mjs`, tool 2.0.0) writes its batches to a
Neon target as **data loads** keyed by the plan's change id (`fat-c2-<env>-<fp24>`): preflight
`data-load` with that id, run `apply.sql` (one transaction; its transport and stale guards refuse
anything but the reviewed plan against the reference it was planned on), then `verify-applied`
against `fat_migrations.data_loads`. `verify.sql` runs as `data-write` (read-only apart from a
rolled-back RLS probe). `rollback.sql` removes only that batch and records
`<change id>-rollback`. Procedure and evidence: `docs/architecture/C2_TRANSFORM_CONTRACT.md` § 11,
`docs/evidence/WORK-255/`.
