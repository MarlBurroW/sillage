# Session list alternatives

The screenshot gives equal weight to opening prompts, branch names, Git states, and repeated agent marks. Long conversational openings obscure the distinguishing words. Selected rows also vary in height according to their metadata.

## Shared visual system

Reuse Sillage's theme tokens and system sans-serif, with monospace reserved for actual branch names. Approximate dark anchors: canvas #19161a, surface #211d22, text #f3f0f4, secondary #bdb4bf, accent #cb8dd2. Use the existing light palette as well. Text stays left aligned; selection uses a square-ended left border. Do not use color alone for state.

User feedback: keep the CLI logo visible at the start of every session row in every proposal, including unselected rows. CLI identity must be recognizable before opening a conversation. The sample sessions all use Codex, as in the supplied screenshot.

User feedback: proposal B duplicates the existing Activity section higher in the sidebar. Remove it from the comparison. The user now favors A as a stable navigation list with short titles and CLI logos, and asks to replace the permanent details area with a rich tooltip to preserve vertical space. Open the study on A while preserving A/C/D comparison links.

The rich tooltip is approved. Further feedback: worktree status must also remain visible without hovering, because the user uses it to find work still needing integration. A branch name can stay in the tooltip; integration status is navigation information.

## Visible worktree state

The user selected aligned symbols, conditional on consistent colors and easy access to clear explanations. Open on this treatment. Retain the label below the title and right-side badge as comparison options. All keep the same 47 px desktop / 48 px mobile rows and preserve the CLI logo.

Use one fixed column at the right edge, independent of agent activity and age. The symbol is also the details button, so it never requires a second information icon on the same row. Reuse the exact same SVG and semantic color in the tooltip, followed by a colored state label and a plain-language explanation. This repeated vocabulary teaches the symbols without requiring a permanent legend below the list.

Reuse the existing `WorktreeTag` semantic colors: dirty/uncommitted uses caution, unmerged uses accent, merged uses positive, and missing uses critical. Distinct symbols and text complement color. Agent activity stays a separate signal. No worktree gets no Git marker; unavailable Git state gets an explicit neutral unknown marker. Never infer that uncommitted changes are ready to merge, or that a merged worktree implies a finished session.

| State | Symbol and semantic color | Tooltip meaning |
| --- | --- | --- |
| Merged | Check, positive | Work already integrated into the main branch |
| Uncommitted | Pencil, caution | Changes still need to be saved in a commit |
| Unmerged | Branch arrow, accent | Commits are not yet integrated into the main branch |
| Missing | Warning triangle, critical | The worktree directory cannot be found |
| Unknown | Circled question mark, neutral | Git could not be read; merge status is not confirmed |

Three added fixture sessions illustrate unmerged commits, a missing worktree, and unavailable status. There are now 15 sessions in each comparison. The extra controls and legend belong to the design study, not a proposed permanent settings bar in the app. If integrated, reuse `useConversationWorktree` and `WorktreeTag`'s shared state definitions.

Three structural alternatives, all using the same fixture sessions:

```
Quiet list          By date             By worktree
Sessions            Today               Active worktrees
Logo Title   time   | Logo Title time   > Tool display (2)
Logo Title   time   | Logo Title time   > Main tree (1)
Logo Title   time    Yesterday          Merged worktrees
Logo Title   time   | Logo Title time   > Desktop memory (2)
...                 ...                ...
```

Session activity indicators should use actual turn/decision signals, never infer completion from a merged branch. Date grouping follows last activity. Worktree grouping follows the actual worktree association, not inferred topic similarity. Topic labels in this mockup are manually written examples.

## Rich session preview

The bottom inspector is removed, returning its full 170 px to the list. A body-level overlay reveals the hovered session, independently of selection: short title, CLI, last exchange, activity, last activity, branch and Git state, and original request. Mouse hover waits 400 ms, matching the existing Sillage Tooltip provider. Moving into the preview keeps it open; leaving uses a short grace period. Keyboard focus opens it, Escape dismisses it, and scrolling or resizing dismisses stale overlays.

The Git symbol is a separate button from session navigation. Hover or keyboard focus previews the details; clicking, pressing Enter or Space, or touching the symbol opens a nonmodal popup with a close button and focus restoration. Touch targets are 44 px. Sessions without a worktree retain an information button, always visible on touch and revealed on hover/focus on desktop. The alternative treatments also retain that button. Tapping the title still navigates directly. The popup fits viewport edges and moves to the bottom on phones, without taking any height from the list. Returning focus after dismissal must not immediately reopen it.

The production `Tooltip` currently accepts a plain string and intentionally disables hover tooltips on touch. If implemented in the app, extend/reuse the existing UI primitives with rich content and a touch popover rather than transplanting this standalone preview's DOM orchestration.

## Review before implementation

An early card-per-session direction repeated the existing noise and consumed more vertical space; discard it. Keep the existing visual language and spend the variation on navigation structure. Short titles are a separate, explicit switch: the layout must remain assessable with original prompts. The mockup does not imply automatic summarization is already implemented.

## Scope

Static, interactive design study only. Fixture titles are inspired by the screenshot; extra sessions, dates, states and conversation excerpts are simulated. No API, production data, or app behavior changes. Server and Desktop use the same proposals; nothing depends on authentication, notifications, or PWA features.
