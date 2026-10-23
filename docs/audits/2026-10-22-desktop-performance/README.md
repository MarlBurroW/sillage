# Desktop performance audit — 22 October 2026

Audit baseline: `7b51e4ba0e2d58402919b15ff2ebd0049572a2c3`. The initial audit changed no application code. The user reported freezes, memory alerts and slow session opening on Windows Desktop and macOS Desktop (probably v0.22.0). All five implementation lots are documented below, based on `0821245a`.

Implementation follow-up: local board card #54, with the Claude transcript portion related to #17. All five lots are complete and approved for integration on October 23. The lot sections below preserve their validation checkpoints; statements about pending work or uncommitted changes describe the state at that checkpoint, not the final integration status. Native Windows/macOS trials remain outstanding.

The audit reproduces expensive shared code paths, an out-of-memory failure under the old Desktop heap limit, and unnecessary loading after navigation. It does not identify the exact alerts on the two users' machines: neither their logs nor their databases were available.

## Lot 1 implementation and verification

Prepared on `audit/desktop-performance`, without committing, publishing or restarting production. The changes apply to both Server and Desktop:

- Native tool lookup selects only the last nonempty raw start and completion for the requested call ID. Migration `0051_native_tool_lookup` adds a partial expression index after measurement showed that SQL filtering alone still scanned unrelated payloads. Reused IDs, absent raw, explicit JSON null and conversation boundaries retain the old behavior.
- Leaving a conversation aborts its HTTP request and pagination. Each hook subscription owns its replay state and cursor; overlapping catch-ups share one request chain. REST catch-up pauses live delivery, then resumes the WebSocket after the last examined sequence. Sparse or late frames trigger catch-up before their sequence can hide missing history. Snapshots are detached from subsequent fold mutations.
- The first socket connection no longer repeats the completed REST catch-up. Reconnection, partial failure, compacted cursor boundaries, old servers without `nextAfter`, late transport responses and React StrictMode have browser regression coverage.

These measurements use **Node 22.23.2**, matching the distribution's runtime family, Chromium 151.0.7922.34 and the same original-size journals as the audit. Inline images were restored after the earlier experiment; native payloads for the first tool call in each journal were also restored. CLIs remain disabled. Sanitized evidence: [lot1-measurements.json](lot1-measurements.json).

| Scenario | Before | After |
| --- | ---: | ---: |
| Native lookup, additional JS heap | 568.90 MiB | 0.27 MiB |
| Native lookup, elapsed time | 828 ms (380 ms in a repeat) | 4 ms |
| Native lookup with 256 MiB old-generation limit | Historical audit reproduced OOM | Succeeds and finds native payload |
| Requests started after navigating to Settings | 15 | 0, in both profiles |
| Cold A / B / C journal requests | 18 / 6 / 23 | 17 / 5 / 22 |
| Cached A / B journal requests | 2 / 2 | 1 / 1 |
| Cold A, usable thread | 2,486 ms | 2,347 ms Desktop; 2,349 ms Server |

The lookup's raw values were compared with the frozen pre-fix implementation on a real copied tool call and were deeply equal. The comparison itself used a separate 1 GiB probe; the corrected call also passed in a separate 256 MiB probe. Individual timings vary with filesystem cache and scheduling; these observations are not p95 values. Building the index took 380 ms on the three-journal fixture. Existing installations pay a one-time migration cost proportional to their stored journals; production migration duration has not been measured. SQLite's query plan uses `idx_events_native_tool` with the bound conversation, event type and call ID.

This lot does **not** reduce initial replay payloads: A still transfers 123.73 MiB decoded. Cold B/C times remain around 1.1–1.5 seconds, and browser heap still retains heavy snapshots (109–175 MiB across these runs). No general opening-time or cache-memory improvement is claimed. The remaining approved plan is incremental Claude synchronization, lazy heavy bodies, recent-turn projections, then byte-budgeted caches and Desktop diagnostics.

