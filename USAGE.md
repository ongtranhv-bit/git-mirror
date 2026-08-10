# Usage

## Validate config

```bash
SOURCE_GITHUB_PAT=x SOURCE_GITEA_PAT=x SOURCE_AZURE_PAT=x \
DEST_GITHUB_PAT=x DEST_GITEA_PAT=x DEST_AZURE_PAT=x \
node dist/cli.js validate --config ./config.example.json
```

Raw JSON:

```bash
node dist/cli.js validate --config-json '{"configVersion":6,"src":{"creds":...},"dest":{...}}'
```

`CONFIG_JSON` có thể là raw JSON hoặc base64 JSON. Thứ tự ưu tiên là CLI/raw env, file, rồi RTDB config base64.

## Destination enabled/disabled

Mỗi destination có field `enabled` để bật/tắt mà không cần xóa cấu hình:

```json
{
  "dest": {
    "github-main": {
      "enabled": true,
      "type": "github",
      ...
    },
    "gitea-backup": {
      "enabled": false,
      "type": "gitea",
      ...
    }
  }
}
```

- Mặc định: `true` (nếu không khai báo)
- Khi `false`: destination bị skip, log `DESTINATION_DISABLED`
- Thay đổi không cần restart - worker tự đọc config mới khi có event

## repo:check

Read-only: xác thực destination credential và check repository, không tạo/sửa.

```bash
node dist/cli.js repo:check --config ./config.example.json --event-file ./event.example.json
```

Destination repo cố định không cần event. Destination dùng `{sourceRepo}`/`{sourceOwner}` cần event để resolve tên repo.

## repo:init

```bash
node dist/cli.js repo:init --config ./config.example.json --event-file ./event.example.json --dry-run
node dist/cli.js repo:init --config ./config.example.json --event-file ./event.example.json
```

Lệnh chạy idempotent: check trước, chỉ create khi 404. Conflict/already-exists được check lại. URL/ID/trạng thái được ghi vào `/sync/state/repositories` khi có RTDB client.

## Chạy listener

```bash
node dist/cli.js run
node dist/cli.js run --once
```

Hook relay ghi event vào:

```json
{
  "provider": "github",
  "repo": "source-org/app",
  "url": "https://github.com/source-org/app.git",
  "ref": "refs/heads/main",
  "after": "0123456789abcdef0123456789abcdef01234567",
  "receivedAt": 1786000000000
}
```

Node key dưới `/sync/events/pending/{eventId}` là event ID chính thức. Worker tự ghi `eventId` vào runtime event.

## GitHub webhook bridge

Khi webhook GitHub trỏ trực tiếp vào RTDB (VD `/github-noti.json`), payload thô nằm thành từng child dưới node đó. Bridge đọc các delivery đó, lọc event `push`, chuyển sang `HookEvent` và ghi vào `/sync/events/pending`.

### Cấu hình webhook path

Đặt path nhận raw data từ GitHub trong `config.json`:

```json
{
  "rtdb": {
    "webhookPath": "/github-noti"
  }
}
```

Ưu tiên: env `WEBHOOK_PATH` > config `rtdb.webhookPath` > mặc định `/github-noti`.

### Chạy bridge riêng

```bash
node dist/cli.js webhook:bridge
node dist/cli.js webhook:bridge --once
```

### Chạy bridge + worker trong1 process

```bash
node dist/cli.js run --bridge
```

Lệnh này vừa lắng nghe webhook vừa sync - không cần 2 process.

### Tính năng bridge

- Mỗi delivery được claim bằng RTDB transaction (thêm `_bridge`), tránh xử lý trùng khi nhiều instance.
- Event ping/branch-delete bị skip và đánh dấu `skipped` trong `_bridge`.
- Sau khi xử lý (queued/skipped/filtered), delivery bị xóa khỏi webhook path để node không phình ra. Delivery đã claim trước đó cũng bị dọn khi bridge khởi động (`bridgeOnce`).
- Khi khởi động, bridge chạy `bridgeOnce` để bắt kịp các delivery còn tồn đọng trước khi lắng nghe realtime.

## Retention dữ liệu cũ

Event đã xử lý/không xử lý quá `rtdb.retentionDays` ngày bị xóa tự động. Worker dọn lúc khởi động và mỗi 6 giờ:

```json
{ "rtdb": { "retentionDays": 7 } }
```

Hoặc override bằng env (ưu tiên hơn config):

```bash
RTDB_RETENTION_DAYS=7
```

Worker khởi động cũng chạy `processAllPending` để bắt kịp event còn tồn đọng trước khi lắng nghe realtime.

