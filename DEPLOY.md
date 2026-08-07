# Deployment

## 1. Chuẩn bị

Máy chạy cần Node.js 22+, Git CLI, CA certificates và một thư mục cache có quyền ghi. Với production, ưu tiên service account thay vì database secret.

```bash
git --version
node --version
npm ci
npm run verify
```

## 2. Cấu hình môi trường

Sao chép `.env.example` thành `.env`. Không commit `.env`.

| Env | Bắt buộc | Mục đích |
| --- | --- | --- |
| `CONFIG_JSON` | Không | Raw JSON hoặc base64 JSON, ưu tiên cao nhất |
| `CONFIG_FILE` | Không | File JSON local |
| `RTDB_URL` | Có khi dùng RTDB | Base URL database |
| `RTDB_CONFIG_PATH` | Không | Mặc định `/sync/config` |
| `GOOGLE_SERVICE_ACCOUNT_B64` | Khuyến nghị | Toàn bộ service-account JSON encode base64 |
| `RTDB_AUTH_SECRET` | Fallback | Secret legacy gắn `auth` trong request, không log URL hoàn chỉnh |
| `INSTANCE_ID` | Không | Mặc định hostname-pid-random |
| PAT variables | Theo config | Source/destination token tham chiếu `${NAME}` |
| `RTDB_RETENTION_DAYS` | Không | Retention days cho event cũ (default 7, override `rtdb.retentionDays`) |
| `CODESPACE_KEEPALIVE_ENABLED` | Không | Bật keepalive Codespace (true/1/yes) |
| `CODESPACE_KEEPALIVE_INTERVAL_MINUTES` | Không | Interval keepalive (phút, default 10, min 1) |

Tạo base64 service account:

```bash
node -e "const fs=require('fs'); process.stdout.write(fs.readFileSync('service-account.json').toString('base64'))"
```

Sau khi chép giá trị vào secret manager, xóa file key khỏi máy build. Service account cần quyền đọc config/pending và ghi processing/processed/failed/state/locks/instances. Mẫu rules cơ sở có trong `firebase.database.rules.json`; production nên giới hạn bằng custom claims hoặc project IAM phù hợp.

## 3. Nạp config lên RTDB

```bash
npm run build
node dist/cli.js config:push ./config.example.json
```

Hoặc encode thủ công rồi ghi chuỗi base64 vào `/sync/config`:

```bash
node dist/cli.js config:encode ./config.example.json > config.b64
```

## 4. Chạy trực tiếp

```bash
node dist/cli.js run
node dist/cli.js run --once
```

`run --once` recover processing record hết hạn, xử lý snapshot pending theo `receivedAt`, rồi thoát.

## 5. Docker

Docker image tự chạy `npm ci` và build TypeScript trong build stage. Compiler TypeScript được vendored dưới `vendor/typescript`, nên bước build không phụ thuộc npm registry:

```bash
docker build -t git-mirror-sync-service:0.2.0 .
docker run --rm --env-file .env \
  -v git-mirror-cache:/app/.cache/repos \
  git-mirror-sync-service:0.2.0 run
```

Hoặc:

```bash
npm run build
docker compose up -d --build
docker compose logs -f git-mirror
```

Image chạy user không phải root, có volume cache, restart policy và healthcheck kiểm tra PID 1.

## 6. Nhiều instance

- Mỗi instance cần `INSTANCE_ID` duy nhất; mặc định đã đủ.
- Claim event và destination lock dùng RTDB transaction/ETag.
- Event/destination lock được refresh mỗi `lockTtlSeconds / 3`.
- Cache nằm dưới `runtime.workdir/instances/{instanceId}` để tránh shared-worktree corruption.
- Có thể chia sẻ volume cache; mỗi instance vẫn dùng cây riêng.
- SIGTERM/SIGINT dừng nhận event mới, chờ job hiện tại và nhả destination lock.

## 7. Backup và restore RTDB

Các path cần backup:

```text
/sync/config
/sync/events/failed
/sync/events/processed
/sync/state
```

`processing`, `locks` và `instances` là state tạm, không nên restore nguyên trạng. Khi restore sau sự cố:

1. Dừng mọi worker.
2. Restore config/state/failed/processed.
3. Xóa lock và processing cũ hoặc để reaper xử lý sau TTL.
4. Chạy `validate`, sau đó `run --once`.
5. Replay từng failed event cần thiết.

## 8. Rotate credential

1. Tạo PAT/service account mới.
2. Cập nhật secret manager/env.
3. Restart từng instance tuần tự.
4. Chạy `repo:check` với event mẫu cho repo dùng placeholder.
5. Thu hồi credential cũ sau khi xác nhận worker mới heartbeat và sync thành công.

Token không được đưa vào Git remote URL, Docker layer, log, artifact hoặc support bundle.


## 9. Codespace Rotation

Rotation là control plane riêng, không thay `/sync/config` của AppConfig v6. Provision bootstrap repository + branch + `.devcontainer` trước, sau đó nạp `codespace-rotation.example.json` vào `/sync/codespace/config`:

```bash
node dist/cli.js codespace:preflight --rotation-config ./codespace-rotation.example.json --date 2026-08-07
node dist/cli.js codespace:config:push ./codespace-rotation.example.json
```

GitHub Actions cần các secrets: `RTDB_URL`, một trong `GOOGLE_SERVICE_ACCOUNT_B64`/`RTDB_AUTH_SECRET`, và `CODESPACE_LIFECYCLE_TOKENS_B64`. JSON bên trong secret lifecycle map dùng **tên profile** trong config làm key; không ghi token vào RTDB.

Codespaces adapter mặc định dùng REST API `2026-03-10` (`GH_CODESPACE_API_VERSION` có thể override). Với fine-grained token, cấp quyền Codespaces/lifecycle write cần thiết trên bootstrap repository; `codespace:preflight` sẽ xác minh identity, HEAD và machine trước khi create. API delete là bất đồng bộ (`202 Accepted`), nên không dùng việc request delete thành công làm bằng chứng Codespace đã biến mất.

Codespace runtime cần RTDB credential và token source theo ngày (`GH_SOURCE_TOKEN_DAY_XX`) được provision bằng Codespaces secrets. `scripts/codespace-runtime-env.sh` thu gọn chúng thành `GH_SOURCE_TOKEN_CURRENT` trước khi chạy worker. Giữ `CODESPACE_ROTATION_TIMEZONE` giống `timezone` trong rotation config. Nếu đổi `startAt`/timezone khỏi 23:00 Asia/Ho_Chi_Minh, cập nhật cron trong workflow tương ứng.

Canary đầu tiên:

```bash
node dist/cli.js codespace:rotate --no-stop-old
node dist/cli.js codespace:status
```

Chỉ bỏ `--no-stop-old` sau khi new Codespace đã nhiều lần đạt readiness/SHA đúng. Mặc định giữ `deleteOldAfterStop=false` để rollback còn khả dụng. Workflow mẫu: `.github/workflows/codespace-rotation.yml`. Chi tiết state/recovery: `docs/CODESPACE_ROTATION.md`.

**Không coi artifact local này là proof cho live Codespaces API.** Cần canary với credential thật để xác minh scope account, machine policy và Codespaces secret injection.
