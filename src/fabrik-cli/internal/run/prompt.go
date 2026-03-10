package run

import (
	"context"
	"strings"

	"github.com/charmbracelet/huh"
)

func promptForMissing(ctx context.Context, opts Options) (Options, error) {
	var err error

	if strings.TrimSpace(opts.RunID) == "" {
		opts.RunID, err = prompt(ctx, "Run ID", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.SpecPath) == "" {
		opts.SpecPath, err = prompt(ctx, "Spec path", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.Project) == "" {
		opts.Project, err = prompt(ctx, "Project ID", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.Image) == "" {
		opts.Image, err = prompt(ctx, "Image", "")
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.KubeContext) == "" {
		opts.KubeContext, err = prompt(ctx, "Kube context", "")
		if err != nil {
			return Options{}, err
		}
	}

	return opts, nil
}

func prompt(ctx context.Context, label, value string) (string, error) {
	result := value

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title(label).
				Value(&result),
		),
	)

	if err := form.WithTheme(huh.ThemeBase()).Run(); err != nil {
		return "", err
	}

	return strings.TrimSpace(result), nil
}

func confirmDispatch() (bool, error) {
	confirmed := false

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Apply resources to the cluster?").
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
