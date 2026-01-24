# Core Ralph module - defines what a Ralph agent environment needs
# This is the single source of truth, used by VMs, containers, and bare metal
#
# Installs three coding agent CLIs via Bun:
#   - claude-code  (@anthropic-ai/claude-code)
#   - codex        (@openai/codex)
#   - opencode     (opencode-ai)

{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.ralph;

  # Agent CLI packages to install globally via bun (conditional)
  agentPackages =
    (optional cfg.agents.claude "@anthropic-ai/claude-code") ++
    (optional cfg.agents.codex "@openai/codex") ++
    (optional cfg.agents.opencode "opencode-ai@latest");

  # Script to install agent CLIs via bun
  installAgentCLIs = pkgs.writeShellScriptBin "install-agent-clis" ''
    set -euo pipefail
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:${pkgs.bun}/bin:$PATH"

    echo "Installing agent CLIs via bun..."
    ${lib.concatMapStringsSep "\n" (pkg: ''
      echo "  -> ${pkg}"
      bun install -g ${pkg}
    '') agentPackages}

    echo ""
    echo "Done! Installed agents:"
    ${optionalString cfg.agents.claude ''echo "  - claude (Claude Code)"''}
    ${optionalString cfg.agents.codex ''echo "  - codex (OpenAI Codex)"''}
    ${optionalString cfg.agents.opencode ''echo "  - opencode (OpenCode AI)"''}
  '';

in {
  options.services.ralph = {
    enable = mkEnableOption "Ralph coding agent environment";

    user = mkOption {
      type = types.str;
      default = "ralph";
      description = "User account for running Ralph";
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/ralph";
      description = "Directory for Ralph state and work";
    };

    autonomousMode = mkOption {
      type = types.bool;
      default = true;
      description = "Run in autonomous mode (bypass permission prompts)";
    };

    agents = {
      claude = mkOption {
        type = types.bool;
        default = true;
        description = "Install Claude Code (@anthropic-ai/claude-code)";
      };

      codex = mkOption {
        type = types.bool;
        default = true;
        description = "Install OpenAI Codex (@openai/codex)";
      };

      opencode = mkOption {
        type = types.bool;
        default = true;
        description = "Install OpenCode AI (opencode-ai)";
      };
    };

    browser = {
      enable = mkEnableOption "Browser support for Playwright/MCP";

      remoteDebugging = mkOption {
        type = types.bool;
        default = false;
        description = "Enable Chrome remote debugging on port 9222";
      };
    };

    telemetry = {
      enable = mkEnableOption "Send logs/traces to telemetry stack";

      hostAddr = mkOption {
        type = types.str;
        default = "host.lima.internal";
        description = "Address of telemetry host";
      };
    };
  };

  config = mkIf cfg.enable {
    # Core packages every Ralph needs
    environment.systemPackages = with pkgs; [
      # Basics
      git
      curl
      wget
      jq
      tmux
      htop
      ripgrep
      fd
      unzip  # Required by bun

      # Bun - fast JS runtime and package manager
      # Used to install agent CLIs globally
      bun

      # Node.js (still useful for compatibility)
      nodejs_20

      # Build tools (for native modules)
      gcc
      gnumake

      # Agent CLI installer script
      installAgentCLIs

      # Browser automation
      (mkIf cfg.browser.enable chromium)
      (mkIf cfg.browser.enable playwright-driver.browsers)
    ];

    # Ralph user account
    users.users.${cfg.user} = {
      isNormalUser = true;
      home = "/home/${cfg.user}";
      extraGroups = [ "wheel" "docker" ];
      # No password - use SSH keys or auto-login
      hashedPassword = "";
    };

    # Allow passwordless sudo for Ralph (it's an isolated VM)
    security.sudo.wheelNeedsPassword = false;

    # State directory
    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0755 ${cfg.user} users -"
      "d /home/${cfg.user}/.claude 0755 ${cfg.user} users -"
    ];

    # Claude Code autonomous mode config
    environment.etc."ralph/claude-settings.json" = mkIf cfg.autonomousMode {
      text = builtins.toJSON {
        permissions = {
          defaultMode = "bypassPermissions";
        };
      };
      mode = "0644";
    };

    # Codex CLI autonomous mode config
    environment.etc."ralph/codex-config.toml" = mkIf cfg.autonomousMode {
      text = ''
        approval_policy = "never"
        sandbox_mode = "danger-full-access"
      '';
      mode = "0644";
    };

    # Symlink agent configs to user home
    system.activationScripts.ralphConfig = mkIf cfg.autonomousMode ''
      # Claude Code config
      mkdir -p /home/${cfg.user}/.claude
      ln -sf /etc/ralph/claude-settings.json /home/${cfg.user}/.claude/settings.json
      chown -R ${cfg.user}:users /home/${cfg.user}/.claude

      # Codex config
      mkdir -p /home/${cfg.user}/.codex
      ln -sf /etc/ralph/codex-config.toml /home/${cfg.user}/.codex/config.toml
      chown -R ${cfg.user}:users /home/${cfg.user}/.codex
    '';

    # Install agent CLIs on first boot via systemd
    systemd.services.ralph-install-agents = {
      description = "Install Ralph agent CLIs via bun";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      # Only run once
      unitConfig = {
        ConditionPathExists = "!/var/lib/ralph/.agents-installed";
      };

      serviceConfig = {
        Type = "oneshot";
        User = cfg.user;
        Group = "users";
        Environment = [
          "HOME=/home/${cfg.user}"
          "BUN_INSTALL=/home/${cfg.user}/.bun"
          "PATH=/home/${cfg.user}/.bun/bin:${pkgs.bun}/bin:${pkgs.git}/bin:/run/current-system/sw/bin"
        ];
        ExecStart = "${installAgentCLIs}/bin/install-agent-clis";
        ExecStartPost = "${pkgs.coreutils}/bin/touch /var/lib/ralph/.agents-installed";
        RemainAfterExit = true;
      };
    };

    # Environment variables
    environment.sessionVariables = {
      RALPH_STATE_DIR = cfg.stateDir;
      RALPH_USER = cfg.user;
      # Bun global install path
      BUN_INSTALL = "$HOME/.bun";
    } // (optionalAttrs cfg.telemetry.enable {
      HOST_ADDR = cfg.telemetry.hostAddr;
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://${cfg.telemetry.hostAddr}:4317";
      LOKI_URL = "http://${cfg.telemetry.hostAddr}:3100";
    });

    # Add bun global bin to PATH
    environment.shellInit = ''
      export PATH="$HOME/.bun/bin:$PATH"
    '';

    # Chrome with remote debugging (for MCP)
    systemd.user.services.chrome-debug = mkIf (cfg.browser.enable && cfg.browser.remoteDebugging) {
      description = "Chrome with remote debugging";
      wantedBy = [ "default.target" ];
      serviceConfig = {
        ExecStart = "${pkgs.chromium}/bin/chromium --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --headless=new --no-first-run --disable-gpu";
        Restart = "always";
      };
    };

    # Docker for any container needs within the VM
    virtualisation.docker.enable = true;

    # SSH server for access
    services.openssh = {
      enable = true;
      settings = {
        PasswordAuthentication = false;
        PermitRootLogin = "no";
      };
    };

    # Firewall - allow SSH and Chrome debugging
    networking.firewall = {
      enable = true;
      allowedTCPPorts = [ 22 ] ++ (optional cfg.browser.remoteDebugging 9222);
    };

    # Auto-login for unattended operation (VMs only, not containers)
    services.getty.autologinUser = mkDefault cfg.user;

    # Nix settings
    nix = {
      settings = {
        experimental-features = [ "nix-command" "flakes" ];
        auto-optimise-store = true;
      };
      gc = {
        automatic = true;
        dates = "weekly";
        options = "--delete-older-than 7d";
      };
    };
  };
}
