# Services

The **Services** entry opens `/services`: commands and services still attached to
this Sillage server, with or without listening ports. It refreshes every five
seconds. Each process shows its parent, project/conversation when known, ports,
resident memory, and elapsed time. Agent and terminal launcher processes can be
included with a checkbox; they remain controlled from their dedicated interfaces.

## What belongs in this view

On Linux, the server reads `/proc` for processes owned by its Unix user. A process
must descend from the current Sillage process. The entire tmux or screen branch
is excluded, even if it inherited Sillage's environment. Other systemd units are
also excluded. A matching project directory never qualifies a process.

There is one additional case: a shell may exit after starting a background job,
leaving an orphan. When Sillage is the main process of a dedicated systemd service
with `KillMode=control-group` or `mixed`, a process remaining in that same cgroup
still depends on the service and is included. A shared SSH/session/test cgroup is
not sufficient. Without this evidence, detached processes are omitted.

Closing the browser does not stop any of these processes. The UI only promises
shutdown with Sillage when the verified systemd configuration guarantees it.
Parenthood alone does not guarantee that a Unix child dies with its parent.

## Attribution and stopping

The inherited `SILLAGE_PROCESS_ORIGIN` marker, resolved through the registry in
`<data>/process-origins/`, supplies project/conversation attribution *after* the
execution link has been verified. If a command clears its environment, its live
ancestors can supply that attribution. A stale marker on an independent service
never includes it in this view. Unknown-project descendants are admin-only;
private-project visibility is enforced for everyone, including administrators.
No raw arguments or environment values are returned to the browser.

`POST /api/services/:id/stop` rescans, checks project visibility, then revalidates
boot ID, PID, start time, origin and current execution link immediately before
SIGTERM. Agent/terminal launchers, the daemon itself and independent processes
cannot be stopped here. No process-group signal or forced kill is sent. A process
ignoring SIGTERM stays visible; a watcher may restart its child.

Ports are information only: detection does not expose or proxy them. Other hosts,
other containers and processes inaccessible to Sillage are outside this view.

Validation: `pnpm test`, `pnpm typecheck`, `pnpm build` and
`node scripts/services-ui-check.mjs`. The UI check launches real processes through
a Sillage terminal and verifies that an independent process with the same directory
and origin marker is excluded. Tests also cover commands without ports, tmux,
orphan cgroup membership, project permissions and targeted stopping.
