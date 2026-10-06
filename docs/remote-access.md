# Pick up Sillage from another device

Give your agents a machine to work on, then connect to that same Sillage instance
from your laptop, tablet or phone. An always-on server is the recommended home;
a desktop or laptop also works while it stays awake and online.

Closing the browser does not stop a running agent. Sleeping or shutting down the
host makes Sillage unavailable and prevents agents from continuing their work.
A VPN supplies connectivity, not compute: it does not keep the host awake, move
sessions to another machine, or synchronise installations. Saved conversation
history is distinct from a running process; do not assume interrupted work will
resume automatically after a shutdown.

## Choose your connection

| Route | Best fit | What to configure |
| --- | --- | --- |
| **Tailscale + Serve (recommended)** | Private access from your own devices | Tailscale on the host and clients, then an HTTPS proxy to Sillage |
| **An existing VPN, such as WireGuard** | You already manage a private network | VPN routing, private DNS, firewall rules and an HTTPS reverse proxy |
| **Cloudflare Tunnel + Access** | Browser access without installing a VPN on clients | A tunnel, hostname and an Access policy restricting who can sign in |

A commercial VPN subscription for browsing the Internet is not necessarily a
network connecting your own devices. You need a route from your phone to the
machine running Sillage.

Sillage accounts can run agents and a terminal under the host's system account.
Keep access restricted to people you trust with that machine, and retain Sillage's
login. A reverse proxy alone does not restrict who can reach the application.

## Set up Tailscale

### 1. Connect the host and your devices

