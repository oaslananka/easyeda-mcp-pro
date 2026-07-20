# Local Security Tooling

This repository uses layered security checks so contributors receive fast local feedback without
running every cloud scanner on every commit.

## Check placement

| Stage        | Checks                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| Editor       | SonarQube for IDE in Connected Mode                                          |
| Pre-commit   | file hygiene, private-key detection, and repository-owned Semgrep rules      |
| Pre-push     | Snyk Open Source dependency scan at high severity or above                   |
| Pull request | CI, CodeQL, Dependency Review, Semgrep, Snyk GitHub App, and SonarQube Cloud |

## Install the hooks

Install `pre-commit` 4.6.0 or newer, then install both hook types:

```bash
python3 -m pip install --user 'pre-commit>=4.6.0,<5'
pre-commit install --hook-type pre-commit --hook-type pre-push
```

Validate every commit-stage hook against the repository:

```bash
pre-commit run --all-files
```

The Semgrep hook is pinned to `1.170.0`, uses `.semgrep.yml`, and does not require a Semgrep token.
It scans only files supplied by pre-commit. Generated output and intentional rule fixtures are
excluded through `.semgrepignore`.

## Semgrep commands

```bash
# Validate positive and negative rule fixtures
pnpm security:semgrep:test

# Scan all tracked production source with local rules
pnpm security:semgrep
```

The rules reject dynamic code execution, shell-backed child processes, and disabled TLS
certificate verification. Add a focused `ruleid` and `ok` fixture whenever a rule changes.

## Snyk authentication and scans

The pre-push hook executes the pinned Snyk CLI through pnpm. Authenticate once on each development
machine:

```bash
corepack pnpm dlx snyk@1.1306.1 auth
# Equivalent when Snyk is installed globally: snyk auth
```

Run scans explicitly with:

```bash
pnpm security:snyk:oss
pnpm security:snyk:code
pnpm security:snyk
```

`security:snyk:oss` blocks on high or critical dependency findings and is the pre-push gate. A
missing login or network failure also blocks the push rather than silently skipping security.

For an exceptional local recovery, pre-commit supports an explicit one-command bypass:

```bash
SKIP=snyk-oss git push
```

Use this only when the remote Snyk GitHub App and all required pull-request checks will still run.
Do not configure a permanent skip, commit a Snyk token, or weaken the severity threshold.

## SonarQube Cloud Connected Mode

Install **SonarQube for IDE** in the editor and bind this workspace to the SonarQube Cloud project
`oaslananka_easyeda-mcp-pro` using **Connected Mode**. Connected Mode applies the same rules and
new-code settings used by the pull-request Quality Gate while code is being edited.

Do not add a local Sonar scanner to the Git hooks. SonarQube Cloud analysis depends on branch and
pull-request context and remains authoritative in GitHub.

## CI ownership

`.github/workflows/static-security-analysis.yml` installs the pinned Semgrep version in an isolated
Python environment, validates the rules, runs the fixture suite, scans the full repository, and
uploads SARIF for trusted events. Snyk and SonarQube Cloud remain owned by their existing GitHub
integrations.