## Keep-alive Codespace (tự động trong listener)

Khi service chạy bên trong GitHub Codespaces, listener tự động giữ codespace sống: cứ mỗi khoảng thời gian lại mở một kết nối `gh codespace ssh -c <CODESPACE_NAME> -- true` ngắn — kết nối đang hoạt động sẽ reset idle timer nên codespace không bị auto-stop.

Bật/tắt và tần suất qua config hoặc env:

```json
{ "runtime": { "codespaceKeepalive": { "enabled": true, "intervalMinutes": 10 } } }
```

```bash
CODESPACE_KEEPALIVE_ENABLED=true
CODESPACE_KEEPALIVE_INTERVAL_MINUTES=10
```

Guard (tránh lỗi): chỉ chạy khi **cả 3** điều kiện đúng — `CODESPACES=true`, `CODESPACE_NAME` có giá trị, và có `gh` CLI. Nếu thiếu một trong ba, listener log `codespace.keepalive_skipped` với lý do rồi bỏ qua (không lỗi). Nếu tắt hẳn: log `codespace.keepalive_disabled`.

Chạy ngoài codespace (máy luôn bật) thì dùng `scripts/codespace-keepalive/external.sh [name]` — giữ kết nối SSH persistent và tự khởi động lại codespace nếu bị stop; có thể lên lịch cron mỗi 5 phút.

Lưu ý chi phí: giữ codespace sống sẽ tính phí giờ sử dụng cho tới khi hết quota.

## Lọc/bỏ qua notification

Cấu hình loại trừ push theo commit message, phù hợp khi webhook org gửi mọi repo. Event khớp rule sẽ bị skip ngay tại bridge (không vào `pending`); nếu đã vào `pending`, worker đánh dấu destination là `skipped` với code `COMMIT_FILTERED`.

```json
{
  "src": {
    "creds": { "github": { "type": "github", "token": "${SOURCE_GITHUB_PAT}" } },
    "filter": {
      "commit": {
        "exclude": [
          { "mode": "prefix", "value": "Debug" },
          { "mode": "suffix", "value": "[no-sync]" },
          { "mode": "contains", "value": "skip-me" }
        ]
      }
    }
  }
}
```

Hoặc qua env (gộp với rule trong config):

```bash
SRC_FILTER_COMMIT_EXCLUDE=prefix:Debug,suffix:[no-sync],contains:skip-me
```

- `mode`: `prefix` (bắt đầu bằng), `suffix` (kết thúc bằng), `contains` (chứa). Khớp không phân biệt hoa/thường.
- Bridge kiểm tra message của mọi commit trong push (head_commit lẫn commits[]); chỉ cần 1 commit khớp là skip cả push.
- Event bị skip được claim delivery để không xử lý lại.

## Manual reconcile toàn bộ source -> destinations

Dùng khi muốn kiểm tra lại toàn bộ source repository và bù những destination bị thiếu/lệch mà **không cần có webhook event sẵn**. Lệnh dùng cùng cơ chế nạp config và cùng RTDB credentials với listener (`RTDB_URL` + `RTDB_AUTH_SECRET` hoặc `GOOGLE_SERVICE_ACCOUNT_B64`). Nếu không truyền `--config`, config vẫn được lấy từ RTDB theo cơ chế hiện tại.

```bash
# Khuyến nghị: giới hạn owner/org để PAT không quét các repo không liên quan
node dist/cli.js reconcile --owner source-org

# Chỉ kiểm tra một số repo / destination
node dist/cli.js reconcile --owner source-org --repo app,shared-lib --dest github-main,azure-main

# Chỉ xem drift, không enqueue
node dist/cli.js reconcile --owner source-org --dry-run

# Giãn nhịp để giảm burst API/Git khi có nhiều repo
node dist/cli.js reconcile --owner source-org --delay-ms 750 --api-delay-ms 300
```

Luồng xử lý:

1. Enumerate repository từ source credential GitHub (`/user/repos`, phân trang 100). Có thể chọn credential bằng `--source <id>`.
2. Áp dụng `src.filter.repo.exclude`; nếu có commit filter thì đọc message của commit HEAD/default branch và áp dụng `src.filter.commit.exclude`. Worker cũng kiểm tra filter lần nữa, nên event được ghi trực tiếp vào `pending` vẫn không bypass filter.
3. Đọc refs source bằng `git ls-remote`.
4. Với mỗi destination đang enabled:
   - `one-to-one`: so sánh các branch/tag theo `push.include`, `push.exclude`, `push.pushTags`; nếu `deleteMissingRefs=true` thì extra refs ở destination cũng được coi là drift.
   - `many-to-one`: kiểm tra bằng **commit marker qua API**. Mỗi lần sync, destination nhận một commit có git trailer chứa `{{sourceSha}}` (mặc định `Source-Commit`). Nếu commit mới nhất của source xuất hiện trong message các commit gần đây của destination branch (filter theo thư mục `directory`), destination được coi là **in-sync**; ngược lại là **drift**. Không clone repo nào. Nếu config của destination **không** có trailer chứa `{{sourceSha}}`, fallback về so sánh Git tree như cũ (cần clone workspace).
   - repository destination chưa tồn tại được đánh dấu drift; scanner **không tạo repo trực tiếp**.
5. Chỉ các destination drift được ghi vào `HookEvent.targetDestinations`; event cũng mang `sourceCredentialId` để worker dùng đúng source PAT khi có nhiều credential cùng provider. Scanner enqueue normalized event vào `rtdb.pendingPath`; worker hiện hữu xử lý `pending -> processing -> processed|failed`, destination lock, auto-create, retry, push và state giống listener.

Manual reconcile ghi vào `pendingPath` thay vì giả một raw GitHub webhook vào `webhookPath`. `webhookPath` là input đặc thù GitHub cho bridge; `pendingPath` mới là queue chuẩn hóa chung mà worker production tiêu thụ.

### Các option

| Option | Ý nghĩa |
| --- | --- |
| `--source <credential>` | Chỉ dùng một key trong `src.creds`. Hiện discovery manual hỗ trợ source `github`. |
| `--owner a,b` | Chỉ scan owner/org tương ứng. Nên dùng khi PAT nhìn thấy nhiều repo ngoài phạm vi mirror. |
| `--repo a,b` | Lọc theo tên repo hoặc `owner/repo`. |
| `--dest a,b` | Chỉ kiểm tra các destination ID đã chọn. |
| `--delay-ms <n>` | Nghỉ giữa hai source repo; mặc định 500 ms. |
| `--api-delay-ms <n>` | Nghỉ giữa page/fallback API call; mặc định 250 ms. |
| `--dry-run` | Kiểm tra drift nhưng không ghi event vào RTDB. |

Ngoài pacing trên, mỗi Git/API operation vẫn bị giới hạn bởi `runtime.gitTimeoutMs` và `runtime.apiTimeoutMs`. Các API call liệt kê commit (GitHub/Gitea/Azure) tự retry tối đa 3 lần khi bị rate limit (429), tôn trọng `Retry-After`, và nghỉ `--api-delay-ms` giữa các page. Một RTDB lock `manual-reconcile` có TTL/heartbeat ngăn hai scanner chạy đồng thời và cùng dùng cache reconcile.

GitHub Enterprise có thể thêm URL trên source credential:

```json
{
  "src": {
    "creds": {
      "github-enterprise": {
        "type": "github",
        "token": "${SOURCE_GITHUB_PAT}",
        "baseUrl": "https://github.example.com",
        "apiBaseUrl": "https://github.example.com/api/v3"
      }
    }
  }
}
```

Giới hạn hiện tại của reconcile: repository nguồn rỗng không có commit SHA sẽ được báo `empty` và chưa thể tạo destination bằng `HookEvent`; discovery source Gitea/Azure chưa được thêm. Xem `MANUAL_RECONCILE_REVIEW.md` để biết các ưu tiên tiếp theo.

## Sync thủ công từ một event có sẵn

Dry-run vẫn clone/fetch/check để phát hiện lỗi, nhưng không create repo thật và không push:

```bash
node dist/cli.js sync --config ./config.example.json --event-file ./event.example.json --dry-run
node dist/cli.js sync --config ./config.example.json --event-file ./event.example.json
```

Khi có RTDB credentials, sync thủ công cũng dùng destination lock và ghi state.

## Replay failed event

```bash
node dist/cli.js replay --event evt_20260806_001
```

Lệnh chuyển payload từ `failed` về `pending`, xóa failed/processing marker. Idempotency trong Git trailer và state ngăn commit trùng.

## Encode/decode/push config

```bash
node dist/cli.js config:encode config.example.json > config.b64
node dist/cli.js config:decode config.b64
node dist/cli.js config:push config.example.json
```

## Đọc trạng thái

