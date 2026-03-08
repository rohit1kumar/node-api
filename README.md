# Express Redis API — Kubernetes Deployment Guide

Tested on **k3s** and **MicroK8s** (v1.32+, which now ships Traefik as the default ingress controller).

## Prerequisites

- A server with [k3s](https://k3s.io/) or [MicroK8s](https://microk8s.io/) installed
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

## Step 2 — Enable Cluster Addons

**MicroK8s:**
```bash
microk8s enable dns
microk8s enable hostpath-storage   # default StorageClass for the Redis PVC
microk8s enable ingress            # installs Traefik (v1.32+)
microk8s enable cert-manager
```

**k3s:** Traefik and local-path storage come pre-installed. Install cert-manager manually:
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
kubectl wait --for=condition=Ready pods --all -n cert-manager --timeout=120s
```

## Step 3 — Deploy Everything

Apply namespace first to avoid a race condition where other resources are created before the namespace exists:

```bash
kubectl apply -f deploy/namespace.yaml && kubectl apply -f deploy/
```

> `kubectl apply -f deploy/` sends all files to the API server nearly simultaneously. The namespace
> may not be fully registered before `api.yaml` and `ingress.yaml` are processed, causing
> `namespaces "myapp" not found` errors. Applying namespace first and re-running is the fix.

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
- `ingressClassName: traefik` — works for both k3s and MicroK8s v1.32+
- `cert-manager.io/cluster-issuer` annotation triggers automatic TLS cert provisioning
- `tls` block defines the hostname and secret where the certificate is stored

### ClusterIssuer solver field (`cluster-issuer.yaml`)

cert-manager v1.19+ uses `ingressClassName:` inside the HTTP01 solver block. The older `class:` field is deprecated:

```yaml
solvers:
  - http01:
      ingress:
        ingressClassName: traefik   # correct for cert-manager v1.19+
        # class: traefik            # deprecated
```

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

## Where Are Logs Stored?

Kubernetes captures stdout/stderr from every container automatically.

**View logs via kubectl:**

```bash
kubectl logs -n myapp -l app.kubernetes.io/name=api -f
kubectl logs -n myapp -l app.kubernetes.io/name=redis -f
```

**On the node's filesystem:**

```
/var/log/pods/myapp_<pod-name>_<pod-uid>/<container-name>/0.log
/var/log/containers/<pod-name>_<container-name>_<container-id>.log
```

**Important:** Logs do not survive pod deletion/restart. k3s rotates logs at 10MB by default. For persistent logs, use a log aggregation stack (Loki + Grafana, EFK).

## Cluster Networking Notes

### Cross-node pod communication

Pods on different nodes communicate directly — the control plane is never in the data path.
When the `api` pod (on the worker node) connects to `redis:6379`, CoreDNS resolves `redis` to
the ClusterIP Service, and kube-proxy routing rules on every node forward it directly to the
Redis pod (on the control plane node) via the Calico overlay network.

```
Worker Node                          Control Plane Node
api pod ──► kube-proxy ──────────────────────► redis pod
            (local routing rules,               (via Calico overlay)
             no hop through CP)
```

The control plane only handles cluster management (scheduling, API, etcd) — never live app traffic.

### What the control plane actually does vs what Traefik does

- **Traefik** — handles external HTTP/HTTPS traffic, routes by hostname/path to backend services
- **Control plane** — receives `kubectl` commands, schedules pods, stores cluster state in etcd

Traefik runs as a pod on cluster nodes. The control plane has nothing to do with request routing.

### Traffic flow in this setup

```
DNS api.roht.me ──► Control Plane public IP
                         │
                    Traefik pod (on CP node)
                         │
                    api Service (ClusterIP)
                         │
                    api pods (on any node, via Calico)
```

DNS points to the control plane only because that's the node with a public IP — not because the
control plane is special for routing. Traefik on the worker node could serve traffic equally well.

## Production Load Balancing

In production with multiple nodes, you put a **Load Balancer** in front of all nodes so traffic
is distributed and no single node is a bottleneck or single point of failure.

```
DNS api.roht.me ──► Load Balancer (public IP)
                         │
              ┌──────────┴──────────┐
         Node 1 (CP)           Node 2 (Worker)
         Traefik pod           Traefik pod
              └──────────┬──────────┘
                         │
                   api pods (on any node)
```

The LB health-checks both nodes and removes unhealthy ones automatically.

**On cloud providers (AWS/GCP/Azure/Hetzner):** Create a `Service` with `type: LoadBalancer` and
the cloud controller provisions a real LB and assigns it a public IP automatically.

**On bare metal / Hetzner specifically:**
1. Create a Hetzner Load Balancer from the console
2. Add both nodes as targets on ports 80 and 443
3. Worker node does not need a public IP — the LB reaches it via the private network
4. Point your DNS to the LB's public IP instead of the control plane IP

Alternatively, use [MetalLB](https://metallb.universe.tf/) to get `LoadBalancer` Service support
on bare metal clusters.

### TLS at the Load Balancer (skipping cert-manager)

When nodes are in a private VPC behind a LB, TLS can be terminated at the LB instead of inside
the cluster. This removes the need for cert-manager, ClusterIssuer, and the `tls` block in Ingress.

```
Internet ──HTTPS──► Load Balancer (cert lives here) ──HTTP──► Nodes (private VPC)
```

The LB decrypts once; internal traffic stays plain HTTP inside the private network.
Remove the `tls` block and `cert-manager.io/cluster-issuer` annotation from `ingress.yaml` when
using this pattern.

| | TLS at Load Balancer | TLS at cluster (cert-manager) |
|---|---|---|
| Complexity | Lower | Higher |
| Internal traffic | Plain HTTP (trust your VPC) | Encrypted end-to-end |
| Best for | Standard prod, VPC-isolated clusters | Zero-trust, regulated environments |

## Learning Roadmap (Infra & Kubernetes)

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
- Multi-node cluster — add worker nodes, understand node taints and tolerations
- Load Balancer — put LB in front of all nodes (Hetzner LB, MetalLB, or cloud LB Service)
- etcd backup & restore — disaster recovery for cluster state
- PodDisruptionBudgets — ensure availability during node maintenance

### Phase 6 — Advanced Infrastructure
- Helm — package and version your manifests as reusable charts
- Kustomize — overlay-based manifest management (dev/staging/prod)
- Terraform — provision the server, DNS, firewall rules as code
- Ansible — automate k3s installation and node setup
