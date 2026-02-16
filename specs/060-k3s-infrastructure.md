# Spec: k3s-infrastructure

> Pulumi-based infrastructure provisioning for fabrik k3s clusters — Hetzner Cloud native with NixOS

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Depends On**: `050-k3s-orchestrator`  
**Provides**: Infrastructure foundation for k3s execution

---

## Identity

**What**: Infrastructure-as-code for k3s clusters using Pulumi with NixOS. Supports:
1. **Hetzner Cloud** - Native provider, optimal price/performance
2. **Manual bootstrap** - Existing servers via SSH + NixOS
3. **Extensible** - AWS, GCP, Azure via Pulumi providers

**Why Pulumi + NixOS**:
- Pulumi: Real programming language (TypeScript), state management, drift detection
- NixOS: Declarative, reproducible, atomic upgrades, perfect for k3s nodes
- Hetzner: Best price/performance for compute in EU, native IPv6, no egress charges

**Not**: 
- Terraform (HCL limitations, less flexible)
- Container-based nodes (we want k3s on proper VMs)
- Managed Kubernetes (EKS/GKE/AKS) - we want k3s for control and cost

---

## Goals

1. **One-command cluster**: `fabrik cluster init --provider hetzner` creates working k3s
2. **NixOS everywhere**: All nodes run NixOS for reproducibility
3. **Hetzner native**: Optimized for Hetzner Cloud (CX servers, volumes, networks)
4. **SSH bootstrap**: Support existing bare metal or VMs via SSH + NixOS install
5. **GitOps ready**: Pulumi state can be stored in S3, GitLab, or Pulumi Cloud
6. **Multi-region**: Support multiple Hetzner locations (nbg1, fsn1, hel1)
7. **Disaster recovery**: Backup/restore etcd, PVC snapshots via Longhorn

---

## Non-Goals

- Multi-cloud abstraction (start with Hetzner, add others later)
- Kubernetes-as-a-Service (we provision VMs, install k3s)
- Windows nodes (Linux/NixOS only)
- Legacy Docker Swarm / Nomad support

---

## Requirements

### 1. Architecture Overview

```
┌─ Pulumi Project: fabrik-infrastructure ─────────────────────────────────────┐
│                                                                             │
│  ┌─ Entry: index.ts ─────────────────────────────────────────────────────┐ │
│  │  ├─ Parse config (provider, region, node count, types)                │ │
│  │  ├─ Instantiate provider (Hetzner | AWS | Manual)                      │ │
│  │  └─ Export: kubeconfig, cluster endpoints, node IPs                   │ │
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

### 2. Pulumi Configuration Schema

```typescript
// Pulumi.yaml / Pulumi.dev.yaml
interface FabrikInfrastructureConfig {
  // Provider selection
  provider: 'hetzner' | 'manual' | 'aws' | 'gcp';
  
  // Hetzner-specific
  hetzner?: {
    token: string;           // HCLOUD_TOKEN (secret)
    location: 'nbg1' | 'fsn1' | 'hel1' | 'ash';
    networkZone: 'eu-central' | 'us-east';
    
    controlPlane: {
      serverType: 'cx21' | 'cx31' | 'cx41' | 'cx51' | 'ccx12';
      count: number;         // 1 for dev, 3 for HA
      enableFloatingIp: boolean;
    };
    
    workers: {
      serverType: 'cx21' | 'cx31' | 'cx41' | 'cpx21' | 'cpx31';
      count: number;
      volumes: Array<{
        size: number;        // GB
        format: 'ext4' | 'xfs';
        mount: string;       // /var/lib/longhorn
      }>;
    };
    
    networking: {
      ipRange: string;       // 10.0.0.0/16
      subnet: string;        // 10.0.1.0/24
      enableIPv6: boolean;
    };
    
    loadBalancer: {
      type: 'lb11' | 'lb21' | 'lb31';
      location: string;
    };
    
    firewall: {
      allowedCidr: string[];   // ["0.0.0.0/0"] or restrict
    };
  };
  
  // Manual/SSH bootstrap
  manual?: {
    nodes: Array<{
      name: string;
      host: string;           // IP or hostname
      port: number;          // SSH port
      user: string;          // root or sudo user
      sshKeyPath: string;    // ~/.ssh/id_ed25519
      role: 'control-plane' | 'worker';
      architecture: 'x86_64' | 'aarch64';
      nixosDisk?: string;    // /dev/sda (for nixos-anywhere)
    }>;
  };
  
