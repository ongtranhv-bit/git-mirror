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
