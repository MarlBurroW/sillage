# Dev-server previews

[Back to the feature reference](features.md)

When an agent starts a dev server (Vite, Next, Django…), Sillage shows it in the conversation
panel's **Preview** tab, can make a public **demo link** to it, and lets you **pick an element** of
the page to describe it to the agent. This page explains what an instance needs for that, and how
to set it up.

## What you need, by edition

| | Preview tab | Demo links | Element picking |
| --- | --- | --- | --- |
| **Desktop** | Works out of the box: the frame loads `127.0.0.1:<port>` directly | No (no public address) | No |
| **Server** with a preview domain | Yes | Yes | Yes |
| **Server** without one | The tab explains previews are not set up | No | No |

On Desktop off Linux, Sillage cannot list listening ports: type the port in the Preview tab.

## Why previews need a domain of their own

A preview runs the app's own code in your browser. If it were served under Sillage's address
(say `sillage.example.com/preview/5173`), that code would share Sillage's origin and could call
Sillage's API with your session. So each preview gets a **host of its own**:

```
https://pv-3f9a1c2b7d4e.preview.example.com/
        └── id ───────┘ └── preview domain ──┘
```

Sillage never creates DNS records or certificates. It relies on three things you set up once:

1. **A wildcard DNS record** `*.<preview domain>` pointing at your server, so any `pv-…` name
   reaches it.
2. **A wildcard TLS certificate** for `*.<preview domain>` (Let's Encrypt issues these through a
   DNS-01 challenge), so every preview is served over HTTPS.
3. **A reverse proxy rule** sending `pv-*` hosts to Sillage's **preview listener**: a second port,
   the main port + 1 (`7318` by default), or `SILLAGE_PREVIEW_PORT`, or `[previews] port` in
   `config.toml`. It listens on the same interface as Sillage (`SILLAGE_HOST`).

Then, as an administrator, enter the domain under **Settings › Previews** and press **Check**:
Sillage requests a preview host through your public address and says which link fails.

A dedicated subdomain (`preview.example.com`) keeps the wildcard away from your other services.
Reusing your main domain (`example.com`, hosts `pv-…example.com`) also works when its wildcard
already exists: only `pv-*` hosts must reach the preview listener.

## Reverse proxy examples

### Caddy

With a wildcard certificate obtained through your DNS provider's plugin:

```caddyfile
*.preview.example.com {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:7318
}
```

If a `*.example.com` block already serves other subdomains, add the rule inside it instead:

```caddyfile
*.example.com {
	@sillage_preview header_regexp Host ^pv-[a-f0-9]+\.example\.com$
	handle @sillage_preview {
		reverse_proxy 127.0.0.1:7318
	}
	handle {
		# your other subdomains
	}
}
```

Caddy proxies WebSockets (hot reload) without extra configuration.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name ~^pv-[a-f0-9]+\.preview\.example\.com$;
    ssl_certificate     /etc/ssl/wildcard.preview.example.com.crt;
    ssl_certificate_key /etc/ssl/wildcard.preview.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:7318;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Hot reload uses WebSockets.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

The proxy must keep the original `Host` header and send `X-Forwarded-Proto`: Sillage reads the
host to find the preview, and the scheme to set its cookie.

### Docker Compose

The image exposes `7318` next to `7317`. Publish it on the host's loopback, like the main port,
and point your reverse proxy at it ([example](../deploy/docker-compose.example.yml)):

```yaml
ports:
  - "127.0.0.1:7317:7317"
  - "127.0.0.1:7318:7318"
```

Previews show servers that agents start **inside the container**.

### Kubernetes (Helm)

The chart exposes the preview port on its Service. Enable the preview Ingress, which routes
`*.<domain>` to it:

```yaml
previews:
  enabled: true
  domain: preview.example.com
  tls:
    enabled: true
    secretName: sillage-previews-tls   # a kubernetes.io/tls Secret for *.preview.example.com
```

Wildcard certificates need a DNS-01 issuer (cert-manager) or a secret you create yourself.

## How access works

- Opening a preview from Sillage hands your browser a sign-in link valid for one minute, which
  sets a cookie on that preview host only. Previews only reach ports you see in **Services**:
  never Sillage itself, another account's private project, or whatever else listens on the
  machine.
- The app receives requests for `localhost:<port>`, so dev servers accept them without any
  allowed-hosts setup, and hot reload goes through.
- **Demo links** need no sign-in. They expire (an hour to 30 days), can be revoked, and serve the
  app only while its dev server still runs for its owner (checked at least every 30 seconds).
  Responses ask search engines not to index them.
- **Element picking** works through a small script Sillage adds to HTML pages of previews opened
  from Sillage, never to demo links.

## Troubleshooting

**Settings › Previews › Check** reports one of these:

| Result | Meaning | Fix |
| --- | --- | --- |
| Works | A preview host reached this Sillage | — |
| Name not found | No wildcard DNS record | Add `*.<preview domain>` (A/AAAA or CNAME) |
| Certificate refused | TLS failed | Issue a wildcard certificate for `*.<preview domain>` |
| Unreachable | Nothing answered on 443, or it timed out | Check the firewall and that the reverse proxy runs |
| Proxy cannot reach Sillage | The proxy answered 502/503/504 | Point the `pv-*` rule at the preview port (7318), published from the container if any |
| Not routed to Sillage | Something else answered | Add the `pv-*` rule, before any catch-all |
| Listener down | The preview port is taken | Free it, or set `SILLAGE_PREVIEW_PORT` |

The check runs from the server itself. A server that cannot reach its own public address (some
NAT setups) may report a failure while browsers succeed: open a preview to confirm.