  // k3s configuration
  k3s: {
    version: string;         // v1.29.0+k3s1
    clusterCidr: string;     // 10.42.0.0/16
    serviceCidr: string;     // 10.43.0.0/16
    clusterDns: string;      // 10.43.0.10
    tlsSan: string[];        // Additional SANs for API cert
    
    // Embedded etcd (default) or external
    datastore: 'embedded' | 'external';
    externalDatastore?: {
      endpoint: string;      // postgres://... or https://etcd:2379
    };
    
    // Features
    disable: ('traefik' | 'servicelb' | 'metrics-server' | 'coredns' | 'local-storage')[];
    flannelBackend: 'vxlan' | 'host-gw' | 'wireguard' | 'none';
    
    // Extra args
    serverExtraArgs: string[];
    agentExtraArgs: string[];
  };
  
  // NixOS configuration
  nixos: {
    channel: string;         // nixos-24.11 or nixos-unstable
    flake?: string;          // Path to custom flake
    extraModules: string[];  // Additional NixOS modules
  };
  
  // Add-ons installed after k3s
  addons: {
    longhorn: {
      enabled: boolean;
      version: string;       // v1.6.0
      defaultStorageClass: boolean;
      replicaCount: number;  // 3 for HA, 1 for dev
    };
    
    metallb: {
      enabled: boolean;      // If not using Hetzner LB
      addresses: string[];     // ["10.0.1.100-10.0.1.110"]
    };
    
    certManager: {
      enabled: boolean;
      version: string;
      issuer: 'letsencrypt-staging' | 'letsencrypt-prod' | 'selfsigned';
    };
    
    laos: {
      enabled: boolean;        // Deploy LAOS stack in-cluster
      persistence: boolean;    // PVC for metrics/logs
    };
  };
  
  // Pulumi state backend
  backend: {
    type: 'pulumi-cloud' | 's3' | 'local';
    bucket?: string;         // For S3: s3://my-pulumi-state
    region?: string;         // For S3: eu-central-1
  };
}
```

### 3. NixOS Module for k3s

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
        "fabrik.dev/role" = "worker";
        "fabrik.dev/cost-center" = "team-a";
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

### 4. Pulumi Hetzner Implementation

```typescript
// pulumi/hetzner/index.ts
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import { readFileSync } from "fs";

const config = new pulumi.Config();
const name = config.get("clusterName") || "fabrik";
const location = config.get("location") || "nbg1";

// Network
const network = new hcloud.Network(`${name}-net`, {
  ipRange: "10.0.0.0/16",
  labels: { "managed-by": "fabrik" },
});

const subnet = new hcloud.NetworkSubnet(`${name}-subnet`, {
  networkId: network.id,
  type: "cloud",
  networkZone: "eu-central",
  ipRange: "10.0.1.0/24",
});

// Firewall
const firewall = new hcloud.Firewall(`${name}-fw`, {
  rules: [
    { direction: "in", protocol: "tcp", port: "22", sourceIps: ["0.0.0.0/0"], description: "SSH" },
    { direction: "in", protocol: "tcp", port: "6443", sourceIps: ["0.0.0.0/0"], description: "k3s API" },
    { direction: "in", protocol: "tcp", port: "80", sourceIps: ["0.0.0.0/0"], description: "HTTP" },
    { direction: "in", protocol: "tcp", port: "443", sourceIps: ["0.0.0.0/0"], description: "HTTPS" },
    { direction: "in", protocol: "tcp", port: "10250", sourceIps: ["10.0.0.0/16"], description: "kubelet" },
    { direction: "in", protocol: "udp", port: "8472", sourceIps: ["10.0.0.0/16"], description: "flannel" },
  ],
});

// SSH Key
const sshKey = new hcloud.SshKey(`${name}-key`, {
  publicKey: readFileSync(config.require("sshPublicKeyPath"), "utf8"),
});

// Generate NixOS configuration for control plane
function generateNixosConfig(role: "server" | "agent", token?: string, serverUrl?: string): string {
  const k3sArgs = role === "server" 
    ? `--cluster-init --tls-san=${name}-api.example.com --node-taint=node-role.kubernetes.io/control-plane:NoSchedule`
    : `--server=${serverUrl} --token=${token}`;
  
  return `
{ config, pkgs, ... }:
{
  imports = [ ./hardware-configuration.nix ];
  
  boot.loader.grub.device = "/dev/sda";
  
  networking.hostName = "${name}-${role}";
  networking.useDHCP = false;
  networking.interfaces.eth0.useDHCP = true;
  
  services.openssh.enable = true;
  
  services.fabrik-k3s = {
    enable = true;
    role = "${role}";
    ${role === "agent" ? `serverUrl = "${serverUrl}";
    token = "${token}";` : ""}
    extraArgs = [
      ${role === "server" ? `"--cluster-init", "--tls-san=${name}-api.example.com",` : ""}
      "--flannel-backend=vxlan",
      "--disable=traefik,servicelb",
    ];
  };
  
  system.stateVersion = "24.11";
}
`;
}

