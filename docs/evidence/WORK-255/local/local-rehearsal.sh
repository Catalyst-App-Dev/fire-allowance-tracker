#!/bin/bash
# Full WORK-255 rehearsal on the LOCAL replica of the Neon schema (migrations 1-6 + WORK-254 seed).
set -u
cd /home/user/worktrees/WORK-255
W=/var/tmp/n3/local; rm -rf $W; mkdir -p $W
P="psql -h /var/tmp/fatpg -p 55432 -U neondb_owner -d neondb -q -t -A -v ON_ERROR_STOP=1"
C="node scripts/c2-transform.mjs"; PL="--env dev --project cool-meadow-70196410 --target-name dev --target-id br-wispy-dew-a7vd4v6k --evidence synthetic"
q() { "$@" 2>/dev/null; }
step() { echo "== $*"; }
q $C synthetic-source --out $W/source-A.json
q $C synthetic-source --out $W/source-B.json --mutate sm-amount
q $C target-extract-sql --source $W/source-A.json > $W/target-extract-A.sql
$P -f $W/target-extract-A.sql > $W/target-A0.json
step plan A; q $C plan --source $W/source-A.json --target $W/target-A0.json $PL --out $W/planA | python3 -c "import json,sys;r=json.load(sys.stdin);print(r['batch_key'],r['change_id'],r['outcome'],r['admission'],r['plan_sha256'])"
step apply 1; $P --single-transaction -f $W/planA/apply.sql > $W/apply1.json; cat $W/apply1.json | head -c 300; echo
step apply 2 identical; $P --single-transaction -f $W/planA/apply.sql > $W/apply2.json; python3 -c "import json;r=json.load(open('$W/apply2.json'));print({k:v for k,v in r.items() if isinstance(v,dict)}, r['batch_inserted'], r['data_load_inserted'])"
step verify; $P --single-transaction -f $W/planA/verify.sql > $W/verify1.json; q $C check --plan $W/planA/plan.json --verify $W/verify1.json | tr -d '\n '; echo
$P -f $W/target-extract-A.sql > $W/target-A1.json; step admit after apply; q $C admit --plan $W/planA/plan.json --target $W/target-A1.json | python3 -c "import json,sys;r=json.load(sys.stdin);print(r['verdict'],r['present'])"
step changed source B; q $C target-extract-sql --source $W/source-B.json > $W/target-extract-B.sql; $P -f $W/target-extract-B.sql > $W/target-B.json; q $C plan --source $W/source-B.json --target $W/target-B.json $PL --out $W/planB | python3 -c "import json,sys;r=json.load(sys.stdin);print(r['batch_key'],r['admission'])"
python3 - <<'PY'
import json
s=json.load(open('/var/tmp/n3/local/source-A.json'))
g=[x for x in s['tables']['claim_groups'] if x['id']=='5eed0255-0000-4000-8000-0000000e0001'][0]; g['notes']+=' (changed)'
m={'schema':s['schema'],'provider':'supabase','tables':{t:[] for t in s['tables']},'reference':{'profiles':[p for p in s['reference']['profiles'] if p['id']==g['user_id']],'stations':[],'member_classifications':[]}}
m['tables']['claim_groups']=[g]; m['tables']['financial_years']=[f for f in s['tables']['financial_years'] if f['user_id']==g['user_id']]
m['tables']['claim_sequences']=[q for q in s['tables']['claim_sequences'] if q['user_id']==g['user_id']]
json.dump(m,open('/var/tmp/n3/local/source-Cm.json','w'),sort_keys=True,separators=(',',':'))
PY
q $C target-extract-sql --source $W/source-Cm.json > $W/target-extract-Cm.sql; $P -f $W/target-extract-Cm.sql > $W/target-Cm.json
step changed empty group minimal Cm; q $C plan --source $W/source-Cm.json --target $W/target-Cm.json $PL --out $W/planCm | python3 -c "import json,sys;r=json.load(sys.stdin);print(r['batch_key'],r['admission'])"; $P --single-transaction -f $W/planCm/apply.sql 2>&1 | grep -o "ERROR:.*" | head -1
python3 -c "import json;t=json.load(open('$W/target-Cm.json'));t['reference_md5']='0'*32;json.dump(t,open('$W/target-Cm-stale.json','w'))"
step stale plan; q $C plan --source $W/source-Cm.json --target $W/target-Cm-stale.json $PL --out $W/planStale | python3 -c "import json,sys;r=json.load(sys.stdin);print(r['batch_key'],r['admission'])"; $P --single-transaction -f $W/planStale/apply.sql 2>&1 | grep -o "ERROR:.*" | head -1
step rollback; $P --single-transaction -f $W/planA/rollback.sql | tee $W/rollback.json
step residue; $P -f $W/planA/residue.sql | tee $W/residue.json
$P -f $W/target-extract-A.sql > $W/target-A2.json; step admit after rollback; q $C admit --plan $W/planA/plan.json --target $W/target-A2.json | python3 -c "import json,sys;r=json.load(sys.stdin);print(r['verdict'],r['present'])"
step rerun after rollback; $P --single-transaction -f $W/planA/apply.sql > $W/apply3.json; python3 -c "import json;r=json.load(open('$W/apply3.json'));print({k:v.get('inserted',v.get('linked')) for k,v in r.items() if isinstance(v,dict)})"
step verify 2; $P --single-transaction -f $W/planA/verify.sql > $W/verify2.json; q $C check --plan $W/planA/plan.json --verify $W/verify2.json | tr -d '\n '; echo
step work-254 suite; $P --single-transaction -f neon/verify/fat_neon_verify.sql | awk -F'|' '{n++; if($2=="t")ok++}END{print ok"/"n}'
