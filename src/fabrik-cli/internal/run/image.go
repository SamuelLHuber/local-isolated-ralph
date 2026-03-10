package run

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

const (
	defaultWorkflowImageName = "fabrik-smithers"
	defaultWorkflowImageEnv  = "FABRIK_SMITHERS_IMAGE"
)

type ghcrTokenResponse struct {
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
}

func resolveDefaultWorkflowImage(ctx context.Context) (string, error) {
	if override := strings.TrimSpace(os.Getenv(defaultWorkflowImageEnv)); override != "" {
		return override, nil
	}

	owner, err := repositoryOwnerFromOrigin(ctx)
	if err != nil {
		return "", err
	}

	tag, err := defaultOriginBranchTag(ctx)
	if err != nil {
		return "", err
	}

	repository := strings.ToLower(owner) + "/" + defaultWorkflowImageName
	return resolveGHCRDigest(ctx, repository, tag)
}

func repositoryOwnerFromOrigin(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "remote", "get-url", "origin")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to resolve origin remote: %w", err)
	}

	return repositoryOwnerFromRemoteURL(strings.TrimSpace(string(out)))
}

func repositoryOwnerFromRemoteURL(remote string) (string, error) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return "", fmt.Errorf("origin remote URL is empty")
	}

	switch {
	case strings.HasPrefix(remote, "git@github.com:"):
		path := strings.TrimPrefix(remote, "git@github.com:")
		return ownerFromGitHubPath(path)
	case strings.HasPrefix(remote, "https://github.com/"), strings.HasPrefix(remote, "http://github.com/"):
		parsed, err := url.Parse(remote)
		if err != nil {
			return "", fmt.Errorf("failed to parse origin remote URL %q: %w", remote, err)
		}
		return ownerFromGitHubPath(strings.TrimPrefix(parsed.Path, "/"))
	default:
		return "", fmt.Errorf("origin remote %q is not a GitHub repository URL", remote)
	}
}

func ownerFromGitHubPath(path string) (string, error) {
	path = strings.TrimSuffix(strings.TrimSpace(path), ".git")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" {
		return "", fmt.Errorf("failed to derive repository owner from %q", path)
	}
	return parts[0], nil
}

func defaultOriginBranchTag(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to resolve origin HEAD branch: %w", err)
	}

	value := strings.TrimSpace(string(out))
	value = strings.TrimPrefix(value, "origin/")
	value = strings.ReplaceAll(value, "/", "-")
	if value == "" {
		return "", fmt.Errorf("origin HEAD branch is empty")
	}
	return value, nil
}

func resolveGHCRDigest(ctx context.Context, repository, tag string) (string, error) {
	token, err := resolveGHCRToken(ctx, repository)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, "https://ghcr.io/v2/"+repository+"/manifests/"+tag, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create GHCR manifest request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", strings.Join([]string{
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	}, ", "))

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to resolve GHCR digest for %s:%s: %w", repository, tag, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to resolve GHCR digest for %s:%s: registry returned %s", repository, tag, resp.Status)
	}

	digest := strings.TrimSpace(resp.Header.Get("Docker-Content-Digest"))
	if digest == "" {
		return "", fmt.Errorf("failed to resolve GHCR digest for %s:%s: missing Docker-Content-Digest header", repository, tag)
	}

	return "ghcr.io/" + repository + "@" + digest, nil
}

func resolveGHCRToken(ctx context.Context, repository string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://ghcr.io/token?service=ghcr.io&scope=repository:"+repository+":pull", nil)
	if err != nil {
		return "", fmt.Errorf("failed to create GHCR token request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to request GHCR token for %s: %w", repository, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf(
			"failed to request GHCR token for %s: registry returned %s; publish ghcr.io/%s or pass --image/FABRIK_SMITHERS_IMAGE explicitly",
			repository,
			resp.Status,
			repository,
		)
	}

	var payload ghcrTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("failed to decode GHCR token response: %w", err)
	}

	token := strings.TrimSpace(payload.Token)
	if token == "" {
		token = strings.TrimSpace(payload.AccessToken)
	}
	if token == "" {
		return "", fmt.Errorf("GHCR token response for %s did not include a token", repository)
	}

	return token, nil
}
