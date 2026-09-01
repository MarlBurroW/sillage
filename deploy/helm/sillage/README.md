# Sillage Helm chart

Deploys Sillage on Kubernetes from the `ghcr.io/marlburrow/sillage` image. It is
the same deployment as `deploy/docker-compose.example.yml`: same volumes, same
constraints.

## Install

```bash
helm install sillage ./deploy/helm/sillage \
  --namespace sillage --create-namespace \
  --set storage.data.storageClass=<a-block-storage-class> \
  --set storage.home.storageClass=<a-block-storage-class> \
  --set ingress.enabled=true \
  --set ingress.host=sillage.example.com
```

Then create the first account, which is admin. The command reads stdin, hence
the `-it`:

```bash
kubectl -n sillage exec -it deploy/sillage -- node /app/server/cli/user-create.js
```

## What it deploys

| Object | Role |
|---|---|
| `Deployment` | one replica, `Recreate` strategy |
| `Service` | ClusterIP on 7317 |
| `PersistentVolumeClaim` ×1–3 | `data` (required), `home`, `workspace` |
| `ConfigMap` | `config.toml`, only when `config` is set |
| `Ingress` | optional |

## Things to know

**One replica, never two.** The state lives in a SQLite database in WAL mode on a
`ReadWriteOnce` volume. Two pods writing to it means corruption. That is why
`replicas` is not exposed in the values, and why the strategy is `Recreate`: a
rolling update would start the new pod before stopping the old one, and it would
wait forever on a volume the old pod still holds. A short downtime is the trade.

**No NFS for the `data` volume.** SQLite relies on file locks that NFS does not
implement reliably. And leaving `storageClass` empty is not a neutral choice:
when several StorageClasses are marked as default, Kubernetes reports nothing and
silently picks the most recently created one. Name a block storage class
explicitly.

**The agent CLIs are not in the image.** They weigh 263 and 347 MB. Sillage
installs the ones you use from the UI, into the `data` volume, so they survive
pod replacement. You then authenticate them from inside the pod
(`kubectl exec -it ... -- bash`); the `home` volume keeps their credentials
(`~/.claude`, `~/.codex`) across restarts.

**The pod needs egress** to the npm registry (installing the CLIs), the GitHub
API (update check), the agent APIs and the browsers' Web Push endpoints. A strict
NetworkPolicy will break CLI installation.

**Sillage does not do TLS.** Terminate it at the ingress. The server runs with
`trustProxy`, so it trusts `X-Forwarded-*` headers: do not expose the Service
directly.

**Back up `<data>/secret.key` along with the database.** That AES-256-GCM key
encrypts stored secrets and git credentials; losing it makes them unreadable even
with an intact database. The PVCs the chart creates carry
`helm.sh/resource-policy: keep`, so they survive `helm uninstall`.

## Main values

| Key | Default | Notes |
|---|---|---|
| `image.tag` | `""` (= `appVersion`) | prefer a pinned tag over `latest` |
| `storage.data.storageClass` | `""` | **set this**, block storage |
| `storage.data.size` | `20Gi` | the database grows with history |
| `storage.home.enabled` | `true` | agent CLI credentials |
| `storage.workspace.enabled` | `false` | your git repositories |
| `config` | `""` | contents of `config.toml` |
| `resources.limits.memory` | `3Gi` | ~110 MB daemon + 400–500 MB per session |
| `ingress.className` | `nginx` | set it to match your controller |

Behind an ingress, set `publicUrl` in `config`: without it, absolute links are
derived from the `Host` header.

Every other value is commented in `values.yaml`.

## Upgrade

```bash
helm upgrade sillage ./deploy/helm/sillage --reuse-values --set image.tag=0.6.0
```

Schema migrations run at server startup, before the port opens, so no init Job is
needed. On a large database they take a while, which the `startupProbe` tolerates
(up to 5 minutes by default).

## Probes

All three probes target `/api/health`, not `/health`: any unknown route falls
back to the SPA, which answers `200` with HTML, so a probe on `/health` would
stay green with a broken server. `/api/health` returns JSON and needs no
authentication.