Validation: `NODE_ENV=development pnpm typecheck`, `pnpm test` (**365/365**), `pnpm lint`, production server/web builds and `pnpm test:codex-ui` passed. The UI suite includes eight journal lifecycle scenarios at 1280 px and 390 px. Production-build trials opened all three copied journals, revisited cached threads, cancelled replay and opened a phone viewport in both actual server profiles, without page errors. Native Windows/macOS Electron tests and CLI process behavior remain outside these Linux trials. All disposable test servers were stopped.

## Lot 2 implementation and verification — 23 October

Claude synchronization now persists a reconstructible cursor with each journal batch (`0052_claude_transcript_cursors`). It includes the source path, file identity/timestamps, consumed UTF-8 byte offset, SHA-256 prefix digest, subagent links and small translator context (pending tool paths/timestamps, not tool bodies). Journal progress invalidates stale checkpoints when the live runner has written new events. Concurrent HTTP sync requests share one operation; a busy runner or intervening journal write takes precedence.

Unchanged files require metadata checks only. For changed files, the committed prefix is hashed in fixed-size reads before trusting the cursor; only the suffix is decoded as JSON. This deliberately retains sequential prefix I/O to detect in-place rewrites followed by appends, including replacements with restored mtime. It is not an assumption that every larger file is an append. Missing/replaced cursors rebuild in a streaming pass at the latest shared UUID; no common anchor means no guessed import. Malformed partial tails remain retryable, and valid final objects without a newline must be delimited by the next write.

First imports and catch-ups translate one record at a time, merge main/subagent streams by timestamp and commit batches bounded at 128 events or 1 MiB of serialized data. One oversized JSONL record remains atomic and can exceed that budget. Progress and journal events commit together; errors/restarts resume from the last committed record. Turn counts are recalculated once at completion, with a durable pending recount flag, instead of rescanning the full journal after every small batch. Anchor queries project only identifiers from SQLite, avoiding the old materialization of all normalized and native bodies in JS.

Subagent files are checked independently, including late-created and nested files while the main transcript is unchanged. The shared reader honors `CLAUDE_CONFIG_DIR`. Current additional Claude accounts use token overrides with the same transcript root; their gauge-login directories are not substituted for session history.

Node 22.23.2 measurements on the same 164.32 MiB main transcript, with 29,652 relevant entries, are recorded in [lot2-measurements.json](lot2-measurements.json):

| File-processing scenario | Elapsed | JS heap after processing | Decoded records |
| --- | ---: | ---: | ---: |
| Retained-array reference | 340 ms | 205.46 MiB | 29,652 |
| Streaming cold recovery | 348 ms | 22.97 MiB | 29,652 |
| Reopen unchanged | 0.53 ms | — | 0; zero content bytes read |
| Append one synthetic message | 87 ms | 23.92 MiB | 1; prefix verified before suffix import |

Heap started around 17.7 MiB. These are observed heap values after each phase, not peak RSS. The incremental probe succeeds with a **64 MiB JS heap limit**. Separate regression subprocesses also import and recover anchors from synthetic 80 MB files/journals under 64 MiB. The file probe supplies one known shared UUID to isolate transcript cost; a separate read-only probe of the real journal extracts 11,444 UUIDs plus tool/subagent identifiers in 316 ms, with JS heap 22.21→45.84 MiB. Cold recovery can still pay both journal lookup and file scanning. These observations are not percentiles, and are not measurements of total UI opening time. Initial web replay and inline images are unchanged by this lot.

Validation: **380/380 tests**, typecheck, lint and production server/web builds pass. Tests cover cold and cached recovery, file identity/content changes, truncation/regrowth, Unicode and partial JSONL, shared-root changes, late/nested subagents, pending edits across cursors, concurrent sync, active-runner/commit races, failed batch recovery and initial-import rollback. `test:codex-ui` still passes at 1280/390 px. `test:claude-sync-ui` checks real production HTTP sync, external-file additions appearing in the browser, checkpoint reuse and duplicate-free reloads in **both Server and Desktop**, at 1440/390 px, using synthetic transcripts and no CLI processes. Installed Claude reports 2.1.301; no native Windows/macOS Electron or live CLI round trip is claimed.

