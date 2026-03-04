# Spec: k3s-infrastructure

> Terraform/OpenTofu-based infrastructure provisioning for fabrik k3s clusters — Hetzner Cloud native with NixOS

**Status**: draft  
**Version**: 1.1.1  
**Last Updated**: 2026-03-04  
**Provides**: Infrastructure foundation for k3s execution

---

## Changelog

- **v1.1.1** (2026-03-04): Standardized IaC on Terraform/OpenTofu only and updated state/bootstrap flow
- **v1.1.0** (2026-02-16): Added container build process, remote state backend (S3), clarified no external dependencies

---

## Identity

**What**: Infrastructure-as-code for k3s clusters using Terraform/OpenTofu with NixOS. Supports:
1. **Hetzner Cloud** - Native provider, optimal price/performance
2. **Manual bootstrap** - Existing servers via SSH + NixOS
3. **Extensible** - AWS, GCP, Azure via Terraform/OpenTofu providers

**Why Terraform/OpenTofu + NixOS**:
- Terraform/OpenTofu: State management, drift detection, infra as code
- NixOS: Declarative, reproducible, atomic upgrades, perfect for k3s nodes
- Hetzner: Best price/performance for compute in EU, native IPv6, no egress charges

**Not**: 
- Container-based nodes (we want k3s on proper VMs)
- Managed Kubernetes (EKS/GKE/AKS) - we want k3s for control and cost

---

## Goals

1. **One-command cluster**: `fabrik cluster init --provider hetzner` creates working k3s
2. **NixOS everywhere**: All nodes run NixOS for reproducibility
3. **Hetzner native**: Optimized for Hetzner Cloud (CX servers, volumes, networks)
4. **SSH bootstrap**: Support existing bare metal or VMs via SSH + NixOS install
5. **GitOps ready**: Terraform/OpenTofu state can be stored in S3, GCS, or local backends
6. **Multi-region**: Support multiple Hetzner locations (nbg1, fsn1, hel1)
7. **Disaster recovery**: Backup/restore etcd, PVC snapshots via Longhorn
8. **Terraform/OpenTofu compatibility**: Support Hetzner Terraform/OpenTofu + SSH for single-node and multi-node bootstrap

---

## Design Principles

This spec follows the design principles defined in `specs/051-k3s-orchestrator.md`.

---

## Determinism Rules (Required)

- **NixOS everywhere**: All nodes are built from a pinned Nix flake + lockfile.
- **Pinned k3s**: k3s version is explicitly pinned (no floating latest).
- **Pinned providers**: Terraform/OpenTofu providers must be version-pinned.
- **Immutable artifacts**: Any image or binary used in bootstrap must be referenced by digest or fixed version.

---

## Non-Goals

- Multi-cloud abstraction (start with Hetzner, add others later)
- Kubernetes-as-a-Service (we provision VMs, install k3s)
- Windows nodes (Linux/NixOS only)
- Legacy Docker Swarm / Nomad support

---

## Requirements

### Tooling (Required)

- `fabrik infra init` bootstraps a pinned Terraform/OpenTofu binary into `~/.cache/fabrik/tools/` and uses it for all runs.

### 0. Bootstrap Modes (Required)

**Single-node (Hetzner Terraform + SSH)**:
- Terraform provisions one NixOS node (Hetzner).
- SSH bootstrap installs k3s server (single-node control plane).
- Suitable for single-node Hetzner Terraform setups.

**Multi-node (Hetzner Terraform + SSH)**:
- Terraform provisions NixOS control plane + workers.
- SSH bootstrap installs k3s server on control plane, agents join via token.
- Default path for production multi-node clusters.

**Manual SSH (No cloud provisioning)**:
- Existing servers via SSH + `nixos-anywhere`, orchestrated by Terraform/OpenTofu.
- Same join logic as above.

### 1. Node Join / Remove (Required)

- **Join**: Workers join using the k3s token from the control plane.
- **Remove**: Terraform destroy removes worker nodes cleanly; cluster remains healthy.
- **Autoscaling**: Node pool scaling is done via Terraform (or provider API), and new nodes join via the same SSH bootstrap flow.

