# deploy-cli — công cụ quản lý git-mirror

Quản lý **GitHub Actions** và **Azure Pipelines** worker + secrets, với menu
tương tác. Chạy trực tiếp bằng Node.js, không cần `gh`/`az` CLI
(secrets GitHub dùng `gh` như cũ khi cần).

> 📖 **Tài liệu đầy đủ lệnh + args + diễn giải: [`USAGE.md`](USAGE.md)**

## Cài đặt

```bash
cd deploy-cli && npm install
```

## Menu tương tác (khuyến nghị)

```bash
npm run menu          # hoặc: node deploy-cli/menu.mjs
```

Menu chính: **GitHub Actions / Azure Pipelines / Cập nhật secrets / Thoát**.

- **Chỉ cần token**: thiếu token → menu hỏi nhập (chỉ dùng trong phiên, không
  lưu). Có token → tự list repo → chọn repo → chọn thao tác
  (run workflow, list runs, xem log, stop, follow trạng thái, set secrets).
- **Azure**: chọn project → pipeline → run / list runs / log / stop.
- **Secrets**: chọn `ghcli` (GitHub) hoặc `azurecli` (Azure) → chọn file `*.env`
  trong `deploy-cli/` → chạy (hỏi dry-run trước).
- **Sau mỗi lệnh**: hỏi tiếp tục — `🔄 Chạy lại lệnh vừa chạy`,
  `➡️ Chạy tiếp lệnh khác`, `🚪 Thoát`.
- Repo mặc định lấy từ `GHCLI_REPO` (env hoặc `deploy-cli/.env`) nếu có.

## CLI trực tiếp (script trong package.json)

```bash
npm run gh:repos        # node gh-actions.mjs list-repos
npm run gh:workflows    # node gh-actions.mjs list-workflows
npm run gh:runs         # node gh-actions.mjs list-runs
npm run gh:run          # node gh-actions.mjs run
npm run az:projects     # node azure-pipelines.mjs list-projects
npm run az:repos        # node azure-pipelines.mjs list-repos
npm run az:pipelines    # node azure-pipelines.mjs list-pipelines
npm run az:run          # node azure-pipelines.mjs run
```

### gh-actions.mjs

```bash
node deploy-cli/gh-actions.mjs list-repos [--filter TEXT] [--token PAT]
node deploy-cli/gh-actions.mjs list-workflows --repo OWNER/REPO
node deploy-cli/gh-actions.mjs run --repo OWNER/REPO --workflow git-mirror-worker [--ref main] [--inputs k=v,...]
node deploy-cli/gh-actions.mjs list-runs --repo OWNER/REPO [--workflow FILE|ID] [--status STATUS]
node deploy-cli/gh-actions.mjs stop --repo OWNER/REPO RUN_ID
node deploy-cli/gh-actions.mjs log --repo OWNER/REPO RUN_ID [--follow] [--job JOB_ID]
```

- `--workflow` nhận path file (`.github/workflows/x.yml`), tên workflow hoặc id
  số — không cần đúng đường dẫn, tự resolve.
- Thiếu `--repo`/`--workflow` khi chạy trong terminal → hỏi chọn tương tác.
- Token: `--token`, `GH_TOKEN` hoặc `GHCLI_TOKEN`.

### azure-pipelines.mjs

```bash
node deploy-cli/azure-pipelines.mjs list-projects [--org ORG]
node deploy-cli/azure-pipelines.mjs list-repos --project PROJECT
node deploy-cli/azure-pipelines.mjs list-pipelines --project PROJECT
node deploy-cli/azure-pipelines.mjs run --project PROJECT --pipeline ID [--branch main] [--variables k=v,...]
node deploy-cli/azure-pipelines.mjs list-runs --project PROJECT --pipeline ID
node deploy-cli/azure-pipelines.mjs stop PROJECT PIPELINE_ID RUN_ID
node deploy-cli/azure-pipelines.mjs log PROJECT PIPELINE_ID RUN_ID [--follow] [--task NAME]
```

- Token: `--token`, `AZURE_DEVOPS_TOKEN` hoặc `AZURECLI_TOKEN` (PAT scope
  Pipeline/Build Read & Execute + Variable Groups).
- Org: `--org`, `AZURECLI_ORG` hoặc `AZURE_ORG`.

## Secrets

- `ghcli.mjs` — GitHub repo/codespaces secrets (dùng `gh` CLI).
- `azurecli.mjs` — Azure Pipelines variable group (REST, không cần az CLI).

Cả hai đọc 1 file dotenv, chỉ upload các biến có annotation kế tiếp; chi tiết
ở phần dưới của file này (xem `README` cũ tại mục "Update rules").

```dotenv
GHCLI_TOKEN=github_pat_xxx
GHCLI_REPO=owner/repository

# ghcli:repo-and-codespaces-secret
RTDB_AUTH_SECRET="secret value"

AZURECLI_TOKEN=azure_devops_pat_xxx
AZURECLI_ORG=organization
AZURECLI_PROJECT=project
AZURECLI_GROUP_ID=1

# azurecli:pipeline-secret
AZURE_RTDB_AUTH_SECRET="secret value"
```

| Annotation | GitHub destination | Azure destination |
| --- | --- | --- |
| `# ghcli:repo-and-codespaces-secret` | Repo Actions + Codespaces secret | — |
| `# ghcli:repo-secret` | Repo Actions secret | — |
| `# ghcli:codespaces-secret` | Repo Codespaces secret | — |
| `# ghcli:repo-variable` | Repo Actions variable | — |
| `# azurecli:pipeline-secret` | — | Variable group (isSecret) |
| `# azurecli:pipeline-variable` | — | Variable group (plain) |

Rules: chỉ biến được annotate mới được upload; annotation áp cho biến kế tiếp
(blank line và comment `#`/`//` không nuốt annotation); giá trị rỗng bị từ
chối; biến control không được annotate. `--dry-run` in tên + đích, không in
giá trị. Giữ file env ngoài Git.

## Environment mặc định

`deploy-cli/.env` được menu đọc (không chạy) để lấy: `GHCLI_TOKEN`,
`GHCLI_REPO`, `AZURECLI_TOKEN`, `AZURECLI_ORG`, `AZURECLI_PROJECT`,
`AZURECLI_GROUP_ID`. Giá trị nhập trong menu chỉ tồn tại trong phiên.