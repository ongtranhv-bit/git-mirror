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

## Sync thủ công

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
