import { parentPort, workerData } from 'node:worker_threads'
import { isIP } from 'node:net'
import { lintSource } from '@secretlint/core'
import { rules } from '@secretlint/secretlint-rule-preset-recommend'

// Conversation text must never be able to suppress its own scan.
const config = { rules: rules.filter(rule => !rule.meta.id.endsWith('filter-comments'))
  .map(rule => ({ id: rule.meta.id, rule })) }
const patterns = [
  ['secret', /(?:authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?|(?:bearer|basic)\s+)([^\s"'<>]+)/gi],
  ['secret', /(?:(?<![\w.-])[\w.-]{0,128}(?:token|secret|password|passwd|api[_-]?key|credential)[\w.-]{0,128}["']?\s*[:=]\s*["']?|--(?:password|token|secret|api-key)\s+["']?)([^\s"',;<>]+)/gi],
  ['secret', /:\/\/[^/\s:@]+:([^@\s/]+)@/g],
  ['email', /(?<![a-z0-9.!#$%&'*+/=?^_{}|~-])([a-z0-9.!#$%&'*+/=?^_{}|~-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63})/gi],
  ['path', /((?:\/(?:home|Users)\/[^/\s"'<>]+|\/root|[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+)(?:[\\/][^\s"'<>),;]*)?)/gi],
  ['ip', /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})(?![\w.])/g],
  ['ip', /(?<![\w:])((?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]{0,45})(?![\w:])/gi],
]
const fields = workerData
const findings = []
const groups = new Map()
const seen = new Set()
const secretValues = new Set()
function add(field, start, end, kind) {
  if (end <= start || start < 0 || end > field.text.length) return
  const key = field.id + ':' + start + ':' + end
  if (seen.has(key)) return
  if (findings.length >= 50000) throw new Error('too_many_findings')
  seen.add(key)
  const value = field.text.slice(start, end)
  if (!groups.has(value)) groups.set(value, 'g' + (groups.size + 1))
  findings.push({ id: 'f' + (findings.length + 1), fieldId: field.id, start, end, kind, group: groups.get(value) })
  if (kind === 'secret' && value.length >= 6) secretValues.add(value)
}
try {
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const result = await lintSource({
      source: { content: field.text, filePath: '/conversation.txt', contentType: 'text' },
      options: { config, maskSecrets: true, noPhysicFilePath: true },
    })
    for (const message of result.messages) add(field, message.range[0], message.range[1], 'secret')
    for (const [kind, pattern] of patterns) {
      for (const match of field.text.matchAll(pattern)) {
        const value = match[1]
        if (!value || (kind === 'ip' && !isIP(value))) continue
        const start = match.index + match[0].lastIndexOf(value)
        add(field, start, start + value.length, kind)
      }
    }
    parentPort.postMessage({ progress: (i + 1) / Math.max(fields.length, 1) })
  }
  // A password identified in one command may be repeated without its key elsewhere.
  for (const field of fields) for (const value of secretValues) {
    let offset = 0
    while ((offset = field.text.indexOf(value, offset)) !== -1) {
      add(field, offset, offset + value.length, 'secret')
      offset += value.length
    }
  }
  parentPort.postMessage({ findings })
} catch {
  // Rules may embed source text in exception messages. Never relay these to logs.
  parentPort.postMessage({ failed: true })
}