Follow the [official installation guide](https://tailscale.com/docs/install) for
the Sillage host and each client, including your phone. Sign them into the same
private Tailscale network (tailnet), and check that the host appears connected.
Your tailnet's access rules must allow the intended clients to reach it.

- **Linux:** install Tailscale on the machine running Sillage.
- **macOS:** install the app and enable its connection. If `tailscale` is absent
  from your terminal, follow the [macOS CLI instructions](https://tailscale.com/docs/reference/tailscale-cli?tab=macos).
  Serve can proxy ports with the macOS app; the restrictions on serving files do
  not prevent this setup.
- **Windows / WSL2:** install Tailscale on **Windows** and run Serve from
  PowerShell. First check that Windows can reach Sillage's port with
  `Test-NetConnection -ComputerName 127.0.0.1 -Port 7317` while Sillage is running.
  This uses [WSL's Windows-to-Linux forwarding](https://learn.microsoft.com/en-us/windows/wsl/networking).
  If that check fails, resolve WSL forwarding before configuring Serve. Use the
  Windows node's hostname. Tailscale [recommends against running both Windows
  and WSL clients simultaneously](https://tailscale.com/docs/install/windows/wsl2).
- **Docker:** install Tailscale on the host and publish Sillage's port on the
  host loopback interface, for example `127.0.0.1:7317:7317`.

Keep the host awake during remote use. On Windows, WSL must also remain running;
see the [Windows guide](windows.md). On macOS, the Sillage launch agent starts
with your user session. Screen locking is compatible with remote use; system
sleep is not. Do not assume closing a laptop lid leaves it available.

### 2. Give Sillage a private HTTPS address

Keep Sillage's default loopback listener and run on its host:

```bash
# Garder Sillage privé tout en donnant une adresse HTTPS aux autres appareils.
tailscale serve --bg --https=443 7317
tailscale serve status
```

On Windows, run these commands in PowerShell; on Linux and macOS, use the host
terminal. Use `sudo` if your Linux Tailscale installation requires it. If your Sillage port
is different, replace `7317`. Follow the command's setup link if HTTPS needs to
be enabled in your tailnet. If port 443 already has a Serve mapping, inspect it
first and choose another available HTTPS port instead of replacing it.

Open the **exact HTTPS address printed by Serve** on your other device, with
Tailscale connected, then sign in to Sillage. Use the full `.ts.net` hostname,
not the machine's numeric VPN address: HTTPS certificates and host routing depend
on the hostname. No public domain or router port forwarding is needed for this
route. Serve remains private to your tailnet; **Funnel is a different feature
that exposes services publicly**.

Background mode keeps the proxy configuration active; it does not start Sillage
or keep a sleeping computer awake. See [Serve setup](https://tailscale.com/docs/features/tailscale-serve)
and the [command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

### 3. Verify from the phone

With Wi-Fi disabled and Tailscale connected, open the address over mobile data.
Check that you can sign in, open a conversation and see updates. This tests the
actual remote path rather than only your home network.

Use HTTPS for the installed PWA and browser features such as push notifications
and microphone access. Availability and permission prompts also depend on the
browser and operating system. On iPhone/iPad, add Sillage to the Home Screen and
open it there to enable supported web push notifications; see
[Apple’s requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers). A notification does
not make an offline host reachable.

To remove only the mapping created above:

```bash
tailscale serve --https=443 off
```

## Teach agents to share reachable preview links

Access to Sillage and access to an app created by an agent are separate. A preview
running on port 5173 needs its own route; exposing Sillage on port 7317 does not
expose other ports. The browser runs on **your device**, while the agent's server
runs on **the Sillage host**. A loopback link points at the wrong machine when
opened from your phone.

In Sillage, open **Settings → Instructions** (`/settings/consignes`) as an
administrator to set defaults for all projects. Use a project's instructions
panel for exceptions or project-specific ports. In repository mode, those project
instructions live in `AGENTS.md` or `CLAUDE.md`; see [how instructions work](sillage-md.md).

Copy this template after replacing the hostname and confirming the port allocation.
The hostname is a placeholder, not a working address. Use the host running the
preview; a separate VM or container may need additional routing.

```text
Remote browser and preview links

The user opens Sillage from another device over Tailscale.
The full VPN hostname of this development machine is: REPLACE_WITH_REAL_HOSTNAME.
Sillage's own HTTPS mapping on port 443 is reserved; do not change it.
Preview HTTPS ports 8443–8449 may be used when free.

When starting a web preview:
- Bind its backend to 127.0.0.1 on an available local port. For Docker, publish
  on 127.0.0.1 too.
- Inspect `tailscale serve status` and existing listeners before choosing ports.
  Never overwrite another project's mapping or stop its process.
- Expose the preview privately with Tailscale Serve, for example:
  `tailscale serve --bg --https=8443 5173`.
- Give the user the exact HTTPS hostname and port returned by Serve. Never
  offer localhost, 127.0.0.1, 0.0.0.0 or a container address as a remote link.
- Configure the app's allowed hosts, WebSocket/HMR URL and browser-facing API
  URLs for that address. Prefer same-origin API requests. Do not disable host
  checks or allow every origin to make the preview work.
- Check the returned URL with curl and confirm it serves the expected app,
  not just an HTTP 200. State when access from the user's device is unverified.
- Keep the preview process alive for review, and report its service name or PID
  and the mapping's cleanup command. Remove only mappings you created.
- Do not enable Funnel, publish a public tunnel or open public firewall ports
  for a private preview. If networking permissions are missing, explain the
  required setup instead of replacing the URL with a local-only link.
```

For agents running inside WSL with Tailscale on Windows, add that distinction to
these instructions: manage Serve through the Windows `tailscale.exe` CLI if WSL
interop and permissions allow it, otherwise ask the user to run the supplied
PowerShell command. Verify that each preview port is reachable from Windows
before publishing it. Do not install a second VPN client inside WSL to work around
missing access.

Start a **new conversation** after editing to ensure the agent receives the new
instructions. Existing sessions may retain an older prompt. These instructions
are guidance, not an automatic VPN configuration or a network access control.

For a Vite preview behind Serve on HTTPS port 8443, adapt the existing configuration:

```js
server: {
  host: '127.0.0.1',
  port: 5173,
  strictPort: true,
  allowedHosts: ['REPLACE_WITH_REAL_HOSTNAME'],
  hmr: {
    host: 'REPLACE_WITH_REAL_HOSTNAME',
    protocol: 'wss',
    clientPort: 8443,
  },
},
```

The hostname fields contain only the full DNS name, without a scheme or port.
The HMR port is the external HTTPS port, while 5173 is the backend port. Other
frameworks have their own host and origin settings; consult their documentation.
See [Vite server options](https://vite.dev/config/server-options).

After stopping that preview's process, remove its proxy with:

```bash
tailscale serve --https=8443 off
```

## Other VPNs and browser-only access

**Existing WireGuard or another private VPN.** Keep your established VPN rather
than adding Tailscale just for Sillage. Configure a route to the host and an HTTPS
reverse proxy listening on its VPN interface, forwarding to Sillage's loopback
port. Restrict ingress to the intended VPN clients and use a certificate trusted
by their browsers. A VPN encrypts network traffic, but plain HTTP does not become
an HTTPS browser context. Replace the template's Tailscale commands with your
actual proxy procedure and private hostname. [WireGuard quick start](https://www.wireguard.com/quickstart/).

**Cloudflare Tunnel + Access.** This is an alternative when client VPN software
is undesirable. Configure an Access application and an explicit allow policy for
your users before making the route available. The tunnel alone is not an identity
gate. Keep the Sillage login too, and test live conversation updates and terminal
connections through the proxy. This path introduces Cloudflare into the traffic
path. [Cloudflare private web application guide](https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app/).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Works on the host, not the phone | Host awake, Sillage running, both devices connected to the VPN, access rules allowing the chosen port |
| Sillage opens, but the app preview does not | Separate Serve mapping and a running preview process |
| Host rejected or page opens without live reload | Exact allowed hostname and external WebSocket/HMR port |
| HTTPS error | Full hostname printed by Serve, HTTPS enabled, correct port; do not bypass certificate validation |
| PWA, microphone or notifications unavailable | HTTPS, browser support, installation requirements and permissions |
| Works until logout, sleep or restart | Host power settings and startup of Sillage, VPN and, if applicable, WSL |

A successful request from the host does not prove the phone's VPN permissions or
connectivity. Always complete the check from the device you intend to use.
