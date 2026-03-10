package run

import "testing"

func TestRepositoryOwnerFromRemoteURLHTTPS(t *testing.T) {
	owner, err := repositoryOwnerFromRemoteURL("https://github.com/SamuelLHuber/local-isolated-ralph.git")
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if owner != "SamuelLHuber" {
		t.Fatalf("expected owner SamuelLHuber, got %q", owner)
	}
}

func TestRepositoryOwnerFromRemoteURLSSH(t *testing.T) {
	owner, err := repositoryOwnerFromRemoteURL("git@github.com:SamuelLHuber/local-isolated-ralph.git")
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if owner != "SamuelLHuber" {
		t.Fatalf("expected owner SamuelLHuber, got %q", owner)
	}
}

func TestRepositoryOwnerFromRemoteURLRejectsNonGitHubRemote(t *testing.T) {
	_, err := repositoryOwnerFromRemoteURL("https://gitlab.com/SamuelLHuber/local-isolated-ralph.git")
	if err == nil {
		t.Fatalf("expected error for non-GitHub remote")
	}
}
