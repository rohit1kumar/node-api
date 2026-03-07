# Express Redis API — K3s Deployment Guide

## Prerequisites

- A server with [k3s](https://k3s.io/) installed (comes with Traefik ingress controller)
- `kubectl` configured to talk to your cluster
- Docker (to build and push the image)
- A domain with DNS A record pointing to your server's public IP

## Project Structure

```
deploy/
├── namespace.yaml        # Namespace for isolation
├── redis.yaml            # Redis deployment + PersistentVolumeClaim
├── redis-service.yaml    # Redis ClusterIP service (internal)
├── api.yaml              # API deployment (2 replicas)
├── api-service.yaml      # API NodePort service
├── cluster-issuer.yaml   # Let's Encrypt ClusterIssuer for TLS
└── ingress.yaml          # Ingress to expose API publicly with TLS
```

## Step 1 — Build and Push the Docker Image

```bash
docker build -t rohit1kumar/node-redis-api:1.1.1 .
docker push rohit1kumar/node-redis-api:1.1.1
```

## Step 2 — Install cert-manager

cert-manager handles automatic TLS certificate provisioning from Let's Encrypt.

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
```

Wait for all cert-manager pods to be ready:

```bash
kubectl wait --for=condition=Ready pods --all -n cert-manager --timeout=120s
```

## Step 3 — Deploy Everything

```bash
kubectl apply -f deploy/
```

This applies all manifests: namespace, Redis, API, services, ClusterIssuer, and Ingress.

## Step 4 — Verify the Deployment

Check all resources:

```bash
kubectl get all -n myapp
```

Check TLS certificate status:

```bash
kubectl get certificate -n myapp
```

Wait until `READY` is `True`, then test:

```bash
curl https://api.roht.me/health
```

## What Each Manifest Does

### Namespace (`namespace.yaml`)

Creates a dedicated `myapp` namespace to isolate resources from other workloads.

### Deployment (`api.yaml`, `redis.yaml`)

Defines how pods run. Key production settings used:

| Setting | Purpose |
|---|---|
| `runAsNonRoot: true` | Container cannot run as root |
| `readOnlyRootFilesystem: true` | Prevents writes to container filesystem |
| `allowPrivilegeEscalation: false` | Blocks privilege escalation |
| `capabilities.drop: [ALL]` | Drops all Linux capabilities |
| `resources.requests/limits` | Guarantees and caps CPU/memory |
| `livenessProbe` | Restarts pod if it becomes unhealthy |
| `readinessProbe` | Removes pod from service if not ready |
| `startupProbe` | Gives slow-starting containers time to initialize |
| `podAntiAffinity` | Spreads API replicas across nodes |
| `RollingUpdate (maxUnavailable: 0)` | Zero-downtime deployments |
| `automountServiceAccountToken: false` | Reduces attack surface |

Redis uses `Recreate` strategy (safe for single-replica stateful workload) and a `PersistentVolumeClaim` for data durability.

### Service (`api-service.yaml`, `redis-service.yaml`)

- **API Service** — `NodePort` on port `30000`, makes the API reachable on the node's IP
- **Redis Service** — `ClusterIP` (default), only reachable within the cluster. The API connects to Redis using the service name `redis` as hostname

### ClusterIssuer (`cluster-issuer.yaml`)

Tells cert-manager how to get TLS certificates from Let's Encrypt:

- Uses ACME protocol with HTTP-01 challenge
- Traefik serves the challenge response automatically
- **Important**: Update the `email` field to a real email — Let's Encrypt rejects `example.com` domains

### Ingress (`ingress.yaml`)

Exposes the API to the public internet:

- Routes traffic from the domain to the API service
- `ingressClassName: traefik` — tells k3s to use its built-in Traefik ingress controller
- `cert-manager.io/cluster-issuer` annotation triggers automatic TLS cert provisioning
- `tls` block defines the hostname and secret where the certificate is stored

## Debugging

### Certificate not issuing

```bash
kubectl describe certificate api-tls -n myapp
kubectl get challenges -n myapp
kubectl logs -n cert-manager -l app=cert-manager --tail=50
```

### ClusterIssuer not ready

```bash
kubectl describe clusterissuer letsencrypt-prod
```

Common fix: update the email in `cluster-issuer.yaml` to a real address and re-apply.

### Pods not starting

```bash
kubectl describe pod <pod-name> -n myapp
kubectl logs <pod-name> -n myapp
```

### Check all resources at once

```bash
kubectl get all,ingress,certificate,clusterissuer -n myapp
```

## Teardown

```bash
kubectl delete -f deploy/
```

## Learning Roadmap (Infra & K3s)

### Phase 1 — Strengthen K3s Fundamentals
- ConfigMaps & Secrets — externalize config, manage sensitive data (avoid hardcoded env vars)
- PersistentVolumes — understand StorageClasses, dynamic provisioning, backup strategies
- RBAC — create ServiceAccounts, Roles, ClusterRoles to lock down access
- Resource Quotas & LimitRanges — prevent a single namespace from consuming all cluster resources

### Phase 2 — Observability
- Prometheus + Grafana — cluster and app metrics, dashboards, alerting
- Loki — log aggregation (pairs well with Grafana, replaces manual `kubectl logs`)
- Uptime monitoring — external health checks (Uptime Kuma, Betteruptime)

### Phase 3 — CI/CD & GitOps
- GitHub Actions — automate Docker build, push, and deploy on git push
- ArgoCD or Flux — GitOps-based continuous deployment (cluster syncs from git repo)
- Image tagging strategy — semver, git SHA, avoid `latest` in production

### Phase 4 — Networking & Security
- NetworkPolicies — restrict pod-to-pod traffic (e.g., only API can talk to Redis)
- Pod Security Standards — enforce baseline/restricted policies cluster-wide
- Trivy / Kubescape — scan images and manifests for vulnerabilities
- Sealed Secrets or External Secrets Operator — secure secret management

### Phase 5 — High Availability & Scaling
- HorizontalPodAutoscaler (HPA) — auto-scale pods based on CPU/memory/custom metrics
- Multi-node k3s cluster — add worker nodes, understand node taints and tolerations
- etcd backup & restore — disaster recovery for cluster state
- PodDisruptionBudgets — ensure availability during node maintenance

### Phase 6 — Advanced Infrastructure
- Helm — package and version your manifests as reusable charts
- Kustomize — overlay-based manifest management (dev/staging/prod)
- Terraform — provision the server, DNS, firewall rules as code
- Ansible — automate k3s installation and node setup