### 2. Architecture Overview

```
┌─ Terraform/OpenTofu Root Module: fabrik-infrastructure ─────────────────────┐
│                                                                             │
│  ┌─ Entry: main.tf ──────────────────────────────────────────────────────┐ │
│  │  ├─ Parse config (provider, region, node count, types)                 │ │
│  │  ├─ Instantiate provider (Hetzner | AWS | Manual)                      │ │
│  │  └─ Output: kubeconfig, cluster endpoints, node IPs                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─ Providers ────────────────────────────────────────────────────────────┐ │
│  │                                                                          │ │
│  │  ┌─ Hetzner Cloud ──────────────────────────────────────────────────┐   │ │
│  │  │  ├─ Network (VPC)                                                 │   │ │
│  │  │  ├─ Firewall (k3s ports: 6443, 10250, 2379, 2380, 8472)        │   │ │
│  │  │  ├─ CX21/CX31/CX41 servers (NixOS via rescue system)            │   │ │
│  │  │  ├─ Volumes (Longhorn storage)                                    │   │ │
│  │  │  ├─ Load Balancer (k3s API + ingress)                           │   │ │
│  │  │  └─ Floating IPs (optional, for API endpoint stability)            │   │ │
│  │  └───────────────────────────────────────────────────────────────────┘   │ │
│  │                                                                          │ │
│  │  ┌─ Manual/SSH ──────────────────────────────────────────────────────┐   │ │
│  │  │  ├─ Existing servers (SSH access required)                       │   │ │
│  │  │  ├─ NixOS installation via nixos-anywhere                       │   │ │
│  │  │  ├─ k3s installation via SSH                                    │   │ │
│  │  │  └─ No cloud resources created (bring your own infra)           │   │ │
│  │  └───────────────────────────────────────────────────────────────────┘   │ │
│  │                                                                          │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─ NixOS Configuration ─────────────────────────────────────────────────┐   │
│  │  ├─ base.nix - Common to all nodes (SSH, k3s binaries, tools)        │   │
│  │  ├─ server.nix - Control plane (k3s server, etcd, API)               │   │
│  │  ├─ agent.nix - Worker nodes (k3s agent, containerd)                │   │
│  │  └─ storage.nix - Longhorn, local-path-provisioner                  │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└───────────────────────────────────────────────────────────────────────────────┘

┌─ Deployed Cluster (Hetzner Example) ─────────────────────────────────────────┐
│                                                                             │
│  ┌─ Location: nbg1 ──────────────────────────────────────────────────────┐   │
│  │                                                                          │   │
│  │  ┌─ Server: fabrik-cp-1 (CX31: 4 vCPU, 16GB) ─────────────────────────┐   │   │
│  │  │  NixOS: k3s server, control plane, etcd                           │   │   │
│  │  │  IP: 10.0.1.10 (internal), 116.203.x.x (public)                  │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                          │   │
│  │  ┌─ Server: fabrik-worker-1 (CX21: 2 vCPU, 8GB) ────────────────────┐   │   │
│  │  │  NixOS: k3s agent, workloads                                     │   │   │
│  │  │  IP: 10.0.1.20 (internal)                                        │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                          │   │
│  │  ┌─ Server: fabrik-worker-2 (CX21: 2 vCPU, 8GB) ────────────────────┐   │   │
│  │  │  NixOS: k3s agent, workloads                                     │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                          │   │
│  │  ┌─ Load Balancer ────────────────────────────────────────────────────┐   │   │
│  │  │  ├─ Listener: 6443 → fabrik-cp-1:6443 (k3s API)                  │   │   │
│  │  │  └─ Listener: 443 → workers:443 (ingress, via Hetzner LB)         │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                          │   │
│  │  ┌─ Volumes ──────────────────────────────────────────────────────────┐   │   │
│  │  │  ├─ Longhorn storage (replicated across workers)                   │   │   │
│  │  │  └─ Local-path (fast local SSD)                                    │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                          │   │
│  └───────────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3. Terraform/OpenTofu Configuration Schema

```hcl
# variables.tf
variable "name" {
  type = string
}

