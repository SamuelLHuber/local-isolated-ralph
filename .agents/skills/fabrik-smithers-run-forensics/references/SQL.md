# Smithers DB SQL snippets

Database path on run PVC is usually:

- `/workspace/.smithers/state.db`

## Table discovery

```sql
select name from sqlite_master where type='table' order by name;
```

## Recent runs

```sql
select run_id, status, started_at_ms, finished_at_ms, error_json
from _smithers_runs
order by created_at_ms desc
limit 10;
```

## Node attempts for one run

```sql
select node_id, iteration, attempt, state, started_at_ms, finished_at_ms, error_json
from _smithers_attempts
where run_id = ?
order by started_at_ms;
```

## Active progress check (stuck vs slow)

```sql
select node_id, iteration, attempt, state, started_at_ms, finished_at_ms, error_json
from _smithers_attempts
where run_id = ?
order by started_at_ms desc
limit 10;
```

Interpretation:
- iteration increasing over time => healthy progress (possibly slow)
- same node+iteration repeated with failures => retry loop / potential stuck state

## Failure attempts for one run

```sql
select node_id, iteration, attempt, error_json
from _smithers_attempts
where run_id = ? and state = 'failed'
order by started_at_ms desc;
```

## Event type counts

```sql
select type, count(*) as c
from _smithers_events
where run_id = ?
group by type
order by c desc;
```

## Last events

```sql
select seq, timestamp_ms, type, payload_json
from _smithers_events
where run_id = ?
order by seq desc
limit 20;
```

## Python helper skeleton

```python
import sqlite3, json
conn = sqlite3.connect('/workspace/.smithers/state.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
run_id = cur.execute(
    'select run_id from _smithers_runs order by created_at_ms desc limit 1'
).fetchone()['run_id']

for row in cur.execute(
    'select node_id, iteration, attempt, state, error_json from _smithers_attempts where run_id=? order by started_at_ms',
    (run_id,)
):
    d = dict(row)
    if d['error_json']:
        try:
            d['error_json'] = json.loads(d['error_json'])
        except Exception:
            pass
    print(d)
```

## Alternative: Using bun:sqlite (available in smithers image)

When sqlite3/python unavailable, use bun runtime:

```bash
kubectl exec pod/<POD> -c fabrik -- sh -lc 'bun -e '\''import { Database } from "bun:sqlite"; const db=new Database("/workspace/.smithers/state.db",
{readonly:true}); const rows=db.query("select node_id, iteration, attempt, state from _smithers_attempts where run_id=? order by started_at_ms desc limit
10").all("<run>"); for (const r of rows) console.log(JSON.stringify(r));'\'''
```
