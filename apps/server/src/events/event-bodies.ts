import { sql, type SQL } from 'drizzle-orm'
import { events } from '@sillage/db'
import type { SillageEvent } from '@sillage/protocol'
import { MAX_OUTPUT_BYTES, replayWeight } from './tool-output.js'

/** Opt-in transport projection. Stored events and CLI/native readers remain lossless.
 * SQLite drops bodies before they cross into JS; references identify an immutable event,
 * not a tool ID that a later turn may reuse. */
const ref = (field: string, block?: SQL) => sql`json_object('seq', ${events.seq}, 'field', ${field}${block ? sql`, 'block', ${block}` : sql``})`
const scalarPreview = (input: SQL) => sql`case when json_type(${input}) = 'object' then
  (select json_group_object(key, case when type = 'text' then substr(case when key = 'check_script' then ltrim(value, ' ' || char(9) || char(10) || char(13)) else value end, 1, 512) else value end)
   from json_each(${input}) where key in ('description', 'command', 'file_path', 'path', 'notebook_path', 'file', 'title', 'subject', 'query', 'pattern', 'prompt', 'card_number', 'number', 'issue_number', 'conversation_id', 'url', 'uri', 'server', 'subagent_type', 'check_script', 'skill', 'name', 'source', 'taskId', 'task_id', 'id', 'durationMs', 'type')
     and type in ('text', 'integer', 'real', 'true', 'false', 'null')) else null end`
/** Arrays are bounded identifiers, not truncated patches or file contents. Full bodies stay lazy. */
const identifiers = (input: SQL, key: string, entry: SQL, type: string) => sql`case when json_type(${input}, ${'$.' + key}) = 'array' then
  json_object(${key}, json((select json_group_array(json(entry)) from
    (select ${entry} as entry from json_each(${input}, ${'$.' + key}) j where j.type = ${type} limit 20)))) else '{}' end`
const shortField = (key: string) => sql`case when json_type(j.value, ${'$.' + key}) = 'text' then substr(j.value ->> ${'$.' + key}, 1, 512) end`
const preview = (input: SQL) => sql`json_patch(json_patch(json_patch(${scalarPreview(input)},
  ${identifiers(input, 'changes', sql`json_object('path', ${shortField('path')})`, 'object')}),
  ${identifiers(input, 'queries', sql`json_quote(substr(j.value, 1, 512))`, 'text')}),
  ${identifiers(input, 'commandActions', sql`json_object('type', ${shortField('type')}, 'path', ${shortField('path')}, 'name', ${shortField('name')},
    'query', ${shortField('query')}, 'command', ${shortField('command')})`, 'object')})`
const input = sql`${events.payload} -> '$.input'`
const output = sql`${events.payload} -> '$.output'`
// Keep just enough text for collapsed summaries and the schedule approval shortcut.
const textOutputPreview = sql`substr(case
  when json_type(${events.payload}, '$.output') = 'text' then ${events.payload} ->> '$.output'
  when json_type(${events.payload}, '$.output[0].text') = 'text' then ${events.payload} ->> '$.output[0].text'
  when json_type(${events.payload}, '$.output.content[0].text') = 'text' then ${events.payload} ->> '$.output.content[0].text'
  end, 1, 512)`
// Keep final Codex web arguments in older journals even when their results remain lazy.
// JSON encoding preserves structured previews while ordinary text stays a string.
const outputPreview = sql`case when json_type(${output}, '$.query') = 'text'
  and json_type(${output}, '$.action') in ('object', 'null') and json_type(${output}, '$.results') in ('array', 'null') then
  json_object('query', substr(${output} ->> '$.query', 1, 512), 'action', json(${preview(sql`${output} -> '$.action'`)}), 'results', null)
  else json_quote(${textOutputPreview}) end`
