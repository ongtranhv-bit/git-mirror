# deploy-cli USAGE — tài liệu đầy đủ lệnh & args

Công cụ quản lý worker **git-mirror** trên **GitHub Actions** và
**Azure Pipelines**: chạy workflow/pipeline, xem trạng thái, xem log, stop,
và cập nhật secrets. Chạy trực tiếp bằng Node.js ≥ 18 (không cần `gh`/`az`
CLI; riêng `ghcli.mjs` gọi `gh` để set secrets GitHub).

```bash
cd deploy-cli && npm install   # cài prompts (menu tương tác)
```

Token và organization được lấy theo thứ tự ưu tiên:
**args → env → `deploy-cli/.env`** (menu cũng đọc file này, chỉ đọc không chạy).
File `.env` KHÔNG được commit; menu không bao giờ ghi token xuống file.

---

## 1. Menu tương tác — `menu.mjs`

```bash
npm run menu                    # hoặc: node deploy-cli/menu.mjs
npm run start                   # tương đương
```

Menu chính (điều hướng bằng phím mũi tên ↑↓, Enter để chọn, Ctrl+C thoát):

1. **🐙 GitHub Actions** — chọn repository (dùng repo cấu hình sẵn hoặc list
   từ API) → chọn thao tác:
   - **▶️ Run workflow** — chọn yml trong list → nhập branch (mặc định
     `main`) → nhập inputs dạng `k=v,k2=v2` (bỏ trống nếu không có) → dispatch.
   - **📜 List runs** — in 20 run gần nhất → chọn 1 run → menu run:
     xem log / stop / follow trạng thái (poll 10s, in mỗi khi đổi).
   - **🛑 Stop run** — liệt kê run đang chạy → chọn → cancel.
   - **📄 Xem log run** — chọn run → chọn job (nếu nhiều job) → in log job.
   - **📋 List workflows (yml)** — in bảng `id / tên / path`; chọn 1 yml →
     xác nhận → dispatch ngay.
   - **🔑 Set secrets (ghcli)** — chuyển sang mục secrets.
   - **🔄 Đổi repository / ⬅️ Về menu chính**.
2. **☁️ Azure Pipelines** — chọn project → chọn pipeline → chọn thao tác:
   - **▶️ Run pipeline** — nhập branch (mặc định `main`) → nhập variables
     `k=v,k2=v2` → start run.
   - **📜 List runs** — in các run gần nhất → chọn run → menu run
     (xem log / stop / follow, poll 10s).
   - **🛑 Stop run / 📄 Xem log run** — xem log chọn task trong timeline.
   - **🔄 Đổi pipeline / ⬅️ Về menu chính**.
3. **🔑 Cập nhật secrets (ghcli / azurecli)** — chọn nền tảng → chọn file
   `*.env` trong `deploy-cli/` → hỏi chạy `--dry-run` trước → chạy thật.

**Sau mỗi lệnh hoàn tất**, menu hỏi tiếp:
`🔄 Chạy lại lệnh vừa chạy` (chạy lại y hệt lệnh vừa thực hiện) /
`➡️ Chạy tiếp lệnh khác` (quay lại menu cấp hiện tại) / `🚪 Thoát`.

Nếu thiếu token: menu hỏi nhập — **chỉ dùng trong phiên, không lưu**.
Nếu thiếu repo/workflow/pipeline: menu tự list và cho chọn — không cần
cấu hình trước.

> Menu cần terminal tương tác (TTY). Trong script/CI dùng CLI trực tiếp ở dưới.

---

## 2. GitHub Actions — `gh-actions.mjs`

Token: `--token PAT` | env `GH_TOKEN` | env `GHCLI_TOKEN`.
Không có TTY và thiếu repo/workflow → lỗi yêu cầu truyền args.

### 2.1 `list-repos`

```bash
node deploy-cli/gh-actions.mjs list-repos [--filter TEXT] [--token PAT]
npm run gh:repos
```

Liệt kê repository mà token có quyền truy cập (100 repo cập nhật gần nhất).
`--filter` lọc theo chuỗi con không phân biệt hoa thường trong tên
(`owner/name`). In mỗi repo 1 dòng + số lượng.

### 2.2 `list-workflows`

```bash
node deploy-cli/gh-actions.mjs list-workflows --repo OWNER/REPO [--token PAT]
npm run gh:workflows -- --repo OWNER/REPO
```

Liệt kê các workflow đang **active** (bỏ qua disabled): mỗi dòng
`id \t tên \t path-file-yml`. Thiếu `--repo` trong TTY → hỏi chọn repo.

### 2.3 `run` — chạy workflow

```bash
node deploy-cli/gh-actions.mjs run --repo OWNER/REPO \
  [--workflow FILE|NAME|ID] [--ref BRANCH] [--inputs k=v,k2=v2] [--token PAT]
npm run gh:run -- --repo OWNER/REPO --workflow git-mirror-worker
```

