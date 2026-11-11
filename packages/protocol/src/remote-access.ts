// Remote access to a desktop instance through Tailscale Serve.

/** What the `tailscale` CLI reports about this machine. */
export type TailscaleStatus =
  /** No `tailscale` binary found. */
  | { state: 'missing' }
  /** Installed but not connected (`NeedsLogin`, `Stopped`…). */
  | { state: 'stopped'; backend: string }
  | {
      state: 'running'
      /** MagicDNS name without the trailing dot, e.g. `desk.tail1234.ts.net`. */
      hostname: string
      /** Tailnet account owning this node; null for tagged nodes, which no one logs in as. */
      login: string | null
      /** HTTPS certificates enabled on the tailnet, a prerequisite for Serve over HTTPS. */
      https: boolean
    }
  | { state: 'error'; message: string }

/** HTTPS port Serve listens on for Sillage. Fixed: the address must stay stable across launches. */
export const REMOTE_ACCESS_HTTPS_PORT = 443

export interface RemoteAccessState {
  /** Remote access accepted by the server: requests on `hostname` carrying `login`. */
  enabled: boolean
  /** Sillage's local port, the Serve target. */
  port: number
  hostname: string | null
  login: string | null
  /** `https://<hostname>` once enabled. */
  url: string | null
  tailscale: TailscaleStatus
  /** Current Serve mapping on the HTTPS port: the local port it forwards to, or null when none. */
  serve: { target: number | null; funnel: boolean }
  /**
   * Why Sillage could not configure Serve itself, when it could not; the user then runs the
   * printed command. Null when the mapping matches or Serve was never attempted.
   */
  serveError: string | null
}
