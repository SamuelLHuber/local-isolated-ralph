package run

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/huh"
)

func promptForMissing(ctx context.Context, in io.Reader, out io.Writer, opts Options) (Options, error) {
	if opts.RunMode == "test" {
		return promptForMissingTestMode(in, out, opts)
	}

	var err error
	if strings.TrimSpace(opts.RunID) == "" {
		opts.RunID, err = promptHuh(ctx, "Run ID", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.SpecPath) == "" {
		opts.SpecPath, err = promptHuh(ctx, "Spec path", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.Project) == "" {
		opts.Project, err = promptHuh(ctx, "Project ID", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.Image) == "" && strings.TrimSpace(opts.WorkflowPath) == "" {
		opts.Image, err = promptHuh(ctx, "Image", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.KubeContext) == "" {
		opts.KubeContext, err = promptHuh(ctx, "Kube context", "")
		if err != nil {
			return Options{}, err
		}
	}
	return opts, nil
}

func promptForMissingTestMode(in io.Reader, out io.Writer, opts Options) (Options, error) {
	reader := bufio.NewReader(in)
	var err error
	if strings.TrimSpace(opts.RunID) == "" {
		opts.RunID, err = promptLine(reader, out, "Run ID")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.SpecPath) == "" {
		opts.SpecPath, err = promptLine(reader, out, "Spec path")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.Project) == "" {
		opts.Project, err = promptLine(reader, out, "Project ID")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.Image) == "" && strings.TrimSpace(opts.WorkflowPath) == "" {
		opts.Image, err = promptLine(reader, out, "Image")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.KubeContext) == "" {
		opts.KubeContext, err = promptLine(reader, out, "Kube context")
		if err != nil {
			return Options{}, err
		}
	}
	return opts, nil
}

func promptLine(reader *bufio.Reader, out io.Writer, label string) (string, error) {
	if _, err := fmt.Fprintf(out, "%s: ", label); err != nil {
		return "", err
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func promptHuh(ctx context.Context, label, value string) (string, error) {
	result := value
	form := huh.NewForm(huh.NewGroup(huh.NewInput().Title(label).Value(&result)))
	if err := form.WithTheme(huh.ThemeBase()).Run(); err != nil {
		return "", err
	}
	return strings.TrimSpace(result), nil
}

func confirmDispatch(ctx context.Context, in io.Reader, out io.Writer, opts Options) (bool, error) {
	if opts.RunMode == "test" {
		reader := bufio.NewReader(in)
		prompt := "Apply resources to the cluster? [y/N]: "
		if strings.TrimSpace(opts.WorkflowPath) != "" && !opts.AcceptFilteredSync {
			prompt = "Workflow artifact sync excludes .git/.jj. Preserve repo state via JJ/Git in the workflow and use .fabrik-sync only for a few explicit local-only files. Continue? [y/N]: "
		}
		if _, err := fmt.Fprint(out, prompt); err != nil {
			return false, err
		}
		line, err := reader.ReadString('\n')
		if err != nil {
			return false, err
		}
		normalized := strings.ToLower(strings.TrimSpace(line))
		return normalized == "y" || normalized == "yes", nil
	}

	confirmed := false
	title := "Apply resources to the cluster?"
	if strings.TrimSpace(opts.WorkflowPath) != "" && !opts.AcceptFilteredSync {
		title = "Workflow sync excludes .git/.jj. Preserve repo state via JJ/Git in the workflow and use .fabrik-sync only for a few explicit local-only files. Continue?"
	}
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(title).
				Affirmative("Dispatch").
				Negative("Cancel").
				Value(&confirmed),
		),
	)
	if err := form.WithTheme(huh.ThemeBase()).Run(); err != nil {
		return false, err
	}
	return confirmed, nil
}
