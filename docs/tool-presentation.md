# Tool presentation across CLIs

The journal normalizes tool names and inputs at the adapter boundary. Conversation summaries,
edit counters and expanded views consume that journal, keeping native payloads accessible through
the raw view. Do not guess a CLI from a filename or a translated tool title.

## Formats reviewed

| CLI | Native input | Journal and presentation |
| --- | --- | --- |
| Claude Code | `Edit` with `file_path`, `old_string`, `new_string`, optional `replace_all` | File path; counts from changed excerpt lines; before/after view. |
| Codex | `fileChange` with `changes[]` (`path`, `kind`, `diff`) | `Edit`; all affected paths; aggregate counters; unified diff for updates, content for additions/deletions. Final completion refreshes the input even without `patchUpdated`. |
| OpenCode | `edit` with `filePath`, `oldString`, `newString`, `replaceAll` | Normalized to Claude-style `Edit`; same summary, counters and details. |
| OpenCode | `apply_patch` with `patchText` | `ApplyPatch` with `patch`; file/move directives supply paths; addition/removal lines supply counts; readable patch view. |
| Grok Build | `search_replace`, with `file_path` or `path`, old/new strings, optional Rust `variant` | Normalized to `Edit`; the adapter removes `variant`; same excerpt counters and details. |

Known native read, write, shell, search, image, task, notebook and skill inputs retain their
identifying fields. Search summaries prioritize the pattern over the directory. Numeric MCP card
identifiers are displayable. Unknown tools and payloads keep the generic and raw views.

MCP names arrive as `mcp__server__tool` (Claude), `server/tool` (Codex and normalized adapters),
`server_tool` (OpenCode, resolved against known servers), or `use_tool` with `server__tool` (Grok).
Sillage keeps its logo, primary color and friendly label. Other MCP servers keep their server badge.
Codex's internal `Collaboration/…` and `Codex/…` namespaces are native, not MCP servers.

Text results may be strings, content-block arrays or MCP `{content: [...]}` envelopes. Readable
views and compact previews accept all three. Compact previews stop after 500 characters; they do
not concatenate an entire large output just to display one line. Raw and structured results remain
available when opening the tool.

## Counter semantics

- Every style uses the same `+N` / `−N` row counters, including on phones.
- `Write` shows only green `+N`: the number of lines written, including when overwriting a file.
  Its accessible label and tooltip explain that this is not a net diff against previous contents.
  Empty content shows `+0`; missing content and failed/interrupted writes show no counter.
- Unified patches count changed lines, excluding headers and context. Codex add/delete changes
  contain raw file content, so count their actual lines rather than interpreting them as patches.
- Excerpts use the same line alignment as server-generated diffs. A trailing newline is not an
  extra line. Unchanged context does not contribute to either counter.
- `replace_all` counts describe **one replacement**, not the whole file. The accessible label and
  tooltip explicitly say the occurrence count is unavailable.
- Running calls describe proposed changes. Failed/interrupted calls never claim applied changes.
- Missing/malformed data, a deletion directive without old content, and comparisons beyond the
  bounded work budget omit counters. They must not invent zeroes or full-file totals. Writes that
  replace a file without its previous contents likewise cannot supply a deletion count.
- No additional output requests are made for collapsed rows. Old Codex journals can use final
  changes from output when available; current events also retain them in the normalized input.

## Verification

The October 23, 2026 review checked installed versions: Claude Code 2.1.301, Codex 0.163.0,
OpenCode 1.19.3, and managed Grok Build 1.0.62. Codex's installed binary generated the app-server
JSON schema, confirming file-change and MCP result shapes. This review did not execute fresh
model conversations on all four CLIs; adapter fixtures and journal replay cover their normalized
formats, with earlier live probes documented beside the adapters.

`apps/server/test/tool-presentation.test.ts` checks adapter-to-presentation compatibility, Codex
completion/replay, excerpt counts, patches, malformed inputs, bounded work and MCP envelopes.
`pnpm test:tool-styles-ui` checks all six styles at desktop and phone widths, including visible
counters, readable diffs, failed edits, grouping and scroll stability. The Codex, OpenCode and Grok
UI scripts cover their interactive thread flows. These components are shared by Server and Desktop;
no authentication or edition-specific behavior changes.
