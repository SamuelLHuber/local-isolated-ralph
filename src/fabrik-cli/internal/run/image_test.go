package run

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

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

func TestParseImageReferenceDockerHubLibraryImage(t *testing.T) {
	ref, err := parseImageReference("alpine:3.20")
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if ref.RegistryHost != "registry-1.docker.io" {
		t.Fatalf("expected docker hub registry host, got %q", ref.RegistryHost)
	}
	if ref.CanonicalRegistry != "docker.io" {
		t.Fatalf("expected docker.io canonical registry, got %q", ref.CanonicalRegistry)
	}
	if ref.Repository != "library/alpine" {
		t.Fatalf("expected library/alpine repository, got %q", ref.Repository)
	}
	if ref.Reference != "3.20" {
		t.Fatalf("expected tag 3.20, got %q", ref.Reference)
	}
}

func TestDefaultWorkflowRepositoryUsesOverride(t *testing.T) {
	if err := os.Setenv(defaultWorkflowRepoEnv, "Samuellhuber/custom-smithers"); err != nil {
		t.Fatal(err)
	}
	defer os.Unsetenv(defaultWorkflowRepoEnv)

	repository, err := defaultWorkflowRepository(context.Background())
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if repository != "samuellhuber/custom-smithers" {
		t.Fatalf("expected normalized repository override, got %q", repository)
	}
}

func TestNormalizeBranchTag(t *testing.T) {
	tag, err := normalizeBranchTag("origin/feature/test")
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if tag != "feature-test" {
		t.Fatalf("expected feature-test, got %q", tag)
	}
}

func TestApplyRegistryTokenAuthUsesGitHubTokenForGHCR(t *testing.T) {
	if err := os.Setenv("GITHUB_TOKEN", "ghp_test_token"); err != nil {
		t.Fatal(err)
	}
	defer os.Unsetenv("GITHUB_TOKEN")

	req, err := http.NewRequest(http.MethodGet, "https://ghcr.io/token", nil)
	if err != nil {
		t.Fatal(err)
	}
	tokenURL, err := url.Parse("https://ghcr.io/token?service=ghcr.io")
	if err != nil {
		t.Fatal(err)
	}

	applyRegistryTokenAuth(req, tokenURL)
	user, pass, ok := req.BasicAuth()
	if !ok {
		t.Fatal("expected basic auth to be set")
	}
	if user != "x-access-token" || pass != "ghp_test_token" {
		t.Fatalf("unexpected basic auth credentials %q/%q", user, pass)
	}
}

func TestResolveRegistryDigestWithBearerChallenge(t *testing.T) {
	const expectedDigest = "sha256:deadbeef"
	tokenIssued := false

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			tokenIssued = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"token":"test-token"}`))
		case r.URL.Path == "/v2/team/app/manifests/v1":
			if r.Header.Get("Authorization") == "" {
				w.Header().Set("Www-Authenticate", `Bearer realm="`+server.URL+`/token",service="registry.test",scope="repository:team/app:pull"`)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
				t.Fatalf("expected bearer token, got %q", got)
			}
			if accept := r.Header.Get("Accept"); !strings.Contains(accept, "application/vnd.oci.image.manifest.v1+json") {
				t.Fatalf("expected OCI manifest accept header, got %q", accept)
			}
			w.Header().Set("Docker-Content-Digest", expectedDigest)
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()

	host := strings.TrimPrefix(server.URL, "http://")
	ref := parsedImageReference{
		RegistryHost:      host,
		CanonicalRegistry: host,
		Repository:        "team/app",
		Reference:         "v1",
		Scheme:            "http",
	}

	digest, err := resolveRegistryDigest(context.Background(), server.Client(), ref)
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if digest != expectedDigest {
		t.Fatalf("expected digest %q, got %q", expectedDigest, digest)
	}
	if !tokenIssued {
		t.Fatalf("expected token endpoint to be called")
	}
}
