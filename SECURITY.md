# Security Policy

## Supported versions

This project is pre-1.0. Security fixes are applied to the default branch.

## Reporting a vulnerability

Please do not open a public issue for suspected credential leaks or security vulnerabilities.

If this repository is hosted on GitHub, use GitHub private vulnerability reporting when available, or contact the repository owner privately.

## Credential handling

Never commit:

- `config.json`
- Lark/Feishu app secrets
- OpenClaw Gateway tokens
- `.env` files
- database files under `data/`

If a secret is committed:

1. Remove it from the current tree.
2. Rewrite git history to purge it.
3. Force-push the cleaned history.
4. Rotate the leaked credential.
5. Re-clone any local working copies from the cleaned repository.