```text
/sync/events/processed/{eventId}  kết quả từng destination
/sync/events/failed/{eventId}     error đã redact + partial result
/sync/state/sync/{key}            lastSourceSha/destinationSha
/sync/state/repositories/{key}    provider ID/clone URL/check time
/sync/instances/{instanceId}      heartbeat/current event
```

## Many-to-one directory mapping

Ưu tiên mapping theo full source name, sau đó repo name, cuối cùng template `directory`:

```json
{
  "directory": "services/{sourceRepo}",
  "directoryMap": {
    "source-org/app": "apps/app",
    "shared-lib": "packages/shared-lib"
  }
}
```

Path absolute, `..`, `.git`, path trùng hoặc lồng nhau bị reject trước khi chạy.

## Commit template variables

Trong cấu hình `commit` của many-to-one destination, có thể dùng template variables:

```json
{
  "commit": {
    "authorName": "{{sourceAuthor}}",
    "authorEmail": "{{sourceAuthorEmail}}",
    "committerName": "mirror-bot",
    "committerEmail": "mirror-bot@example.com",
    "messagePrefix": "[sync]",
    "template": "{{prefix}} {{sourceRepo}}: {{sourceSubject}}",
    "trailers": {
      "Source-Repo": "{{sourceOwner}}/{{sourceRepo}}",
      "Source-Ref": "{{sourceRef}}",
      "Source-Commit": "{{sourceSha}}",
      "Source-Author": "{{sourceAuthor}} <{{sourceAuthorEmail}}>"
    }
  }
}
```

Available variables:

| Variable | Mô tả |
|----------|-------|
| `{{sourceOwner}}` | Owner/source org |
| `{{sourceRepo}}` | Tên repo nguồn |
| `{{sourceRef}}` | Ref đầy đủ (VD: `refs/heads/main`) |
| `{{sourceBranch}}` | Branch name (VD: `main`) |
| `{{sourceSha}}` | Commit SHA đầy đủ |
| `{{sourceShortSha}}` | SHA viết tắt (12 ký tự) |
| `{{sourceSubject}}` | Commit message gốc (subject) |
| `{{sourceBody}}` | Commit message body |
| `{{sourceAuthor}}` | Tên author source commit |
| `{{sourceAuthorEmail}}` | Email author source commit |
| `{{sourceAuthorDate}}` | Ngày author commit (ISO) |
| `{{sourceCommitter}}` | Tên committer source commit |
| `{{sourceCommitterEmail}}` | Email committer source commit |
| `{{sourceCommitterDate}}` | Ngày committer commit (ISO) |
| `{{sourceDirectory}}` | Thư mục trong monorepo |
| `{{instanceId}}` | ID instance đang chạy |
| `{{timestamp}}` | ISO timestamp |
| `{{prefix}}` | messagePrefix |

Ví dụ lấy toàn bộ info từ source:

```json
{
  "commit": {
    "authorName": "{{sourceAuthor}}",
    "authorEmail": "{{sourceAuthorEmail}}",
    "committerName": "{{sourceCommitter}}",
    "committerEmail": "{{sourceCommitterEmail}}",
    "trailers": {
      "Source-Author": "{{sourceAuthor}} <{{sourceAuthorEmail}}>",
      "Source-Date": "{{sourceAuthorDate}}"
    }
  }
}
```

## Codespace Rotation

Plan/preflight không thay active pointer:

```bash
node dist/cli.js codespace:plan --rotation-config ./codespace-rotation.example.json --date 2026-08-07
node dist/cli.js codespace:preflight --rotation-config ./codespace-rotation.example.json --date 2026-08-07
```

Nạp config control-plane:

```bash
node dist/cli.js codespace:config:encode ./codespace-rotation.example.json
node dist/cli.js codespace:config:push ./codespace-rotation.example.json
```

Fake mode dùng cho orchestration test và bị chặn gọi API thật khi `testing.useRealCodespace=false`:

```bash
node dist/cli.js codespace:rotate --fake --rotation-config ./codespace-rotation.example.json --date 2026-08-07
```

Canary thật nên giữ old Codespace:

```bash
node dist/cli.js codespace:rotate --no-stop-old --date 2026-08-07
node dist/cli.js codespace:status --date 2026-08-07
```

Recovery thủ công:

```bash
node dist/cli.js codespace:rollback --rotation 2026-08-07
node dist/cli.js codespace:cleanup --rotation 2026-08-07
```

Các node chính: `/sync/codespace/lock`, `/sync/codespace/active`, `/sync/codespace/rotations/{YYYY-MM-DD}`, `/sync/codespace/instances/{instanceId}`. Xem `docs/CODESPACE_ROTATION.md`.