// Control Plane Server
const cpConfig = generateNixosConfig("server");
const controlPlane = new hcloud.Server(`${name}-cp-1`, {
  serverType: "cx31",
  image: "ubuntu-22.04",  // Will be replaced by NixOS via rescue
  location: location,
  sshKeys: [sshKey.id],
  networks: [{ networkId: network.id, ip: "10.0.1.10" }],
  firewallIds: [firewall.id],
  labels: { "role": "control-plane", "cluster": name },
  userData: `
#cloud-config
runcmd:
  # Install NixOS via kexec
  - curl -L https://github.com/nix-community/nixos-images/releases/download/nixos-24.11/nixos-kexec-installer-x86_64-linux | bash
  - mkdir -p /mnt/etc/nixos
  - echo '${cpConfig}' > /mnt/etc/nixos/configuration.nix
  - nixos-install --root /mnt --no-root-passwd
  - reboot
`,
});

// Get k3s token for workers
const k3sToken = new command.remote.Command("get-k3s-token", {
  connection: {
    host: controlPlane.ipv4Address,
    user: "root",
    privateKey: readFileSync(config.require("sshPrivateKeyPath"), "utf8"),
  },
  create: "cat /var/lib/rancher/k3s/server/token",
  triggers: [controlPlane.ipv4Address],
}, { dependsOn: [controlPlane] });

// Worker Servers
const workerCount = config.getNumber("workerCount") || 2;
const workers: hcloud.Server[] = [];

for (let i = 1; i <= workerCount; i++) {
  const workerConfig = generateNixosConfig(
    "agent", 
    k3sToken.stdout,
    pulumi.interpolate`https://10.0.1.10:6443`
  );
  
  const worker = new hcloud.Server(`${name}-worker-${i}`, {
    serverType: "cx21",
    image: "ubuntu-22.04",
    location: location,
    sshKeys: [sshKey.id],
    networks: [{ networkId: network.id, ip: `10.0.1.${20 + i}` }],
    firewallIds: [firewall.id],
    labels: { "role": "worker", "cluster": name },
    userData: `
#cloud-config
runcmd:
  - curl -L https://github.com/nix-community/nixos-images/releases/download/nixos-24.11/nixos-kexec-installer-x86_64-linux | bash
  - mkdir -p /mnt/etc/nixos
  - echo '${workerConfig}' > /mnt/etc/nixos/configuration.nix
  - nixos-install --root /mnt --no-root-passwd
  - reboot
`,
  }, { dependsOn: [controlPlane, k3sToken] });
  
  workers.push(worker);
}

// Load Balancer for k3s API
const lb = new hcloud.LoadBalancer(`${name}-lb`, {
  loadBalancerType: "lb11",
  location: location,
  networkZone: "eu-central",
});

new hcloud.LoadBalancerNetwork(`${name}-lb-net`, {
  loadBalancerId: lb.id,
  networkId: network.id,
  ip: "10.0.1.5",
});

new hcloud.LoadBalancerService(`${name}-lb-api`, {
  loadBalancerId: lb.id,
  protocol: "tcp",
  listenPort: 6443,
  destinationPort: 6443,
  healthCheck: {
    protocol: "tcp",
    port: 6443,
    interval: 10,
    timeout: 10,
    retries: 3,
  },
});

new hcloud.LoadBalancerTarget(`${name}-lb-target`, {
  loadBalancerId: lb.id,
  type: "server",
  serverId: controlPlane.id,
  usePrivateIp: true,
});

// Volumes for Longhorn
workers.forEach((worker, i) => {
  new hcloud.Volume(`${name}-storage-${i + 1}`, {
    size: 50,
    serverId: worker.id,
    format: "ext4",
    location: location,
    labels: { "purpose": "longhorn", "cluster": name },
  });
});