variable "ssh_public_key_path" {
  type = string
}

variable "provider" {
  type = string
  validation {
    condition     = contains(["hetzner", "manual", "aws", "gcp"], var.provider)
    error_message = "provider must be one of: hetzner, manual, aws, gcp"
  }
}

variable "hetzner" {
  type = object({
    token        = string
    location     = string
    network_zone = string
    control_plane = object({
      server_type        = string
      count              = number
      enable_floating_ip = bool
    })
    workers = object({
      server_type = string
      count       = number
      volumes = list(object({
        size   = number
        format = string
        mount  = string
      }))
    })
    networking = object({
      ip_range    = string
      subnet      = string
      enable_ipv6 = bool
    })
    load_balancer = object({
      type     = string
      location = string
    })
    firewall = object({
      allowed_cidr = list(string)
    })
  })
  default = null
}

variable "manual_nodes" {
  type = list(object({
    name         = string
    host         = string
    port         = number
    user         = string
    ssh_key_path = string
    role         = string
    architecture = string
    nixos_disk   = optional(string)
  }))
  default = []
}

variable "k3s" {
  type = object({
    version           = string
    cluster_cidr      = string
    service_cidr      = string
    cluster_dns       = string
    tls_san           = list(string)
    datastore         = string
    external_ds       = optional(object({ endpoint = string }))
    disable           = list(string)
    flannel_backend   = string
    server_extra_args = list(string)
    agent_extra_args  = list(string)
  })
}

variable "nixos" {
  type = object({
    channel       = string
    flake         = optional(string)
    extra_modules = list(string)
  })
}

variable "addons" {
  type = object({
    longhorn = object({
      enabled               = bool
      version               = string
      default_storage_class = bool
      replica_count         = number
    })
    metallb = object({
      enabled   = bool
      addresses = list(string)
    })
    cert_manager = object({
      enabled = bool
      version = string
      issuer  = string
    })
    laos = object({
      enabled     = bool
      persistence = bool
    })
  })
}

variable "kubeconfig_path" {
  type = string
  default = "~/.kube/config"
}

# terraform.tfvars (example)
provider = "hetzner"

hetzner = {
  token        = "${HCLOUD_TOKEN}"
  location     = "nbg1"
  network_zone = "eu-central"
  control_plane = {
    server_type        = "cx31"
    count              = 1
    enable_floating_ip = false
  }
  workers = {
    server_type = "cx21"
    count       = 2
    volumes = [
      { size = 50, format = "ext4", mount = "/var/lib/longhorn" }
    ]
  }
  networking = {
    ip_range    = "10.0.0.0/16"
    subnet      = "10.0.1.0/24"
    enable_ipv6 = true
  }
  load_balancer = {
    type = "lb11"
    location = "nbg1"
  }
  firewall = {
    allowed_cidr = ["0.0.0.0/0"]
  }
}

k3s = {
  version           = "v1.29.0+k3s1"
  cluster_cidr      = "10.42.0.0/16"
  service_cidr      = "10.43.0.0/16"
  cluster_dns       = "10.43.0.10"
  tls_san           = ["fabrik-api.example.com"]
  datastore         = "embedded"
  disable           = ["traefik", "servicelb"]
  flannel_backend   = "vxlan"
  server_extra_args = []
  agent_extra_args  = []
}

# NOTE: Terraform/OpenTofu backend config is set in a separate backend block
```

### 4. NixOS Module for k3s

```nix
# nixos/modules/k3s-node.nix
{ config, lib, pkgs, ... }:

let
  cfg = config.services.fabrik-k3s;
