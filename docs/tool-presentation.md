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

## Codex web calls

Codex 0.163.0's generated app-server schema includes search, open-page and find-in-page actions.
The initial item can lack its final arguments. Completion refreshes the journal input before
recording the output, preserving action fields and multiple queries. A null action query cannot
erase a nonempty item query. Older calls recover these same arguments from the final output when
available, including after loading an expanded tool body; collapsed rows never fetch extra bodies.
Structured web results retain the generic JSON view instead of displaying a false “no results”.

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


## Human descriptions and lifecycle audit (October 23)

The collapsed summary prefers information authored for humans, without another model call:

1. A known per-call description (`Bash`, `Agent`/`Task` input.description).
2. A human title supplied by the harness, stored separately in `presentation.title`.
3. A concrete action/target: Codex command analysis, edit paths, search queries, URL, shell
   command, task subject/ID, skill name, resource URI, hook source or sleep duration.
4. ACP locations when no more specific target is available. Unknown arguments retain generic/raw
   details; no description is invented from an arbitrary object or a created resource's body.

All six styles use the same summary provider. Human labels remain prose, targets remain monospace.
Static connector action labels are distinct from per-call descriptions: a label such as “Search
issues” must not hide the query in the summary. The actual command/arguments stay accessible in readable and raw details even when a title is shown.

| Source checked | Retained information and lifecycle |
| --- | --- |
| Claude Code 2.1.301 / SDK 0.3.301 | Assistant tool_use already contains full arguments; Bash/Agent descriptions survive unchanged. TaskCreate/Update use subject before their long description, task lookup/output/stop show IDs. Read/Edit/Write, NotebookEdit, Glob/Grep, web calls, skills and MCP resource URIs retain their targets. |
| Codex 0.163.0 app-server schema | Final tool arguments refresh before completion for command, file, web, MCP, dynamic, collaboration and image calls. Open-page completion can refine WebSearch into WebFetch. commandActions describes a single known read/list/search; compound or unknown commands retain the command. appContext.actionName supplies a human MCP label while the summary keeps its query/target. Dynamic calls and hooks remain native, not MCP just because their names include a slash. |
| OpenCode 1.19.3 live OpenAPI | Running/completed state.title is retained even if input never changes. A later error without a title preserves the latest one. Input fields remain normalized; Skill.name becomes skill. |
| Grok Build 1.0.62 / ACP schema | Human title and locations are independent updates, not tool identity or model arguments. Late programmatic name/MCP wrapper input can refine the canonical tool name. Partial ACP updates preserve the latest supplied rawInput value; absent/null fields do not erase it. Content/rawOutput received before a status-only completion remain available; repeated completions do not recreate empty calls. |

`presentation` is optional for old journals; input updates may refine `name` and presentation
without changing call identity, time, parent or grouping. Unknown metadata is never read as an
input field. Codex's native completion is retained once for synthesized input refreshes, avoiding
another copy of large output/images in raw journal entries.

### Large bodies and history

The bounded SQLite transport projection now retains notebook paths, task IDs, skills, resource
URIs, query arrays, edit paths and parsed-command identifiers. Large legacy Codex web outputs
retain a small query/action preview too, so their row can recover the search without fetching
the result body. Nested previews keep at most 20
entries and 512 characters per textual field; they never include partial diffs/content from which
misleading line counts could be calculated. Complete arguments remain available on expansion.
The disposable thread projection version is bumped and rebuilt lazily in bounded batches; no
journal rewrite, database migration or eager fetch of collapsed bodies is introduced.

Previously discarded OpenCode/Grok titles cannot be restored from normalized history alone. New
events preserve them; old calls keep their argument-based fallback. Codex web calls can recover
final arguments from their structured result, as described above.

### Audit evidence and limits

Installed versions were checked directly. Codex generated its schema under
`/var/tmp/sillage-websearch-codex-schema`; OpenCode's `opencode:types:check` launched a disposable
instance and confirmed current bindings. A disposable server's `/experimental/tool` inventory
confirmed the actual built-in parameter schemas for the Anthropic/Sonnet model: `skill.name`,
`task.description`, camelCase file fields, and notably **no Bash description argument** in this
OpenCode version (its human title must come from tool state). The bounded report is retained at
`/var/tmp/sillage-tool-audit-opencode-tools.json`. Claude descriptions were checked against installed SDK
tool types, including the Bash human-description contract. Grok's installed CLI version and ACP
schema were checked. No new paid model conversation or exhaustive third-party MCP catalogue was
executed: arbitrary MCP payloads keep generic/raw fallbacks.

Regression checks cover adapter events, schema parsing, live folding/replay, title-only updates,
late names, status-only completion, body references and persisted projection rebuilds. Browser
checks cover six styles on desktop/mobile, raw command access behind descriptions, all existing
scroll/grouping rules and deferred output fetching. The normalized events and renderer are shared
by Server and Desktop; authentication, permissions and Electron behavior are unchanged.