The work remains uncommitted and undeployed on `audit/desktop-performance`. The remaining lots are lazy heavy bodies, recent-turn projections, and byte budgets/diagnostics. Production was not restarted; temporary test servers and probe copies were stopped/removed.

## Lot 3 implementation and verification — 23 October

History replay and live sockets can now opt into `bodies=1`. Raster images embedded in message blocks become authenticated URLs; large tool inputs/outputs and unified patches become references to their exact event sequence and field. Reused tool IDs cannot substitute a later result. SQLite performs the projection before bodies enter the server's JS heap. The stored journal, native tool payloads, full-text search index and original message/turn anchors are unchanged. Existing uploaded attachments already use URLs and retain their existing routes; the new embedded-image route checks conversation visibility and supports shared-project readers.

Tool cards and diff cards request their complete content when opened. Inputs retain bounded identifying fields, including subagent labels and the presence of a scheduled check script; outputs retain a short textual summary. Readable tool views wait for complete bodies. Closing/unmounting a card aborts its pending fetch, and body queries have a **zero inactive-cache budget** (`gcTime: 0`); active cards still own their full content. Bodies never replace references inside the conversation snapshots. Images use native lazy loading and the existing viewer/download workflow. A bounded header read supplies dimensions for PNG/GIF/WebP and common JPEG headers; unknown dimensions reserve a stable frame. Downloaded bytes are unchanged. Binary responses accept raster MIME types only, use `nosniff`/sandbox CSP, and have no persistent HTTP cache. This does not bound Chromium's decoded-image/GPU memory.

Both HTTP body/image routes check current conversation read access on every request, reject invalid field/index references, and expose no raw/native data. Revoking sharing blocks subsequent requests. New clients work with legacy servers because absent references retain the existing inline/output endpoint paths; old clients on new servers receive the original representation unless they opt in. Legacy unreadable events still become visible error entries rather than breaking replay.

The page index deliberately keeps its earlier conservative byte estimates. Measuring fully projected sizes there parsed giant images twice and also processed superseded patches. That first attempt reduced bytes but opened A in 2.59 s and stalled one health request for 498 ms. Projecting **only retained rows** removes that extra work; page count remains dependent on history until lot 4. No new migration is needed for lot 3.

| Scenario | Before lot 3 | After lot 3 (Desktop) | After lot 3 (Server) |
| --- | ---: | ---: | ---: |
| A: decoded journal | 123.73 MiB | 12.64 MiB | 12.64 MiB |
| A: browser JS heap after GC | 108.5 MiB | 26.5 MiB | 26.6 MiB |
| A: usable thread | 2480 ms | 1803 ms | 1839 ms |
| B: decoded journal | 47.98 MiB | 3.18 MiB | 3.18 MiB |
| B: browser JS heap after GC | 148.3 MiB | 30.2 MiB | 30.2 MiB |
| B: usable thread | 1083 ms | 563 ms | 558 ms |
| C: decoded journal | 24.68 MiB | 20.71 MiB | 20.71 MiB |
| C: browser JS heap after GC | 178.7 MiB | 53.9 MiB | 53.9 MiB |
| C: usable thread | 1464 ms | 1453 ms | 1467 ms |

A's replay shrinks by **89.8%**, exceeding the 80% target. Its visible area additionally loads 3 image resources (7.67 MiB decoded); the other images remain deferred. Image bytes are not included in the replay column. A/B/C still use 17/5/22 journal requests; cached revisits use one. Fresh phone B uses 17.3 MiB JS after GC versus 41.6 MiB before, with essentially unchanged 921 ms opening time. Navigation-away starts **zero** additional journal requests in both profiles. Numeric evidence: [lot3-measurements.json](lot3-measurements.json).

These observations use the original audit journals, Node 22.23.2 and production builds on Linux/Chromium 151. Baseline is the completed lot 2 code, with original inline images. A/B/C share a browser context, so later heap values include previously visited snapshots. The phone viewport uses a fresh context. Timings are individual observations, not percentiles or predictions for native Windows/macOS hardware. Native Electron, OS pressure, CLI processes and GPU allocations remain unmeasured.