in
{
  options.services.fabrik-k3s = {
    enable = lib.mkEnableOption "Fabrik k3s node";
    
    role = lib.mkOption {
      type = lib.types.enum [ "server" "agent" ];
      description = "k3s role: server (control plane) or agent (worker)";
    };
    
    serverUrl = lib.mkOption {
      type = lib.types.str;
      description = "k3s server URL for agents";
      default = "";
    };
    
    token = lib.mkOption {
      type = lib.types.str;
      description = "k3s join token (from /var/lib/rancher/k3s/server/token on first server)";
      default = "";
    };
    
    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Extra k3s arguments";
    };
    
    # Fabrik-specific
    fabrikLabels = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = {};
      example = {
        "fabrik.sh/role" = "worker";
        "fabrik.sh/cost-center" = "team-a";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # k3s service
    services.k3s = {
      enable = true;
      role = cfg.role;
      serverAddr = lib.mkIf (cfg.role == "agent") cfg.serverUrl;
      token = lib.mkIf (cfg.role == "agent") cfg.token;
      extraFlags = lib.concatStringsSep " " cfg.extraArgs;
    };
    
    # Containerd needs to start before k3s
    systemd.services.k3s.after = [ "containerd.service" "network-online.target" ];
    systemd.services.k3s.wants = [ "network-online.target" ];
    
    # Required kernel modules
    boot.kernelModules = [ "overlay" "br_netfilter" ];
    
    # Sysctl for networking
    boot.kernel.sysctl = {
      "net.bridge.bridge-nf-call-iptables" = 1;
      "net.bridge.bridge-nf-call-ip6tables" = 1;
      "net.ipv4.ip_forward" = 1;
      "net.ipv4.conf.all.forwarding" = 1;
    };
    
    # Firewall - allow k3s ports
    networking.firewall.allowedTCPPorts = [ 
      6443   # k3s API
      10250  # kubelet metrics
      2379 2380  # etcd (if embedded)
      10251 10252  # kube-scheduler, controller
      30000-32767  # NodePort services
    ];
    networking.firewall.allowedUDPPorts = [
      8472   # Flannel VXLAN
      51820 51821  # Wireguard (if using flannel wireguard)
    ];
    
    # Longhorn dependencies
    environment.systemPackages = with pkgs; [
      openiscsi
      nfs-utils
      util-linux
    ];
    
    services.openiscsi.enable = true;
    
    # Node labels (applied via kubectl after join)
    systemd.services.fabrik-labels = lib.mkIf (cfg.role == "agent") {
      description = "Apply fabrik node labels";
      after = [ "k3s.service" ];
      requires = [ "k3s.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = pkgs.writeShellScript "apply-labels" ''
          export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
          ${pkgs.kubectl}/bin/kubectl label node ${config.networking.hostName} \
            ${lib.concatStringsSep " " (lib.mapAttrsToList (k: v: "${k}=${v}") cfg.fabrikLabels)} \
            --overwrite || true
        '';
      };
    };
  };
}
```

### 5. Container Image Build (Nix)

Smithers runs as a container in k3s. We build via Nix for reproducibility.

**Build:**
```bash
nix build .#fabrik-smithers-image
docker load < result
docker tag fabrik-smithers:latest ghcr.io/fabrik/smithers:v1.2.3
docker push ghcr.io/fabrik/smithers:v1.2.3
```

**Image:** ~50-100MB, non-root user (1000:1000), multi-arch support.

### 6. Terraform/OpenTofu State (Self-Hosted)

No Terraform Cloud. Options:
- **S3**: Remote state with encryption and locking
- **GCS**: Remote state with object versioning
- **Local**: `terraform.tfstate` in a dedicated state directory

```hcl
# backend.tf
terraform {
  backend "s3" {
    bucket         = "fabrik-state"
    key            = "clusters/prod/terraform.tfstate"
    region         = "eu-central-1"
    encrypt        = true
    dynamodb_table = "fabrik-terraform-locks"
  }
}
```

State is encrypted at rest and backed up to S3 daily. OpenTofu uses the same backend configuration.

### 7. Terraform/OpenTofu Hetzner Implementation

```hcl
# main.tf
terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = ">= 1.48.0, < 2.0.0"
    }
  }
}

provider "hcloud" {
  token = var.hetzner.token
}

resource "hcloud_network" "net" {
  name     = "${var.name}-net"
  ip_range = var.hetzner.networking.ip_range
  labels   = { managed_by = "fabrik" }
}

resource "hcloud_network_subnet" "subnet" {
  network_id   = hcloud_network.net.id
  type         = "cloud"
  network_zone = var.hetzner.network_zone
  ip_range     = var.hetzner.networking.subnet
}