Dispatch `workflow_dispatch` cho workflow chọn trước (mặc định hỏi chọn nếu
TTY). `--workflow` nhận 4 dạng, tự resolve về file yml:
path đầy đủ (`.github/workflows/x.yml`) | tên file (`x`) | tên workflow |
id số. `--ref` mặc định `main`. `--inputs` chuyển thành inputs của
`workflow_dispatch`. Không ghi kết quả trả về của API (204 = đã chấp nhận);
run mới có thể xem bằng `list-runs`.

### 2.4 `list-runs`

```bash
node deploy-cli/gh-actions.mjs list-runs --repo OWNER/REPO \
  [--workflow FILE|NAME|ID] [--status STATUS] [--token PAT]
npm run gh:runs -- --repo OWNER/REPO --status in_progress
```

In 20 run gần nhất (hoặc lọc `--workflow` và/hoặc `--status`): mỗi dòng
`#number \t id \t event \t branch \t sha(8) \t status \t conclusion \t created_at`.
`--status` chấp nhận: `queued | in_progress | completed |
requested | waiting | pending` (Giá trị theo GitHub Actions API).

### 2.5 `stop` — cancel run

```bash
node deploy-cli/gh-actions.mjs stop --repo OWNER/REPO RUN_ID [--token PAT]
```

Gửi `POST /actions/runs/{id}/cancel` — run bị cancel (concurrency group của
workflow sẽ để run kế tiếp chạy). Không thể undo.

### 2.6 `log` — xem log

```bash
node deploy-cli/gh-actions.mjs log --repo OWNER/REPO RUN_ID \
  [--follow] [--job JOB_ID] [--token PAT]
```

Không `--follow`: liệt kê job của run → in log của 1 job (run 1 job tự chọn;
nhiều job → hỏi chọn nếu TTY, ngược lại cần `--job`). Log chỉ sẵn sàng khi
job **đã chạy xong** (GitHub API) — run đang chạy báo lỗi kèm gợi ý dùng
`--follow`.
Với `--follow`: poll trạng thái run mỗi 10 giây, in mỗi lần trạng thái đổi
(`status [conclusion]`), dừng khi `completed`.

---

## 3. Azure Pipelines — `azure-pipelines.mjs`

Token: `--token PAT` | env `AZURE_DEVOPS_TOKEN` | env `AZURECLI_TOKEN`
(PAT cần scope Build/Pipeline **Read & Execute**, Variable Groups **Read &
Manage**).
Organization: `--org ORG` | env `AZURECLI_ORG` | env `AZURE_ORG` (không cần
tiền tố `dev.azure.com`).

### 3.1 `list-projects`

```bash
node deploy-cli/azure-pipelines.mjs list-projects [--org ORG] [--token PAT]
npm run az:projects
```

Liệt kê project trong organization: mỗi dòng `tên \t (id)`.

### 3.2 `list-repos`

```bash
node deploy-cli/azure-pipelines.mjs list-repos --project PROJECT [--org ORG] [--token PAT]
npm run az:repos -- --project PROJECT
```

Liệt kê repository của project. Thiếu `--project` trong TTY → hỏi chọn.

### 3.3 `list-pipelines`

```bash
node deploy-cli/azure-pipelines.mjs list-pipelines --project PROJECT [--org ORG] [--token PAT]
npm run az:pipelines -- --project PROJECT
```

Liệt kê pipeline của project: mỗi dòng `id \t tên \t folder`.

### 3.4 `run` — chạy pipeline

```bash
node deploy-cli/azure-pipelines.mjs run --project PROJECT --pipeline ID \
  [--branch BRANCH] [--variables k=v,k2=v2] [--org ORG] [--token PAT]
npm run az:run -- --project PROJECT --pipeline 1
```

Start một pipeline run trên `--branch` (mặc định `main`). `--variables` gửi
kèm variables cho run. In `run id + tên`. Chạy thành công ≠ run hoàn thành —
xem kết quả bằng `list-runs` / `log --follow`.

### 3.5 `list-runs`

```bash
node deploy-cli/azure-pipelines.mjs list-runs --project PROJECT --pipeline ID \
  [--state STATE] [--org ORG] [--token PAT]
```

Liệt kê run của pipeline: mỗi dòng
`id \t tên \t state \t result \t createdDate`.
`--state` lọc client-side theo state Azure:
`notStarted | inProgress | completed | cancelling | cancelled`.

### 3.6 `stop` — cancel run

```bash
node deploy-cli/azure-pipelines.mjs stop PROJECT PIPELINE_ID RUN_ID [--org ORG] [--token PAT]
```

Hủy run đang chạy (`action=cancel` trên run). Positional 3 tham số; không có
arg tương đương `--run-id`.

### 3.7 `log` — xem log