const blocks = sql`(select json_group_array(json(case
  when b.value ->> '$.type' = 'image' and substr(b.value ->> '$.url', 1, instr(b.value ->> '$.url', ',') - 1) in ('data:image/png;base64', 'data:image/jpeg;base64', 'data:image/gif;base64', 'data:image/webp;base64', 'data:image/avif;base64') then
    json_set(b.value, '$.url', '/api/conversations/' || ${events.conversationId} || '/events/' || ${events.seq} || '/images/' || b.key,
      '$.imageHeader', substr(b.value ->> '$.url', 1, 2048))
  when b.value ->> '$.type' = 'tool_use' and octet_length(b.value -> '$.input') > ${MAX_OUTPUT_BYTES} then
    json_set(b.value, '$.input', json(${preview(sql`b.value -> '$.input'`)}), '$.inputRef', json(${ref('input', sql`b.key`)}))
  when b.value ->> '$.type' = 'tool_result' and (octet_length(b.value -> '$.output') > ${MAX_OUTPUT_BYTES} or instr(b.value -> '$.output', '"image"') > 0) then
    json_set(b.value, '$.output', null, '$.outputRef', json(${ref('output', sql`b.key`)}))
  else b.value end)) from json_each(${events.payload}, '$.blocks') b)`

export const bodyPayload = sql<string>`case
  when ${events.type} = 'message.completed' and json_type(${events.payload}, '$.blocks') = 'array'
    and not exists (select 1 from json_each(${events.payload}, '$.blocks') b where b.type <> 'object') then json_set(${events.payload}, '$.blocks', json(${blocks}))
  when ${events.type} in ('tool.started', 'tool.input_updated') and octet_length(${input}) > ${MAX_OUTPUT_BYTES} then
    json_set(${events.payload}, '$.input', json(${preview(input)}), '$.inputRef', json(${ref('input')}))
  when ${events.type} = 'tool.completed' and (octet_length(${output}) > ${MAX_OUTPUT_BYTES} or instr(${output}, '"image"') > 0) then
    json_set(${events.payload}, '$.output', json(${outputPreview}), '$.outputBytes', octet_length(${output}), '$.outputRef', json(${ref('output')}))
  when ${events.type} = 'diff.updated' and octet_length(${events.payload} -> '$.patch') > ${MAX_OUTPUT_BYTES} then
    json_set(${events.payload}, '$.patch', '', '$.patchRef', json(${ref('patch')}))
  else ${events.payload} end`

/** A conservative bound keeps listing cheap. Computing the full projection here would parse
 * giant images twice and even parse superseded patches that the next step discards. The
 * subsequent read projects only retained rows; recent-turn projections can reduce page count. */
export const bodyWeight = replayWeight

/** Only a small image header leaves SQLite. Reserve dimensions before the lazy request arrives. */
export function imageDimensions(header: string): { width: number; height: number } | undefined {
  const comma = header.indexOf(',')
  if (comma < 0 || !header.slice(0, comma).endsWith(';base64')) return
  const data = Buffer.from(header.slice(comma + 1), 'base64')
  let width = 0, height = 0
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20)
  } else if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString())) {
    width = data.readUInt16LE(6); height = data.readUInt16LE(8)
  } else if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16)
    if (kind === 'VP8X') { width = 1 + data.readUIntLE(24, 3); height = 1 + data.readUIntLE(27, 3) }
    else if (kind === 'VP8 ') { width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff }
    else if (kind === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1
    }
  } else if (data[0] === 0xff && data[1] === 0xd8) {
    for (let offset = 2; offset + 9 < data.length;) {
      if (data[offset] !== 0xff) break
      const marker = data[offset + 1]!
      if (marker === 0xd9 || marker === 0xda) break
      const length = data.readUInt16BE(offset + 2)
      if (length < 2) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = data.readUInt16BE(offset + 5); width = data.readUInt16BE(offset + 7); break
      }
      offset += 2 + length
    }
  }
  return width > 0 && height > 0 ? { width, height } : undefined
}

export function prepareBodyPayload(payload: string): unknown {
  const event = JSON.parse(payload) as SillageEvent | null
  if (event?.type === 'message.completed' && Array.isArray(event.blocks)) {
    for (const block of event.blocks) {
      if (block?.type !== 'image') continue
      const image = block as typeof block & { imageHeader?: string }
      if (image.imageHeader) Object.assign(image, imageDimensions(image.imageHeader))
      delete image.imageHeader
    }
  }
  return event
}