resource "hcloud_firewall" "fw" {
  name = "${var.name}-fw"
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.hetzner.firewall.allowed_cidr
    description = "SSH"
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "6443"
    source_ips = var.hetzner.firewall.allowed_cidr
    description = "k3s API"
  }
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "8472"
    source_ips = [var.hetzner.networking.ip_range]
    description = "flannel"
  }
}

resource "hcloud_ssh_key" "ssh" {
  name       = "${var.name}-key"
  public_key = file(var.ssh_public_key_path)
}

resource "hcloud_server" "control_plane" {
  name         = "${var.name}-cp-1"
  server_type  = var.hetzner.control_plane.server_type
  image        = "ubuntu-22.04"
  location     = var.hetzner.location
  ssh_keys     = [hcloud_ssh_key.ssh.id]
  firewall_ids = [hcloud_firewall.fw.id]
  networks     = [{ network_id = hcloud_network.net.id, ip = "10.0.1.10" }]
  labels       = { role = "control-plane", cluster = var.name }

  user_data = <<-CLOUD
    #cloud-config
    runcmd:
      - curl -L https://github.com/nix-community/nixos-images/releases/download/nixos-24.11/nixos-kexec-installer-x86_64-linux | bash
      - mkdir -p /mnt/etc/nixos
      - echo '${file("${path.module}/nixos/control-plane.nix")}' > /mnt/etc/nixos/configuration.nix
      - nixos-install --root /mnt --no-root-passwd
      - reboot
  CLOUD
}

resource "hcloud_server" "workers" {
  count       = var.hetzner.workers.count
  name        = "${var.name}-worker-${count.index + 1}"
  server_type = var.hetzner.workers.server_type
  image       = "ubuntu-22.04"
  location    = var.hetzner.location
  ssh_keys    = [hcloud_ssh_key.ssh.id]
  firewall_ids = [hcloud_firewall.fw.id]
  networks    = [{ network_id = hcloud_network.net.id, ip = "10.0.1.${20 + count.index}" }]
  labels      = { role = "worker", cluster = var.name }
}

resource "hcloud_load_balancer" "lb" {
  name               = "${var.name}-lb"
  load_balancer_type = var.hetzner.load_balancer.type
  location           = var.hetzner.load_balancer.location
}

resource "hcloud_load_balancer_network" "lb_net" {
  load_balancer_id = hcloud_load_balancer.lb.id
  network_id       = hcloud_network.net.id
  ip               = "10.0.1.5"
}

resource "hcloud_load_balancer_service" "api" {
  load_balancer_id = hcloud_load_balancer.lb.id
  protocol         = "tcp"
  listen_port      = 6443
  destination_port = 6443
}

resource "hcloud_load_balancer_target" "cp_target" {
  load_balancer_id = hcloud_load_balancer.lb.id
  type             = "server"
  server_id        = hcloud_server.control_plane.id
  use_private_ip   = true
}

resource "hcloud_volume" "worker_volume" {
  count     = var.hetzner.workers.count
  name      = "${var.name}-storage-${count.index + 1}"
  size      = 50
  server_id = hcloud_server.workers[count.index].id
  format    = "ext4"
  location  = var.hetzner.location
  labels    = { purpose = "longhorn", cluster = var.name }
}

output "control_plane_ip" { value = hcloud_server.control_plane.ipv4_address }
output "worker_ips" { value = hcloud_server.workers[*].ipv4_address }
output "api_endpoint" { value = hcloud_load_balancer.lb.ipv4 }
```

### 8. Manual/SSH Bootstrap (Terraform/OpenTofu)

```hcl
# manual-bootstrap.tf
locals {
  control_plane = one([for n in var.manual_nodes : n if n.role == "control-plane"])
  workers       = [for n in var.manual_nodes : n if n.role == "worker"]
}