```bash
node deploy-cli/azure-pipelines.mjs log PROJECT PIPELINE_ID RUN_ID \
  [--follow] [--task NAME|LOG_ID] [--org ORG] [--token PAT]
```

Không `--follow`: đọc timeline của run → liệt kê các **task** (type `Task`,
có log) → chọn task (TTY) hoặc `--task` (tên task hoặc log id) → in log text
của task đó. Log chưa sẵn sàng → lỗi kèm thông báo.
Với `--follow`: poll state run mỗi 10 giây, in khi đổi, dừng khi
`completed`/`cancelled`.

---

## 4. Secrets

### 4.1 `ghcli.mjs` — GitHub secrets/variables

```bash
node deploy-cli/ghcli.mjs [--repo OWNER/REPO] [--dry-run] FILE.env
```

Đọc 1 file dotenv, dùng token trong file (`GHCLI_TOKEN`/`GH_TOKEN`/
`GITHUB_TOKEN`) làm `GH_TOKEN` cho `gh`, chỉ upload các biến có annotation
`# ghcli:<target>` kế tiếp. Không source/execute file.

| Annotation | Đích GitHub |
| --- | --- |
| `# ghcli:repo-and-codespaces-secret` | secret repo Actions **và** Codespaces |
| `# ghcli:repo-secret` | secret repo (Actions) |
| `# ghcli:codespaces-secret` | secret repo (Codespaces) |
| `# ghcli:repo-variable` | variable repo (không secret) |

Args: `--repo` ghi đè repo (mặc định `GHCLI_REPO` trong file, nếu không có
thì `gh` lấy repo hiện tại); `--dry-run` chỉ in tên + đích, không in giá trị.

### 4.2 `azurecli.mjs` — Azure Pipelines variable group

```bash
node deploy-cli/azurecli.mjs [--org ORG] [--project PROJECT] [--group-id ID] [--dry-run] FILE.env
```

Tương tự ghcli nhưng dùng Azure DevOps REST (fetch, không cần az CLI):
GET variable group → merge chỉ biến được annotate → PUT lại toàn bộ.
Biến khác trong group được giữ nguyên; secret không được annotate lại thì
**giữ giá trị cũ**.

| Annotation | Đích Azure |
| --- | --- |
| `# azurecli:pipeline-secret` | biến trong group với `isSecret: true` |
| `# azurecli:pipeline-variable` | biến thường trong group |

Args: `--org`, `--project`, `--group-id` ghi đè control trong file
(`AZURECLI_TOKEN`, `AZURECLI_ORG`, `AZURECLI_PROJECT`, `AZURECLI_GROUP_ID`,
`AZURECLI_GROUP_NAME`). Group chưa tồn tại → tạo mới bằng `AZURECLI_GROUP_NAME`
(dùng id dự kiến trong `--group-id`).

### 4.3 Luật chung (cả 2 script)

1. Chỉ biến được annotate mới được upload; annotation áp cho **biến kế tiếp**
   (dòng trống, comment `#`/`//` không nuốt annotation; không xếp chồng).
2. Tên biến: `[A-Za-z_][A-Za-z0-9_]*`, chấp nhận `export`.
3. Giá trị: không quote, quote đơn, quote đôi (hỗ trợ `\\n \\r \\t \\" \\\\`).
4. Giá trị rỗng bị từ chối (chống xóa secret nhầm).
5. Biến control không được annotate (sẽ lỗi).
6. Luôn chạy `--dry-run` trước khi đổi annotation.

---

## 5. package.json — scripts & bin

```bash
npm run menu              # node menu.mjs — menu tương tác
npm run start             # node menu.mjs
npm run gh:repos          # gh-actions.mjs list-repos
npm run gh:workflows      # gh-actions.mjs list-workflows
npm run gh:runs           # gh-actions.mjs list-runs
npm run gh:run            # gh-actions.mjs run
npm run az:projects       # azure-pipelines.mjs list-projects
npm run az:repos          # azure-pipelines.mjs list-repos
npm run az:pipelines      # azure-pipelines.mjs list-pipelines
npm run az:run            # azure-pipelines.mjs run
```

Sau `npm install -g` (hoặc `npm link` trong `deploy-cli/`), các `bin` sau có
thể chạy trực tiếp: `git-mirror-deploy` (menu), `gh-actions`,
`azure-pipelines`, `ghcli`, `azurecli`.

Các script `deploy:reconcile:*` (cũ) được giữ nguyên, không liên quan công
cụ này.

## 6. Bảo mật

- Token/PAT chỉ truyền qua args/env/file env; file env KHÔNG commit
  (`.env.example` là mẫu). Giá trị nhập trong menu không lưu.
- CLI không log giá trị secrets khi chạy; `--dry-run` của ghcli/azurecli chỉ
  in tên biến + đích.
- Lỗi HTTP: 401 = token sai/hết hạn; các lỗi khác in status + đoạn body
  (không bao gồm token).