// Export values
export const kubeconfig = pulumi.interpolate`apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: <from server>
    server: https://${lb.ipv4}:6443
  name: ${name}
contexts:
- context:
    cluster: ${name}
    user: admin
  name: ${name}
current-context: ${name}
kind: Config
users:
- name: admin
  user:
    client-certificate-data: <from server>
    client-key-data: <from server>
`;

export const controlPlaneIp = controlPlane.ipv4Address;
export const workerIps = workers.map(w => w.ipv4Address);
export const apiEndpoint = lb.ipv4;
```

### 5. Manual/SSH Bootstrap

```typescript
// pulumi/manual/index.ts
import * as command from "@pulumi/command";
import { readFileSync } from "fs";

const config = new pulumi.Config();

interface NodeConfig {
  name: string;
  host: string;
  port: number;
  user: string;
  sshKeyPath: string;
  role: 'control-plane' | 'worker';
  architecture: 'x86_64' | 'aarch64';
  nixosDisk?: string;
}

const nodes = config.requireObject<NodeConfig[]>("nodes");

// Generate k3s token from first control plane node
const firstCp = nodes.find(n => n.role === 'control-plane');
if (!firstCp) throw new Error("At least one control plane node required");

// Install NixOS via nixos-anywhere on first control plane
const installNixos = new command.remote.Command(`install-${firstCp.name}`, {
  connection: {
    host: firstCp.host,
    port: firstCp.port,
    user: firstCp.user,
    privateKey: readFileSync(firstCp.sshKeyPath, "utf8"),
  },
  create: `
    # Download nixos-anywhere
    curl -L https://github.com/nix-community/nixos-anywhere/releases/latest/download/nixos-anywhere-x86_64-linux -o /tmp/nixos-anywhere
    chmod +x /tmp/nixos-anywhere
    
    # Generate config
    mkdir -p /tmp/nixos-config
    cat > /tmp/nixos-config/configuration.nix << 'NIXEOF'
    { config, pkgs, ... }: {
      imports = [ ./hardware-configuration.nix ];
      boot.loader.grub.device = "${firstCp.nixosDisk || "/dev/sda"}";
      networking.hostName = "${firstCp.name}";
      services.openssh.enable = true;
      services.fabrik-k3s = {
        enable = true;
        role = "server";
        extraArgs = ["--cluster-init", "--tls-san=${firstCp.host}"];
      };
      system.stateVersion = "24.11";
    }
    NIXEOF
    
    # Install NixOS
    /tmp/nixos-anywhere --flake /tmp/nixos-config#${firstCp.name} root@${firstCp.host}
  `,
});

// Get k3s token
const k3sToken = new command.remote.Command("get-k3s-token", {
  connection: {
    host: firstCp.host,
    port: firstCp.port,
    user: "root",
    privateKey: readFileSync(firstCp.sshKeyPath, "utf8"),
  },
  create: "cat /var/lib/rancher/k3s/server/token",
  triggers: [installNixos.id],
}, { dependsOn: [installNixos] });

// Install workers
const workerInstalls = nodes
  .filter(n => n.role === 'worker')
  .map((node, i) => {
    return new command.remote.Command(`install-${node.name}`, {
      connection: {
        host: node.host,
        port: node.port,
        user: node.user,
        privateKey: readFileSync(node.sshKeyPath, "utf8"),
      },
      create: pulumi.interpolate`
        curl -L https://github.com/nix-community/nixos-anywhere/releases/latest/download/nixos-anywhere-${node.architecture}-linux -o /tmp/nixos-anywhere
        chmod +x /tmp/nixos-anywhere
        
        mkdir -p /tmp/nixos-config
        cat > /tmp/nixos-config/configuration.nix << 'NIXEOF'
        { config, pkgs, ... }: {
          imports = [ ./hardware-configuration.nix ];
          boot.loader.grub.device = "${node.nixosDisk || "/dev/sda"}";
          networking.hostName = "${node.name}";
          services.openssh.enable = true;
          services.fabrik-k3s = {
            enable = true;
            role = "agent";
            serverUrl = "https://${firstCp.host}:6443";
            token = "${k3sToken.stdout}";
          };
          system.stateVersion = "24.11";
        }
        NIXEOF
        
        /tmp/nixos-anywhere --flake /tmp/nixos-config#${node.name} root@${node.host}
      `,
    }, { dependsOn: [k3sToken] });
  });

