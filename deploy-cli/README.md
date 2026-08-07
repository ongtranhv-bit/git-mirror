# ghcli deployment helper

`ghcli.mjs` reads one dotenv file, passes its GitHub token as `GH_TOKEN` to the
GitHub CLI, and publishes only explicitly annotated values. It never sources or
executes the dotenv file.

The script runs directly with Node.js, so `gh`/`gh.exe` is resolved from the
native operating-system `PATH` without a Bash or WSL compatibility layer.

## Usage

```bash
node deploy-cli/ghcli.mjs deploy-cli/.env
node deploy-cli/ghcli.mjs --repo OWNER/REPO deploy-cli/.env
node deploy-cli/ghcli.mjs --dry-run deploy-cli/.env
```

Set `GHCLI_REPO=OWNER/REPO` in the file or pass `--repo`. If neither is set,
`gh` resolves the repository from the current Git checkout.

## Update rules

The parser reads sequentially from top to bottom. An annotation applies to the
next dotenv assignment. Blank lines and normal comment lines beginning with
`#` or `//` are ignored between them.

| Annotation | GitHub destination |
| --- | --- |
| `# ghcli:repo-and-codespaces-secret` | Both repository Actions and Codespaces secrets |
| `# ghcli:repo-secret` | Repository Actions secret |
| `# ghcli:codespaces-secret` | Repository Codespaces secret |
| `# ghcli:repo-variable` | Repository Actions variable |

```dotenv
GHCLI_TOKEN=github_pat_xxx
GHCLI_REPO=owner/repository

# ghcli:repo-and-codespaces-secret
# Firebase runtime credential
// giá trị này dùng cho môi trường production
RTDB_AUTH_SECRET="secret value"

# ghcli:codespaces-secret
GH_SOURCE_TOKEN_DAY_07=github_pat_yyy

# ghcli:repo-variable
CODESPACE_ROTATION_TIMEZONE=Asia/Ho_Chi_Minh
```

Rules:

1. Only annotated assignments are updated; every other dotenv value is ignored.
   Use `repo-and-codespaces-secret` when the same secret must exist in both places.
2. An annotation applies to the next assignment only and cannot be stacked.
   Blank lines plus `# ...` and `// ...` comments do not consume it.
3. Names must match `[A-Za-z_][A-Za-z0-9_]*`; optional `export` is accepted.
4. Values may be unquoted, single-quoted, or double-quoted. Double quotes support
   `\\n`, `\\r`, `\\t`, `\\"`, and `\\\\` escapes.
5. Empty annotated values are rejected to prevent accidental secret deletion.
6. `GHCLI_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GHCLI_REPO`, and
   `GHCLI_REPOSITORY` are control values and cannot be uploaded.
7. Token precedence is `GHCLI_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`.
8. Use `--dry-run` first when changing annotations. It prints names and targets,
   never values.

The token needs permission to manage Actions secrets/variables and Codespaces
secrets for the selected repository. Keep the dotenv file out of Git.
