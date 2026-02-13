# Container-specific configuration (Docker, k8s pods)
{ config, lib, pkgs, ... }:

{
  # Enable Ralph - but container-appropriate settings
  services.ralph = {
    enable = true;
    browser.enable = true;
    browser.remoteDebugging = false;  # Use sidecar or internal only
    telemetry.enable = true;
    telemetry.hostAddr = "telemetry.ralph-system.svc.cluster.local";  # k8s service
    autonomousMode = true;
  };

  # Container-specific overrides
  # No bootloader needed
  boot.isContainer = true;

  # No getty/autologin in containers
  services.getty.autologinUser = lib.mkForce null;

  # Networking handled by container runtime
  networking = {
    hostName = lib.mkDefault "ralph";
    useDHCP = false;
    # k8s/docker will inject DNS
  };

  # No firewall in container (use NetworkPolicies in k8s)
  networking.firewall.enable = false;

  # Lighter weight - no SSH in containers (use kubectl exec)
  services.openssh.enable = lib.mkForce false;

  # Entry point for container
  systemd.services.ralph-agent = {
    description = "Ralph Coding Agent";
    wantedBy = [ "multi-user.target" ];
    after = [ "ralph-install-agents.service" ];
    requires = [ "ralph-install-agents.service" ];

    environment = {
      HOME = "/home/ralph";
      TASK_DIR = "/workspace";
      PROMPT_FILE = "/workspace/PROMPT.md";
      BUN_INSTALL = "/home/ralph/.bun";
      PATH = "/home/ralph/.bun/bin:/run/current-system/sw/bin";
    };

    serviceConfig = {
      Type = "simple";
      User = "ralph";
      WorkingDirectory = "/workspace";
      # The actual agent command - uses correct flag per agent
      # RALPH_AGENT can be: pi, claude, or codex
      # Flags:
      #   pi:     --print (non-interactive)
      #   claude: --dangerously-skip-permissions
      #   codex:  --dangerously-bypass-approvals-and-sandbox (or --yolo)
      ExecStart = "${pkgs.bash}/bin/bash -c '\
        AGENT=\"\${RALPH_AGENT:-pi}\"; \
        case \"$AGENT\" in \
          pi) exec pi --print \"$(cat $PROMPT_FILE)\" ;; \
          claude) exec claude --dangerously-skip-permissions -p \"$(cat $PROMPT_FILE)\" ;; \
          codex) exec codex --dangerously-bypass-approvals-and-sandbox -p \"$(cat $PROMPT_FILE)\" ;; \
          *) echo \"Unknown agent: $AGENT\"; exit 1 ;; \
        esac'";
      Restart = "on-failure";
      RestartSec = "10s";
    };
  };

  system.stateVersion = "24.11";
}
