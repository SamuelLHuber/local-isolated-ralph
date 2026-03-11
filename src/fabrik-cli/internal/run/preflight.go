package run

import (
	"context"
	"errors"
	runenv "fabrik-cli/internal/env"
	"fmt"
	"io"
	"os"
	"strings"
)

// RequirementKind identifies a promptable or advisory preflight concern that can
// be derived from generic CLI inputs before Kubernetes dispatch starts.
type RequirementKind string

const (
	requirementGitHubToken RequirementKind = "github_token"
)

// Requirement describes one actionable preflight item.
//
// Requirements are intentionally workflow-agnostic. The CLI should only model
// concerns it can infer from generic dispatch inputs, such as GitHub clone auth
// for a GitHub-backed --jj-repo. Workflow-specific secrets stay in workflow code.
type Requirement struct {
	Kind    RequirementKind
	Message string
	EnvFile string
}

// PreflightResult contains the resolved options plus any advisory notes and
// actionable requirements discovered before validation and dispatch.
type PreflightResult struct {
	Options      Options
	Notes        []string
	Requirements []Requirement
}

// runPreflight resolves local inputs and interactive requirements before
// immutable-image resolution and final option validation.
//
// The sequencing is intentional:
// 1. prompt for generic missing inputs,
// 2. resolve local workflow/env paths and bundles,
// 3. derive advisory notes and promptable requirements,
// 4. satisfy interactive requirements, such as writing GitHub auth into --env-file.
func runPreflight(ctx context.Context, in io.Reader, out io.Writer, opts Options) (PreflightResult, error) {
	var err error
	if opts.Interactive {
		opts, err = promptForMissing(ctx, in, out, opts)
		if err != nil {
			return PreflightResult{}, err
		}
	}

	opts, err = resolveWorkflowInputs(ctx, opts)
	if err != nil {
		return PreflightResult{}, err
	}
	opts, err = resolveEnvInputs(opts)
	if err != nil {
		return PreflightResult{}, err
	}

	result, err := collectPreflightRequirements(opts)
	if err != nil {
		return PreflightResult{}, err
	}
	result.Options = opts
	if err := emitPreflightNotes(out, result.Notes); err != nil {
		return PreflightResult{}, err
	}

	opts, err = satisfyPreflightRequirements(ctx, in, out, result.Options, result.Requirements)
	if err != nil {
		return PreflightResult{}, err
	}
	result.Options = opts
	return result, nil
}

func resolveWorkflowInputs(ctx context.Context, opts Options) (Options, error) {
	var err error
	if strings.TrimSpace(opts.WorkflowPath) == "" {
		return opts, nil
	}

	opts.WorkflowPath, err = resolveLocalPath(opts.WorkflowPath)
	if err != nil {
		return Options{}, err
	}
	opts.WorkflowBundle, err = resolveWorkflowBundle(opts.WorkflowPath)
	if err != nil {
		return Options{}, err
	}
	opts.SyncBundle, err = resolveSyncBundle(opts)
	if err != nil {
		return Options{}, err
	}
	if strings.TrimSpace(opts.Image) == "" {
		opts.Image, err = resolveDefaultWorkflowImage(ctx)
		if err != nil {
			return Options{}, err
		}
	}
	return opts, nil
}

func resolveEnvInputs(opts Options) (Options, error) {
	if strings.TrimSpace(opts.EnvFile) == "" {
		return opts, nil
	}

	path, err := resolveLocalPath(opts.EnvFile)
	if err != nil {
		return Options{}, err
	}
	opts.EnvFile = path
	return opts, nil
}