Validation: **387/387 server tests**, typecheck, lint and production server/web builds pass. New tests verify lossless reconstruction of projected bodies, immutable stored events, exact reused-call versions, subagent/schedule metadata, old malformed events, authenticated/shared/revoked access and socket opt-in for catch-up/live delivery. `test:codex-ui` additionally checks deferred requests, close cancellation, zero inactive body retention, reopening after errors, diff restoration, offscreen image loading, stable image geometry, original downloads and missing-image errors on 1280/390 px. `test:images-ui` passes on 1440/390 px for existing Read/MCP galleries, zoom, rotation, copy and keyboard/focus behavior. Real production-build trials cover A/B/C, warm revisits, cancellation and a phone viewport in both Server and Desktop, without page errors.

The fixes remain uncommitted and undeployed in the existing worktree. Lots 4 (initial recent-turn view) and 5 (snapshot byte budgets and Desktop diagnostics) remain pending. The existing four-snapshot cache is still count-bounded; this lot's zero-inactive budget applies only to fetched tool/diff bodies. All tests use disposable instances; production was not restarted.

## Lots 4–5 implementation — 23 October

Prepared in the same worktree; no commit, push, merge or deployment. The initial conversation view now comes from a persistent projection of the immutable journal. `packages/protocol/src/chat-state.ts` supplies the same pure fold to the server and browser. Localized notices retain semantic parameters and are translated when displayed; translated strings are not stored in the projection.

Migration `0053_long_power_man` adds a versioned cursor/scalar state and indexed rows for items, checkpoints, edits and tasks. A single background worker advances at most 256 journal rows / a nominal 1 MiB per batch, yielding between batches. It does not scan the full supersession index before starting. Each transaction commits rows and cursor together. Existing conversations build lazily; interrupted work resumes from its cursor, and incompatible versions rebuild from the source journal. The source events are never rewritten. One oversized event, or intrinsically large outstanding interaction, can exceed nominal payload budgets.

The initial view requests up to six recent user turns, capped at 200 ordinary items / a nominal 512 KiB. Outstanding interactions, active tasks and required parent calls are retained even when older. History loads on demand. Each older page includes changes to already loaded rows at the same cursor, then live delivery resumes after that cursor. Late fragments for an omitted message recover its original row before folding. This prevents duplicated blocks, missing permissions and misplaced reused IDs. A large catch-up can reset to a fresh recent view. Older servers and unavailable initial projections retain the full-journal fallback.

Search explicitly loads history while showing progress; it does not silently report matches from only the recent window. Old message links and same-tab reading positions fetch the necessary pages before placement. Panels expose earlier activity for historical edits, checkpoints and subagents. Opening a conversation stays bounded independently of journal length once its projection is ready; explicitly opening or searching all history still retains and renders that requested content.

Caches now have separate limits:

- Inactive conversation snapshots share an **8 MiB estimated retained-size budget**, with LRU eviction and a 60-second unobserved-query lifetime. Oversized views are not cached. The current reading state remains separate from evictable snapshots.
- Full tool/diff bodies retain the lot 3 **zero inactive cache** policy and abort when closed.
- Server replay indexes share a **16 MiB estimated budget**; unchanged-cursor catch-up avoids building an index at all.
- Reading positions retain at most 128 small numeric records, only within the current tab.

Desktop adds an export action in About and in the native menu, which remains reachable if the renderer stops responding. A local diagnostic ring records startup, renderer responsiveness/exits, server exits, load stages, renderer long tasks and memory samples. Electron main/renderer/GPU/other processes are separated from the Node server and its CLI/tool descendants. OS probes return numeric PID/parent/RSS fields only. Exported reports contain version/platform information and whitelisted numeric measurements; they do not attach server logs, prompts, commands, workspace paths, credentials or conversation IDs. The diagnostic log rotates during use at 256 KiB plus one previous file and retains at most 300 records in memory. Nothing is uploaded automatically.

