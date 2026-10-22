import { sql } from 'drizzle-orm'
import { events } from '@sillage/db'

/** Large tool outputs omitted from replay pages. Long conversations are primarily a byte problem: the largest journal contains 22 MB of `tool.completed` among 32 MB total; 317 outputs above 8 KB account for 16.6 MB, including one of 649 KB. Remote transfers dominate waiting rather than replay. Full output remains in journals and cards fetch it on expansion (`GET /api/conversations/:id/tools/:toolCallId/output`). Omit rather than preview: cards display nothing until complete bodies arrive, and previews caused broken-image flicker while adding weight. Filter in SQLite rather than JS: reading 6 MB merely to discard it still costs daemon memory and fills byte-bounded pages with content never sent, increasing page counts. */

/** Larger outputs are omitted from replay; ordinary results still arrive with conversations. */
export const MAX_OUTPUT_BYTES = 8192

/** JSON output size clients would otherwise receive. */
const outputBytes = sql`octet_length(${events.payload} -> '$.output')`

/** Replay payload: journal content excluding outputs above the limit, with `outputBytes` telling cards to fetch them. */
export const replayPayload = sql<string>`case
  when ${events.type} = 'tool.completed'
    and octet_length(${events.payload}) > ${MAX_OUTPUT_BYTES}
    and ${outputBytes} > ${MAX_OUTPUT_BYTES}
  then json_set(${events.payload}, '$.output', null, '$.outputBytes', ${outputBytes})
  else ${events.payload} end`

/** Estimated replay bytes without reading payloads. `tool.completed` stays below its output cap because remaining payload fields occupy only hundreds of bytes. */
export const replayWeight = sql<number>`case
  when ${events.type} = 'tool.completed'
  then min(octet_length(${events.payload}), ${MAX_OUTPUT_BYTES + 1024})
  else octet_length(${events.payload}) end`
