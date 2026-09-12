# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose credentials, private data, or remote-code-execution paths.

Use GitHub's private vulnerability reporting feature for this repository when available. If private reporting is unavailable, contact the repository owner privately before disclosing technical details publicly.

## Secret handling

This repository is public. Do not commit credentials or machine-specific secret configuration, including:

- `.env` files
- `config/projects.local.yaml`
- API keys, access tokens, refresh tokens, passwords, private keys, or service-account credentials
- generated runtime logs or credential stores

Secrets must be supplied through environment variables, the operating-system credential store, or another external secret manager.

GitHub Secret Scanning and Push Protection are enabled for this repository. CI also performs a full-history Gitleaks scan on pushes and pull requests.

If a secret is ever committed, treat it as compromised even if the commit is later reverted. Revoke or rotate the credential first, then remove it from Git history if necessary.