The persistent projection was compared with the full shared-fold replay on all three original audit journals: **8,256 / 2,334 / 8,507 items**, with identical reconstructed state after loading all pages. Background rebuild observations on Node 24.20.0 were **2.61 / 0.63 / 2.06 seconds** total, with largest individual batches **76 / 33 / 74 ms**. Prepared-page construction took **2.7 / 1.9 / 4.3 ms** and returned **197,777 / 221,891 / 311,825 bytes**. These cold rebuild costs occur once per projection version; they are separate from opening an already prepared view. The comparison probe subsequently materializes both complete states to verify equality, so its final process memory is not a projection-worker memory measurement.

### Prepared-view browser measurements

Production builds, Node 22.23.2 and Chromium 151, on the same original journal fixtures. A/B/C share one browser context; phone B starts fresh. Each value is an individual observation, not a percentile or a forecast for another machine. First-time projection construction is excluded from this table and measured separately above.

| Conversation | Original opening / JS after GC | Prepared opening, Desktop / Server | Initial response | JS after GC, Desktop |
| --- | ---: | ---: | ---: | ---: |
| A | 2,480 ms / 108.55 MiB | 227 / 221 ms | 193 KiB, 1 request | 12.37 MiB |
| B | 1,083 ms / 148.34 MiB | 95 / 103 ms | 217 KiB, 1 request | 13.36 MiB |
| C | 1,464 ms / 178.71 MiB | 118 / 109 ms | 305 KiB, 1 request | 16.37 MiB |

A's initial conversation response falls from 123.73 MiB to 0.189 MiB. Compared specifically with completed lot 3, its opening falls from 1,803 to 227 ms and JS heap from 26.5 to 12.37 MiB. Image/body requests remain separate from this response budget. Cached revisits take 79–108 ms; phone B opens in 206 ms. Twenty successive navigations retain **14.7–17.0 MiB** after GC (15.7 MiB after the twentieth); this short run shows no runaway growth, not proof against every long-lived leak. Leaving a conversation starts zero additional page requests in both profiles. Evidence: [lot4-5-measurements.json](lot4-5-measurements.json).

### Validation and practical limits

**392/392 tests**, typecheck, lint and production server/web/Desktop builds pass. `test:codex-ui` passes at 1280/390 px; `test:claude-sync-ui` passes in both profiles at 1440/390 px. Server tests cover projection equivalence, late/reused IDs, unresolved interactions, checkpoint history, atomic rollback/restart, incompatible versions, deletion, access revocation and cursor validation. Browser hook tests cover projection/live handover, late transport responses, cancellation and 20 large synthetic snapshots within the budget. The production-build UI checks exercise older pages, deep links, same-tab reading positions and complete search at large and phone widths in both Server and Desktop profiles.

A real **Electron 44.9.0 Linux** launch with its Chromium sandbox verifies the Desktop export UI, per-role memory sampling, rotation/whitelisting and simulated unresponsive/OOM lifecycle signals. The test launches the app's own disposable server with Node 24.20.0; it does not deliberately exhaust memory or run an authenticated LLM turn. Windows process-format fixtures are tested, but native Windows and macOS app trials remain outstanding. No exact attribution of either user's original alert is claimed.

## Findings and order of work