// collectPreflightRequirements derives notes and requirements from generic
// dispatch inputs without interpreting workflow-specific runtime needs.
func collectPreflightRequirements(opts Options) (PreflightResult, error) {
	result := PreflightResult{Options: opts}

	if !isGitHubRepoWorkflow(opts) {
		return result, nil
	}

	const note = "this workflow clones a GitHub repo via --jj-repo. Public repos work without extra auth, but private GitHub repos need GITHUB_TOKEN or GH_TOKEN in --env-file so the Job pod can clone non-interactively."
	if strings.TrimSpace(opts.EnvFile) == "" {
		result.Notes = append(result.Notes, note)
		return result, nil
	}

	data, err := runenv.LoadDotenvFile(opts.EnvFile)
	if err != nil {
		return PreflightResult{}, err
	}
	if strings.TrimSpace(data["GITHUB_TOKEN"]) != "" || strings.TrimSpace(data["GH_TOKEN"]) != "" {
		return result, nil
	}

	result.Requirements = append(result.Requirements, Requirement{
		Kind:    requirementGitHubToken,
		EnvFile: opts.EnvFile,
		Message: fmt.Sprintf("GitHub auth is not present in %s. Public repos work without it, but private GitHub repos need GITHUB_TOKEN or GH_TOKEN in that env file for in-cluster clone auth.", opts.EnvFile),
	})
	return result, nil
}

func emitPreflightNotes(out io.Writer, notes []string) error {
	for _, note := range notes {
		if _, err := fmt.Fprintln(out, "note: "+note); err != nil {
			return err
		}
	}
	return nil
}

// satisfyPreflightRequirements applies the ordered set of requirements to the
// current options. Each requirement may emit notes, prompt the user, or update
// local inputs such as the selected env file.
func satisfyPreflightRequirements(ctx context.Context, in io.Reader, out io.Writer, opts Options, requirements []Requirement) (Options, error) {
	for _, requirement := range requirements {
		var err error
		opts, err = satisfyPreflightRequirement(ctx, in, out, opts, requirement)
		if err != nil {
			return Options{}, err
		}
	}
	return opts, nil
}

func satisfyPreflightRequirement(ctx context.Context, in io.Reader, out io.Writer, opts Options, requirement Requirement) (Options, error) {
	switch requirement.Kind {
	case requirementGitHubToken:
		return satisfyGitHubTokenRequirement(ctx, in, out, opts, requirement)
	default:
		return Options{}, fmt.Errorf("unsupported preflight requirement %q", requirement.Kind)
	}
}

// satisfyGitHubTokenRequirement handles the one GitHub-specific preflight rule
// the CLI can infer generically: a GitHub-backed repo clone may need GitHub auth
// in the synced env file for private repos. Public repos remain valid without it.
func satisfyGitHubTokenRequirement(ctx context.Context, in io.Reader, out io.Writer, opts Options, requirement Requirement) (Options, error) {
	if !opts.Interactive {
		if _, err := fmt.Fprintln(out, "note: "+requirement.Message); err != nil {
			return Options{}, err
		}
		return opts, nil
	}

	addToken, err := confirmAction(ctx, in, out, opts, requirement.Message+" Add GITHUB_TOKEN to this env file now?", "Write token")
	if err != nil {
		return Options{}, err
	}
	if !addToken {
		return opts, nil
	}

	defaultToken := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	if defaultToken == "" {
		defaultToken = strings.TrimSpace(os.Getenv("GH_TOKEN"))
	}
	token, err := promptSecretValue(ctx, in, out, opts, "GitHub token", defaultToken)
	if err != nil {
		return Options{}, err
	}
	if strings.TrimSpace(token) == "" {
		return Options{}, errors.New("github token input was empty")
	}
	if err := runenv.UpsertDotenvValue(requirement.EnvFile, "GITHUB_TOKEN", token); err != nil {
		return Options{}, fmt.Errorf("update env file %s with GITHUB_TOKEN: %w", requirement.EnvFile, err)
	}
	if _, err := fmt.Fprintf(out, "updated %s with GITHUB_TOKEN for GitHub workflow auth\n", requirement.EnvFile); err != nil {
		return Options{}, err
	}
	return opts, nil
}

// isGitHubRepoWorkflow reports whether generic dispatch inputs imply GitHub repo
// clone behavior. This is the boundary where the CLI can help without hardcoding
// workflow-specific provider or model secrets.
func isGitHubRepoWorkflow(opts Options) bool {
	if strings.TrimSpace(opts.WorkflowPath) == "" || strings.TrimSpace(opts.JJRepo) == "" {
		return false
	}
	return isGitHubRepoURL(opts.JJRepo)
}

func isGitHubRepoURL(raw string) bool {
	value := strings.ToLower(strings.TrimSpace(raw))
	return strings.Contains(value, "github.com/")
}
