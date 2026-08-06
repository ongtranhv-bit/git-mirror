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
docker build -t git-mirror-sync-service:0.1.0 .
docker run --rm --env-file .env \
  -v git-mirror-cache:/app/.cache/repos \
  git-mirror-sync-service:0.1.0 run
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