| Priority | Finding | Evidence | Editions |
| --- | --- | --- | --- |
| Already fixed | Desktop explicitly restricted the server's V8 old generation to 256 MiB. | Verified in the v0.22.0 tag; absent in v0.24.2. This is not a cap on total app memory, and free system RAM does not prevent this failure. | Desktop on all platforms; Server deployment limits are separate. |
| 1 | Looking up one historical file edit loads every tool start/completion payload and native raw event in that conversation into JS. | `rawOfTool` increased JS heap from 23 to 611 MiB and RSS from 197 to 788 MiB. The same call aborted with `Reached heap limit` at 256 MiB. This fixture omits native raw fields, so it understates real data volume. | Server and Desktop. |
| 1 | Navigating away does not cancel journal pagination. | In the small-image experiment, **11 new requests started after the Settings route was reached**, out of 14 pages. The original-data run also continued all 17 pages (16 started after the click was requested; this earlier marker is less strict). | Server and Desktop. |
| 2 | Showing the last rows still requires replaying the entire journal, including inline images. | Session A transfers 123.73 MiB decoded / 84.76 MiB compressed in 18 requests. Its 50 image blocks contain 110.58 MiB. Opening takes 2.43 seconds locally, 6.85 seconds with renderer CPU throttled by 4. | Server and Desktop; Desktop also hosts the server on the same machine. |
| 2 | Opening an idle Claude session rereads and retains its complete relevant transcript before finding the already imported anchor. | A 164.32 MiB transcript returns 29,652 entries in 411 ms; JS heap rises from 23 to 221 MiB. No new external CLI work is needed to trigger that read. | Server and Desktop, Claude sessions. |
| 3 | Memory retention and diagnostics need explicit budgets and per-process visibility. | Four replay snapshots are retained by count, without a byte budget. Browser heap after GC reached 167 MiB across three sessions. Desktop handles a server exit, but has no dedicated renderer-unresponsive/crash telemetry or aggregate process-memory diagnostic. | Both for cache budgeting; Desktop for launcher diagnostics. |

The final row is an improvement opportunity, not proof of an unbounded leak. Warm revisits were fast and did not show monotonic growth in this short run. CLI subprocesses, Electron's main process, GPU allocations and OS memory pressure were not measured.

## Measurements

Production web and server builds ran on Linux, Node 24.20.0 and Chromium 151.0.7922.34. The HTTP server used the actual `desktop` profile and its launcher handshake, bound to loopback. Chromium used its sandbox. These are shared-runtime measurements, **not native Windows/macOS Electron measurements**; release packaging uses Node 22 from CI.

Three long, idle real journals were copied into a disposable database. Credentials, original projects, schedules, native raw payloads and external agent session IDs were excluded. All CLIs were disabled. This isolates replay; real machines can additionally pay transcript synchronization and agent-process costs. The full production database was never copied or modified, and the production daemon was not restarted.

| Scenario | Visible thread, normal CPU | Visible thread, renderer CPU ×4 slower | Journal requests | Decoded data | Browser JS heap after GC, normal CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| A: long Codex journal with images | 2,432 ms | 6,849 ms | 18 | 123.73 MiB | 108.7 MiB |
| B: another Codex journal with images | 1,077 ms | 2,358 ms | 6 | 47.98 MiB | 136.7 MiB |
| C: long Claude journal, replay only | 1,464 ms | 4,937 ms | 23 | 24.68 MiB | 167.1 MiB |
| A: cached revisit | 120 ms | 348 ms | 2 | negligible | 167.5 MiB |
| B: cached revisit | 159 ms | 519 ms | 2 | negligible | 147.8 MiB |
| B: fresh 390 × 844 viewport | 954 ms | 2,731 ms | 6 | 47.98 MiB | 41.6 MiB |

Rows A/B/C share one browser context, so heap values include previously visited snapshots. The phone viewport uses a fresh context, not mobile hardware. CPU throttling applies only to Chromium's renderer; it is a sensitivity test, not a prediction for a particular Mac or PC. These are individual observations rather than statistically stable p95 values. There is no network throttling.

Server RSS peaked at 694 MiB while opening A. A health request took up to 242 ms in that load. At renderer CPU ×4, A accumulated 4.44 seconds in main-thread tasks longer than 50 ms; the largest individual task during its cold open was 199 ms. A warm B revisit also had a 321 ms task. This demonstrates intermittent responsiveness loss, not a continuous multi-second event-loop freeze.

The standalone replay probe separated costs on A: approximately 911 ms reading/filtering/parsing pages, 156 ms serializing them, and 197 ms applying the events to UI state. For C: 480 ms reading, 59 ms serializing and 238 ms folding. These probes exclude HTTP, compression, browser parsing, React and layout; they must not be added to the browser times. The existing DOM window of 120 rows and server delta/output filtering already help; missing virtualization is not the main initial-load finding.

