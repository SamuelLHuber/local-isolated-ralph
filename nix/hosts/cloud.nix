# Cloud VM configuration (AWS, GCP, Azure, etc.)
# Note: filesystem and bootloader are configured by nixos-generators formats
{ config, lib, pkgs, modulesPath, ... }:

{
  # Enable Ralph with cloud-appropriate settings
  services.ralph = {
    enable = true;
    browser.enable = true;
    browser.remoteDebugging = false;  # Security: don't expose in cloud
    telemetry.enable = true;
    # Override this per-deployment
    telemetry.hostAddr = lib.mkDefault "telemetry.internal";
    autonomousMode = true;
  };

  # Cloud-init for dynamic configuration
  services.cloud-init = {
    enable = true;
    network.enable = true;
  };

  # Cloud networking
  networking = {
    hostName = lib.mkDefault "ralph";
    useDHCP = true;
  };

  # SSH access (cloud-init will inject keys)
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  # Cloud-specific packages
  environment.systemPackages = with pkgs; [
    awscli2
    google-cloud-sdk
    azure-cli
    vim
  ];

  # Larger instance - can run multiple agents
  # Use systemd templates for scaling:
  #   systemctl start ralph@task-1
  #   systemctl start ralph@task-2
  systemd.services."ralph@" = {
    description = "Ralph Agent %i";
    after = [ "ralph-install-agents.service" ];

    environment = {
      HOME = "/home/ralph";
      BUN_INSTALL = "/home/ralph/.bun";
      PATH = "/home/ralph/.bun/bin:/run/current-system/sw/bin";
    };

    serviceConfig = {
      Type = "simple";
      User = "ralph";
      WorkingDirectory = "/var/lib/ralph/tasks/%i";
      # RALPH_AGENT can be: pi, claude, or codex
      # Flags:
      #   pi:     --print (non-interactive)
      #   claude: --dangerously-skip-permissions
      #   codex:  --dangerously-bypass-approvals-and-sandbox (or --yolo)
      ExecStart = "${pkgs.bash}/bin/bash -c '\
        AGENT=\"\${RALPH_AGENT:-pi}\"; \
        case \"$AGENT\" in \
          pi) exec pi --print \"$(cat PROMPT.md)\" ;; \
          claude) exec claude --dangerously-skip-permissions -p \"$(cat PROMPT.md)\" ;; \
          codex) exec codex --dangerously-bypass-approvals-and-sandbox -p \"$(cat PROMPT.md)\" ;; \
          *) echo \"Unknown agent: $AGENT\"; exit 1 ;; \
        esac'";
      Restart = "on-failure";
    };
  };

  system.stateVersion = "24.11";
}
