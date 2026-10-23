"""Copy selected journals into an already migrated disposable audit database.

Source is read-only. Credentials, automation and project files are excluded.
AUDIT_NATIVE_TOOL=1 includes native events for the first tool call in each journal;
otherwise raw events are omitted. Do not point the target at a real user database.
"""
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

source, target, workspace, *ids = sys.argv[1:]
assert Path(source).resolve() != Path(target).resolve()
src = sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True)
src.row_factory = sqlite3.Row
dst = sqlite3.connect(target)
assert dst.execute('select count(*) from users').fetchone()[0] == 0
now = int(time.time() * 1000)
dst.execute('insert into users values (?,?,?,?,?,?)', ('audit', 'audit', 'unused', 'Performance audit', 1, now))
dst.execute('insert into projects (id,name,workspace_path,owner_id,visibility,created_at,instructions_mode,memory_mode,turn_checkpoints) values (?,?,?,?,?,?,?,?,?)', ('audit', 'Performance audit', workspace, 'audit', 'private', now, 'repo', 'native', 0))
for index, conversation in enumerate(ids):
    row = dict(src.execute('select * from conversations where id=?', (conversation,)).fetchone())
    row.update(project_id='audit', user_id='audit', worktree_id=None, title=f'Audit {index + 1}', archived_at=None, status='idle', agent_session_id=None, forked_from_id=None, handoff_from_id=None, card_id=None, schedule_id=None, created_by_token_id=None, background_count=0, loop_count=0)
    dst.execute(f'insert into conversations ({",".join(row)}) values ({",".join("?" for _ in row)})', list(row.values()))
    # Iterate rows instead of holding a complete heavy conversation in Python.
    dst.executemany('insert into events (conversation_id,seq,ts,type,payload) values (?,?,?,?,?)', src.execute('select conversation_id,seq,ts,type,payload from events where conversation_id=?', (conversation,)))
    if os.environ.get('AUDIT_NATIVE_TOOL') == '1':
        first = src.execute("select payload ->> '$.toolCallId' from events where conversation_id=? and type='tool.started' order by seq limit 1", (conversation,)).fetchone()
        if first:
            rows = src.execute("select raw,raw_format,conversation_id,seq from events where conversation_id=? and type in ('tool.started','tool.completed') and payload ->> '$.toolCallId' = ?", (conversation, first[0]))
            dst.executemany('update events set raw=?,raw_format=? where conversation_id=? and seq=?', rows)
    print(json.dumps({'id': conversation, 'agent': row['agent'], 'lastSeq': row['last_seq']}), flush=True)
dst.commit()
dst.close()
src.close()