resource "null_resource" "install_control_plane" {
  connection {
    host        = local.control_plane.host
    port        = local.control_plane.port
    user        = local.control_plane.user
    private_key = file(local.control_plane.ssh_key_path)
  }

  provisioner "remote-exec" {
    inline = [
      "curl -L https://github.com/nix-community/nixos-anywhere/releases/latest/download/nixos-anywhere-${local.control_plane.architecture}-linux -o /tmp/nixos-anywhere",
      "chmod +x /tmp/nixos-anywhere",
      "/tmp/nixos-anywhere --flake /tmp/nixos-config#${local.control_plane.name} root@${local.control_plane.host}"
    ]
  }
}

resource "null_resource" "fetch_k3s_token" {
  depends_on = [null_resource.install_control_plane]

  provisioner "local-exec" {
    command = "ssh -i ${local.control_plane.ssh_key_path} -p ${local.control_plane.port} ${local.control_plane.user}@${local.control_plane.host} 'cat /var/lib/rancher/k3s/server/token' > .k3s-token"
  }
}

resource "null_resource" "install_workers" {
  for_each = { for n in local.workers : n.name => n }

  depends_on = [null_resource.fetch_k3s_token]

  connection {
    host        = each.value.host
    port        = each.value.port
    user        = each.value.user
    private_key = file(each.value.ssh_key_path)
  }

  provisioner "remote-exec" {
    inline = [
      "curl -L https://github.com/nix-community/nixos-anywhere/releases/latest/download/nixos-anywhere-${each.value.architecture}-linux -o /tmp/nixos-anywhere",
      "chmod +x /tmp/nixos-anywhere",
      "K3S_TOKEN=${trimspace(file(\".k3s-token\"))} /tmp/nixos-anywhere --flake /tmp/nixos-config#${each.value.name} root@${each.value.host}"
    ]
  }
}

output "kubeconfig_command" {
  value = "ssh -i ${local.control_plane.ssh_key_path} ${local.control_plane.user}@${local.control_plane.host} 'cat /etc/rancher/k3s/k3s.yaml' | sed 's/127.0.0.1/${local.control_plane.host}/g'"
}
```

### 8. Post-Provisioning: Add-ons

### 9. Post-Provisioning: Add-ons (Terraform Helm Provider)

```hcl
# addons.tf
provider "kubernetes" {
  config_path = var.kubeconfig_path
}

provider "helm" {
  kubernetes {
    config_path = var.kubeconfig_path
  }
}

resource "helm_release" "longhorn" {
  name       = "longhorn"
  repository = "https://charts.longhorn.io"
  chart      = "longhorn"
  version    = var.addons.longhorn.version
  namespace  = "longhorn-system"
  create_namespace = true

  values = [yamlencode({
    persistence = {
      defaultClass = var.addons.longhorn.default_storage_class
      defaultClassReplicaCount = var.addons.longhorn.replica_count
    }
  })]
}

resource "helm_release" "prometheus" {
  name       = "kube-prometheus-stack"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  version    = "55.0.0"
  namespace  = "monitoring"
  create_namespace = true
}

resource "kubernetes_namespace" "fabrik_system" {
  metadata { name = "fabrik-system" }
}

resource "kubernetes_namespace" "fabrik_runs" {
  metadata { name = "fabrik-runs" }
}
```

## CLI Commands

```bash
# Initialize infrastructure project
fabrik infra init my-cluster --provider hetzner --location nbg1

# Preview changes
fabrik infra preview

# Deploy cluster
fabrik infra up

# Get kubeconfig
fabrik infra kubeconfig > ~/.kube/config

# SSH to nodes (via Terraform/OpenTofu output)
fabrik infra ssh control-plane-1
fabrik infra ssh worker-1

# Scale workers
fabrik infra config set worker.count 5
fabrik infra up

# Upgrade k3s version
fabrik infra config set k3s.version v1.30.0+k3s1
fabrik infra up

# Destroy cluster
fabrik infra destroy

# Manual bootstrap
fabrik infra init manual-cluster --provider manual --nodes-file nodes.yaml

