# Security policy

## Reporting

Do not open a public issue containing a credential, private endpoint, local debug bundle, or other sensitive data. Report a suspected vulnerability privately through GitHub's security-advisory feature for this repository.

## Prototype boundaries

Mistr retrieves weather data from fixed, public HTTPS hosts. It does not require AWS credentials, accept arbitrary acquisition hosts, or store application secrets in the repository.

The repository intentionally excludes:

- `.env` files and credentials;
- code-signing certificates;
- downloaded NEXRAD archives;
- diagnostic and benchmark artifacts that can reveal local paths or machine details.

Before publishing an artifact, inspect it manually even if an automated check passes.