// Export kubeconfig retrieval command
export const kubeconfigCommand = pulumi.interpolate`ssh -i ${firstCp.sshKeyPath} root@${firstCp.host} "cat /etc/rancher/k3s/k3s.yaml" | sed "s/127.0.0.1/${firstCp.host}/g"`;
```

### 6. Post-Provisioning: Add-ons

```typescript
// pulumi/addons/index.ts
import * as k8s from "@pulumi/kubernetes";

const k8sProvider = new k8s.Provider("k8s", {
  kubeconfig: config.requireSecret("kubeconfig"),
});

// Longhorn
const longhornNamespace = new k8s.core.v1.Namespace("longhorn", {
  metadata: { name: "longhorn-system" },
}, { provider: k8sProvider });

const longhorn = new k8s.helm.v3.Release("longhorn", {
  chart: "longhorn",
  version: "1.6.0",
  repositoryOpts: { repo: "https://charts.longhorn.io" },
  namespace: longhornNamespace.metadata.name,
  values: {
    persistence: {
      defaultClass: true,
      defaultClassReplicaCount: 3,
    },
    csi: {
      attacherReplicaCount: 2,
      provisionerReplicaCount: 2,
      resizerReplicaCount: 2,
      snapshotterReplicaCount: 2,
    },
  },
}, { provider: k8sProvider });

// LAOS (in-cluster)
const laosNamespace = new k8s.core.v1.Namespace("monitoring", {
  metadata: { name: "monitoring" },
}, { provider: k8sProvider });

const prometheus = new k8s.helm.v3.Release("prometheus", {
  chart: "kube-prometheus-stack",
  version: "55.0.0",
  repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
  namespace: laosNamespace.metadata.name,
  values: {
    grafana: {
      enabled: true,
      adminPassword: config.requireSecret("grafanaAdminPassword"),
    },
    prometheus: {
      prometheusSpec: {
        retention: "30d",
        storageSpec: {
          volumeClaimTemplate: {
            spec: {
              storageClassName: "longhorn",
              resources: { requests: { storage: "50Gi" } },
            },
          },
        },
      },
    },
  },
}, { provider: k8sProvider });

// Fabrik namespaces
new k8s.core.v1.Namespace("fabrik-system", {
  metadata: { name: "fabrik-system" },
}, { provider: k8sProvider });

new k8s.core.v1.Namespace("fabrik-runs", {
  metadata: { name: "fabrik-runs" },
}, { provider: k8sProvider });
```

---

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

# SSH to nodes (via Pulumi output)
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

- [ ] `fabrik infra init --provider hetzner` creates Pulumi project with Hetzner config
- [ ] `fabrik infra up` provisions NixOS servers with k3s installed
- [ ] Control plane accessible via load balancer on port 6443
- [ ] Workers join cluster automatically using k3s token
- [ ] Longhorn deployed as default storage class
- [ ] `fabrik infra kubeconfig` outputs valid kubeconfig for kubectl
- [ ] Nodes labeled with `fabrik.dev/role` and other configured labels
- [ ] Manual provider works with existing servers via SSH + nixos-anywhere
- [ ] Pulumi state stored in configured backend (S3, Pulumi Cloud, local)
- [ ] `fabrik infra destroy` cleanly removes all cloud resources
- [ ] NixOS configuration can be customized via extra modules
- [ ] Firewall rules correctly restrict k3s ports
- [ ] IPv6 enabled and working on Hetzner (native dual-stack)

---

## Assumptions

1. **Hetzner account**: User has Hetzner Cloud account and API token
2. **SSH keys**: Ed25519 SSH key pair exists (~/.ssh/id_ed25519)
3. **Pulumi**: Pulumi CLI installed and configured (pulumi login)
4. **NixOS**: For manual bootstrap, servers have internet access for nixos-anywhere
5. **Node access**: Root or sudo access on manual nodes for NixOS installation
6. **Architecture**: x86_64 supported first, aarch64 can be added
7. **DNS**: For production, DNS records point to load balancer IPs
8. **TLS**: k3s generates self-signed certs (or use valid certs via TLS SANs)
9. **Cost awareness**: User understands Hetzner pricing (CX21 ≈ €5.35/month)
10. **State security**: Pulumi state contains secrets, store in S3 with encryption or Pulumi Cloud

---

## Glossary

- **Pulumi**: Infrastructure-as-code using real programming languages (TypeScript, Python, Go)
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

- **v1.0.0** (2026-02-16): Initial specification
  - Hetzner Cloud native support
  - Manual/SSH bootstrap via nixos-anywhere
  - NixOS + k3s architecture
  - Pulumi-based IaC
  - Longhorn storage
  - LAOS in-cluster deployment
