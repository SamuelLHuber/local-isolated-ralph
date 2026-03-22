package run

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const (
	defaultWorkflowImageName = "fabrik-smithers"
	defaultWorkflowImageEnv  = "FABRIK_SMITHERS_IMAGE"
	defaultWorkflowRepoEnv   = "FABRIK_SMITHERS_REPO"
)

var manifestAcceptHeader = strings.Join([]string{
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
}, ", ")

var resolveImmutableImage = resolveImmutableImageReference

type ghcrTokenResponse struct {
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
}

type parsedImageReference struct {
	RegistryHost      string
	CanonicalRegistry string
	Repository        string
	Reference         string
	Scheme            string
}

type bearerChallenge struct {
	Realm   string
	Service string
	Scope   string
}

func resolveDefaultWorkflowImage(ctx context.Context) (string, error) {
	if override := strings.TrimSpace(os.Getenv(defaultWorkflowImageEnv)); override != "" {
		return override, nil
	}

	repository, err := defaultWorkflowRepository(ctx)
	if err != nil {
		return "", err
	}

	tag, err := defaultOriginBranchTag(ctx)
	if err != nil {
		return "", err
	}

	return resolveGHCRDigest(ctx, repository, tag)
}

func defaultWorkflowRepository(ctx context.Context) (string, error) {
	if override := strings.TrimSpace(os.Getenv(defaultWorkflowRepoEnv)); override != "" {
		repository := strings.Trim(strings.ToLower(override), "/")
		if repository == "" {
			return "", fmt.Errorf("%s is set but empty", defaultWorkflowRepoEnv)
		}
		return repository, nil
	}

	owner, err := repositoryOwnerFromOrigin(ctx)
	if err != nil {
		return "", err
	}
	return strings.ToLower(owner) + "/" + defaultWorkflowImageName, nil
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
	if err == nil {
		return normalizeBranchTag(string(out))
	}

	fallbackCmd := exec.CommandContext(ctx, "git", "remote", "show", "origin")
	fallbackOut, fallbackErr := fallbackCmd.Output()
	if fallbackErr == nil {
		for _, line := range strings.Split(string(fallbackOut), "\n") {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "HEAD branch:") {
				continue
			}
			branch := strings.TrimSpace(strings.TrimPrefix(trimmed, "HEAD branch:"))
			if branch == "" || branch == "(unknown)" {
				break
			}
			return normalizeBranchTag(branch)
		}
	}

	return "", fmt.Errorf("failed to resolve origin default branch: origin/HEAD is not set; run 'git remote set-head origin <branch>' or pass --image/%s (symbolic-ref error: %w)", defaultWorkflowImageEnv, err)
}

func normalizeBranchTag(value string) (string, error) {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "origin/")
	value = strings.ReplaceAll(value, "/", "-")
	if value == "" {
		return "", fmt.Errorf("origin default branch is empty")
	}
	return value, nil
}