# nodes.yaml example:
# nodes:
#   - name: cp-1
#     host: 116.203.x.x
#     user: root
#     sshKeyPath: ~/.ssh/id_ed25519
#     role: control-plane
#     nixosDisk: /dev/sda
#   - name: worker-1
#     host: 116.203.y.y
#     user: root
#     sshKeyPath: ~/.ssh/id_ed25519
#     role: worker
```

---

## Acceptance Criteria

- [ ] Single-node k3s cluster can be bootstrapped via SSH (Terraform-provisioned Hetzner node).
- [ ] Multi-node k3s cluster can be bootstrapped via Terraform + SSH (Hetzner focus).
- [ ] Workers join cluster automatically using k3s token.
- [ ] Nodes can be added/removed cleanly (Terraform apply/destroy) without breaking the cluster.
- [ ] Autoscaling use case supported by Terraform-managed node pool (join/remove via SSH bootstrap).
- [ ] `fabrik infra init --provider hetzner` creates Terraform/OpenTofu project with Hetzner config
- [ ] `fabrik infra up` provisions NixOS servers with k3s installed
- [ ] Control plane accessible via load balancer on port 6443
- [ ] Workers join cluster automatically using k3s token
- [ ] Longhorn deployed as default storage class
- [ ] `fabrik infra kubeconfig` outputs valid kubeconfig for kubectl
- [ ] Nodes labeled with `fabrik.sh/role` and other configured labels
- [ ] Manual provider works with existing servers via SSH + nixos-anywhere
- [ ] Terraform/OpenTofu state stored in configured backend (S3, GCS, local)
- [ ] `fabrik infra destroy` cleanly removes all cloud resources
- [ ] NixOS configuration can be customized via extra modules
- [ ] Firewall rules correctly restrict k3s ports
- [ ] IPv6 enabled and working on Hetzner (native dual-stack)

---

## Assumptions

1. **Hetzner account**: User has Hetzner Cloud account and API token
2. **SSH keys**: Ed25519 SSH key pair exists (~/.ssh/id_ed25519)
3. **Terraform/OpenTofu**: Bootstrapped by `fabrik infra init` (no system install required)
4. **NixOS**: For manual bootstrap, servers have internet access for nixos-anywhere
5. **Node access**: Root or sudo access on manual nodes for NixOS installation
6. **Architecture**: x86_64 supported first, aarch64 can be added
7. **DNS**: For production, DNS records point to load balancer IPs
8. **TLS**: k3s generates self-signed certs (or use valid certs via TLS SANs)
9. **Cost awareness**: User understands Hetzner pricing (CX21 ≈ €5.35/month)
10. **State security**: Terraform/OpenTofu state contains secrets, store in S3 with encryption and locking

---

## Glossary

- **Terraform/OpenTofu**: Declarative infrastructure-as-code using HCL and providers
- **NixOS**: Declarative Linux distribution, atomic upgrades, reproducible
- **Hetzner Cloud**: German cloud provider, affordable, EU-focused
- **k3s**: Lightweight Kubernetes distribution by Rancher
- **Longhorn**: Cloud-native distributed block storage for Kubernetes
- **nixos-anywhere**: Tool to install NixOS on any Linux system via SSH
- **CX21/CX31**: Hetzner server types (2 vCPU/8GB and 4 vCPU/16GB)
- **Rescue system**: Hetzner's netboot environment for OS installation
- **Load Balancer**: Hetzner LB service for traffic distribution
- **Floating IP**: Static IP that can be moved between servers

---

## Future Extensions

- **AWS provider**: EKS-style but with k3s on EC2
- **GCP provider**: GKE-style but with k3s on Compute Engine
- **Bare metal**: Extend manual provider with IPMI support
- **Multi-region**: Hetzner locations with VPN mesh
- **Auto-scaling**: Cluster autoscaler for worker nodes
- **GitOps**: Flux/ArgoCD pre-installed
- **Backup**: etcd backup to S3, Velero for workloads

---

## Changelog

- **v1.1.1** (2026-03-04): Standardized IaC on Terraform/OpenTofu only and updated state/bootstrap flow
- **v1.1.0** (2026-02-16): Added container build process and remote state backend (S3)
- **v1.0.0** (2026-02-16): Initial specification
  - Hetzner Cloud native support
  - Manual/SSH bootstrap via nixos-anywhere
  - NixOS + k3s architecture
  - Terraform/OpenTofu-based IaC
  - Longhorn storage
  - LAOS in-cluster deployment