## Controlled image experiment

In the disposable copy only, inline image URLs in 63 message events across A/B were replaced with a valid tiny PNG. Event ordering and counts stayed unchanged. This is a payload-weight experiment, not an implemented image-loading solution; image appearance/dimensions are not equivalent.

| Metric | Original A | Tiny-image A | Original B | Tiny-image B |
| --- | ---: | ---: | ---: | ---: |
| Decoded journal | 123.73 MiB | 13.16 MiB | 47.98 MiB | 3.55 MiB |
| Compressed journal | 84.76 MiB | 2.19 MiB | 33.62 MiB | 0.60 MiB |
| Opening time | 2,432 ms | 1,903 ms | 1,077 ms | 486 ms |
| Browser heap after GC | 108.7 MiB | 27.2 MiB | 136.7 MiB | 31.1 MiB |

Removing inline bytes clearly reduces memory and transport, but A still takes 1.90 seconds. Loading the whole journal and processing large stored payloads remain relevant. Simply increasing the heap or hiding the spinner does not address those costs.

## Code locations and proposed corrections

- `apps/desktop/src/server.ts:55`: the fixed launcher limit. Keep the v0.24.2 removal; do not reintroduce a universal low heap ceiling. This change alone cannot bound data processing.
- `apps/server/src/events/event-log.ts:570`, called through `/api/conversations/:id/edits/:toolCallId` and all four adapters: filter by tool ID in SQL and retrieve only the needed start/completion native payloads. Preserve last-matching-event semantics for reused IDs. Avoid parsing every unrelated payload in JS; consider indexed tool IDs if profiling shows SQL JSON scans still expensive. Validate identical diff results with real raw events, not just the raw-free fixture.
- `apps/web/src/lib/conversations.ts:364`, `use-chat-stream.ts:110` and `api.ts`: propagate an `AbortSignal` through the request, stop subsequent page requests on unmount/session switch, and coordinate overlapping catch-up requests. Preserve cursor/idempotence semantics on reconnect; abort must not appear as a user error. One server request already executing may still finish.
- `use-chat-stream.ts:15`, `ConversationPage.tsx:617`, `events/event-log.ts:252`: retain a lightweight view of the conversation, fetch image/tool/diff bodies only when displayed, then introduce a server snapshot or recent-turn endpoint so opening does not depend on full replay. Preserve search, anchors, subagents, forks and reconnect behavior. Make cache eviction depend on estimated bytes as well as count.
- `apps/server/src/agents/claude/transcript.ts:70`, `http/routes/claude-sessions.ts:231`, `ConversationPage.tsx:531`: streaming input currently still produces a complete retained array. Skip unchanged transcripts using reliable file metadata, coalesce concurrent syncs and retain only the necessary suffix after an import anchor. Account for file replacement, truncation, rotation, separate subagent files and account-specific transcript roots. Do not drop external CLI changes. Related to board #17.
- `apps/desktop/src/main.ts`: diagnostic counters should distinguish Electron main/renderer/GPU, the Node server and CLI processes; record renderer-unresponsive and renderer-exit reasons, replay stages/bytes/pages and server event-loop delays. Avoid conversation content or credentials in exported diagnostics.

Recommended sequence: bound the file-edit lookup and cancel abandoned replay first; remove heavy bodies from initial replay and make transcript sync incremental next; then introduce initial-view snapshots and memory budgets. Increasing available memory is a compatibility fix, not a completion criterion for performance work.

## Reproduction and evidence

Sanitized numeric observations are in [measurements.json](measurements.json). Full temporary request timings and logs remain locally under `/var/tmp/sillage-perf-audit-20261022`; they are not intended for publication. The disposable database can be regenerated and removed after investigation.

The audit scripts are outside the application runtime:

1. Build web/server with production settings, then run `apps/server/dist/cli/migrate.js` with a fresh `SILLAGE_DATA_DIR` and separate `SILLAGE_CONFIG`.
2. Run `python3 scripts/performance-audit-fixture.py SOURCE_DB NEW_DB EMPTY_WORKSPACE CONVERSATION_IDS...`. The source connection is read-only; the target must have no users. Only explicit conversation IDs are copied. Use `AUDIT_NATIVE_TOOL=1` to also copy native payloads for the first tool call of each journal, as in the lot 1 comparisons. These private fixtures must stay outside the repository.
3. Set `AUDIT_DIR` to the directory containing `data/sillage.db`, then run `node scripts/performance-audit-browser.mjs ID_A ID_B ID_C` through a disposable `systemd-run --user` unit. Optional `AUDIT_CPU_RATE=4` and `AUDIT_LABEL=slowcpu` select the sensitivity run and output name. Desktop is the default profile: the script reads its cookie from descriptor 3. For `AUDIT_PROFILE=server`, add `--import ./apps/server/node_modules/tsx/dist/loader.mjs` to Node so the script can reuse the session helper with the synthetic audit account. Both modes stop their own server and close the browser.
4. Standalone probes use `node --expose-gc --import ./apps/server/node_modules/tsx/dist/loader.mjs scripts/performance-audit-server.mts MODE DATABASE ID`, with `MODE=replay`, `replay-bodies`, `raw-tool` or `raw-tool-reference`. The reference mode runs the frozen pre-fix lookup and asserts equality with the corrected result after its memory measurement. For `transcript`, ID is the native Claude session ID and one more argument is its workspace path. The DB connection is read-only. Apply `--max-old-space-size=256` **only to the disposable probe**, with core dumps disabled, to reproduce the historical failure in reference mode or validate the corrected lookup.
5. The tiny-image experiment replaces only `blocks[].url` values starting with `data:` where `blocks[].type` is `image`, in the disposable DB, then repeats step 3. Restore the copy from step 2 before original-data comparisons.
6. For lot 2, run `scripts/performance-audit-transcript.mts reference SOURCE_FILE LAST_SHARED_UUID` and then `incremental` with Node's same `tsx` loader, `--expose-gc` and `AUDIT_DIR`. It makes and removes a private copy, appends only a synthetic message to that copy, and emits numeric metrics. Use a 64 MiB heap limit for `incremental`; the retained-array reference needs a larger limit. The standalone server probe also accepts `MODE=anchors` for separate journal identifier extraction. Run `NODE_ENV=development pnpm test:claude-sync-ui` after production builds for the Server/Desktop browser regression.

7. For lots 4–5, `scripts/performance-audit-projection.mts AUDIT_DB ID_A ID_B ID_C` mutates only the disposable audit DB, migrates/builds its projections and verifies complete replay equivalence. Run with the server's `tsx` loader; `AUDIT_REBUILD=1` invalidates only those derived fixture views. `AUDIT_CYCLES=20` adds GC measurements to the browser probe; `AUDIT_HISTORY=1` checks old-page navigation, anchors, same-tab reading positions and complete search at both widths. The Linux source/staging harness `xvfb-run -a node scripts/desktop-diagnostics-check.mjs` uses a sandbox-enabled Electron 44.9 binary at `apps/desktop/release/linux-unpacked/sillage` and the staged runtime, then removes its disposable profile and exported report.

The initial audit's Desktop profile and browser tests passed on large and phone-sized viewports with no page errors. `NODE_ENV=development pnpm typecheck`, `pnpm test` (364/364) and `pnpm lint` passed; production server/web builds passed. Audit scripts were syntax-checked and exercised; there are no new shell scripts. Existing Vite CSS/chunk warnings remain. The initial audit made no fixes; all five implementation lots and their separate validation are recorded above. No merge, commit, push or deployment was performed.

## Remaining uncertainty

The exact Windows version and the wording of the memory alerts remain unknown. The macOS version was recalled as approximately 0.22.0. The source confirms its heap cap, but attributing those particular alerts requires the desktop server log and, for an OS-wide memory alert, per-process memory information. Native Windows filesystem/antivirus costs, macOS GPU/Electron behavior, memory under real active CLI workloads and longer-lived leaks remain unmeasured. Linux Electron export and short navigation-cycle tests are now covered above.