func resolveGHCRDigest(ctx context.Context, repository, tag string) (string, error) {
	resolved, err := resolveImmutableImageReference(ctx, "ghcr.io/"+repository+":"+tag)
	if err != nil {
		return "", fmt.Errorf("failed to resolve GHCR digest for %s:%s: %w", repository, tag, err)
	}
	return resolved, nil
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

func resolveImmutableImageReference(ctx context.Context, image string) (string, error) {
	if isImmutableImageReference(image) {
		return image, nil
	}

	ref, err := parseImageReference(image)
	if err != nil {
		return "", err
	}

	digest, err := resolveRegistryDigest(ctx, http.DefaultClient, ref)
	if err != nil {
		return "", err
	}

	return ref.CanonicalRegistry + "/" + ref.Repository + "@" + digest, nil
}

func parseImageReference(image string) (parsedImageReference, error) {
	trimmed := strings.TrimSpace(image)
	if trimmed == "" {
		return parsedImageReference{}, fmt.Errorf("image reference is empty")
	}
	if strings.Contains(trimmed, "@") {
		return parsedImageReference{}, fmt.Errorf("image reference %q is already immutable", image)
	}

	namePart := trimmed
	tag := "latest"
	lastSlash := strings.LastIndex(namePart, "/")
	lastColon := strings.LastIndex(namePart, ":")
	if lastColon > lastSlash {
		namePart = namePart[:lastColon]
		tag = namePartOrDefault(trimmed[lastColon+1:], "latest")
	}

	registryHost := ""
	repository := namePart
	firstSlash := strings.Index(namePart, "/")
	if firstSlash == -1 {
		registryHost = "registry-1.docker.io"
		repository = "library/" + namePart
	} else {
		firstComponent := namePart[:firstSlash]
		if strings.Contains(firstComponent, ".") || strings.Contains(firstComponent, ":") || firstComponent == "localhost" {
			registryHost = firstComponent
			repository = namePart[firstSlash+1:]
		} else {
			registryHost = "registry-1.docker.io"
			repository = namePart
		}
	}
	if registryHost == "registry-1.docker.io" && !strings.Contains(repository, "/") {
		repository = "library/" + repository
	}
	if strings.TrimSpace(repository) == "" {
		return parsedImageReference{}, fmt.Errorf("image reference %q is missing a repository", image)
	}

	canonicalRegistry := registryHost
	if registryHost == "registry-1.docker.io" {
		canonicalRegistry = "docker.io"
	}

	return parsedImageReference{
		RegistryHost:      registryHost,
		CanonicalRegistry: canonicalRegistry,
		Repository:        repository,
		Reference:         tag,
		Scheme:            registryScheme(registryHost),
	}, nil
}

func namePartOrDefault(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func registryScheme(host string) string {
	if host == "localhost" || strings.HasPrefix(host, "localhost:") || strings.HasPrefix(host, "127.0.0.1:") || host == "127.0.0.1" {
		return "http"
	}
	return "https"
}

func resolveRegistryDigest(ctx context.Context, client *http.Client, ref parsedImageReference) (string, error) {
	manifestURL := fmt.Sprintf("%s://%s/v2/%s/manifests/%s", ref.Scheme, ref.RegistryHost, ref.Repository, ref.Reference)
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, manifestURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create manifest request for %s/%s:%s: %w", ref.CanonicalRegistry, ref.Repository, ref.Reference, err)
	}
	req.Header.Set("Accept", manifestAcceptHeader)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to resolve digest for %s/%s:%s: %w", ref.CanonicalRegistry, ref.Repository, ref.Reference, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		challenge, parseErr := parseBearerChallenge(resp.Header.Get("Www-Authenticate"))
		if parseErr != nil {
			return "", fmt.Errorf("failed to resolve digest for %s/%s:%s: registry requires auth but challenge could not be parsed: %w", ref.CanonicalRegistry, ref.Repository, ref.Reference, parseErr)
		}
		token, tokenErr := requestBearerToken(ctx, client, challenge)
		if tokenErr != nil {
			return "", fmt.Errorf("failed to resolve digest for %s/%s:%s: %w", ref.CanonicalRegistry, ref.Repository, ref.Reference, tokenErr)
		}

		retryReq, err := http.NewRequestWithContext(ctx, http.MethodHead, manifestURL, nil)
		if err != nil {
			return "", fmt.Errorf("failed to create authenticated manifest request for %s/%s:%s: %w", ref.CanonicalRegistry, ref.Repository, ref.Reference, err)
		}
		retryReq.Header.Set("Accept", manifestAcceptHeader)
		retryReq.Header.Set("Authorization", "Bearer "+token)

		retryResp, err := client.Do(retryReq)
		if err != nil {
			return "", fmt.Errorf("failed to resolve digest for %s/%s:%s: %w", ref.CanonicalRegistry, ref.Repository, ref.Reference, err)
		}
		defer retryResp.Body.Close()
		resp = retryResp
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to resolve digest for %s/%s:%s: registry returned %s", ref.CanonicalRegistry, ref.Repository, ref.Reference, resp.Status)
	}

	digest := strings.TrimSpace(resp.Header.Get("Docker-Content-Digest"))
	if digest == "" {
		return "", fmt.Errorf("failed to resolve digest for %s/%s:%s: missing Docker-Content-Digest header", ref.CanonicalRegistry, ref.Repository, ref.Reference)
	}
	return digest, nil
}

func parseBearerChallenge(header string) (bearerChallenge, error) {
	header = strings.TrimSpace(header)
	if header == "" {
		return bearerChallenge{}, fmt.Errorf("missing Www-Authenticate header")
	}
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return bearerChallenge{}, fmt.Errorf("unsupported auth challenge %q", header)
	}

	attrs := map[string]string{}
	for _, part := range strings.Split(header[len("Bearer "):], ",") {
		piece := strings.TrimSpace(part)
		if piece == "" {
			continue
		}
		key, value, ok := strings.Cut(piece, "=")
		if !ok {
			return bearerChallenge{}, fmt.Errorf("invalid auth challenge attribute %q", piece)
		}
		unquoted, err := strconv.Unquote(value)
		if err != nil {
			return bearerChallenge{}, fmt.Errorf("invalid auth challenge value %q: %w", value, err)
		}
		attrs[strings.ToLower(strings.TrimSpace(key))] = unquoted
	}

	realm := strings.TrimSpace(attrs["realm"])
	if realm == "" {
		return bearerChallenge{}, fmt.Errorf("auth challenge missing realm")
	}

	return bearerChallenge{
		Realm:   realm,
		Service: strings.TrimSpace(attrs["service"]),
		Scope:   strings.TrimSpace(attrs["scope"]),
	}, nil
}

func requestBearerToken(ctx context.Context, client *http.Client, challenge bearerChallenge) (string, error) {
	tokenURL, err := url.Parse(challenge.Realm)
	if err != nil {
		return "", fmt.Errorf("failed to parse token realm %q: %w", challenge.Realm, err)
	}

	query := tokenURL.Query()
	if challenge.Service != "" {
		query.Set("service", challenge.Service)
	}
	if challenge.Scope != "" {
		query.Set("scope", challenge.Scope)
	}
	tokenURL.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL.String(), nil)
	if err != nil {
		return "", fmt.Errorf("failed to create token request: %w", err)
	}
	applyRegistryTokenAuth(req, tokenURL)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to request registry token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry token request returned %s", resp.Status)
	}

	var payload ghcrTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("failed to decode registry token response: %w", err)
	}

	token := strings.TrimSpace(payload.Token)
	if token == "" {
		token = strings.TrimSpace(payload.AccessToken)
	}
	if token == "" {
		return "", fmt.Errorf("registry token response did not include a token")
	}

	return token, nil
}

func applyRegistryTokenAuth(req *http.Request, tokenURL *url.URL) {
	if req == nil || tokenURL == nil {
		return
	}
	if !strings.EqualFold(tokenURL.Hostname(), "ghcr.io") {
		return
	}

	token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(os.Getenv("GH_TOKEN"))
	}
	if token == "" {
		return
	}

	req.SetBasicAuth("x-access-token", token)
}
