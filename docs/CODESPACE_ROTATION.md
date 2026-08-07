# Codespace Rotation Control Plane

## Mục tiêu

Module này xoay GitHub Codespace chạy Git Mirror mà không để Codespace hiện tại tự chịu trách nhiệm tạo người kế nhiệm. Orchestrator chạy bên ngoài Codespace (khuyến nghị GitHub Actions), dùng GitHub Codespaces API và RTDB làm control plane.

Sync engine/schema v6 không bị thay đổi. Rotation config có schema riêng (`configVersion: 1`) và mặc định nằm tại `/sync/codespace/config` dưới dạng base64 JSON.

## Kiến trúc

```text
GitHub Actions / operator
        |
        v
codespace:rotate
        |
        +---- GitHub Codespaces REST API
        |
        +---- /sync/codespace/lock          (global lease)
        +---- /sync/codespace/rotations/*   (durable state machine)
        +---- /sync/codespace/active        (promoted pointer)
        +---- /sync/codespace/instances/*   (runtime readiness)
                      ^
                      |
             Git Mirror worker
```

## Điều kiện promote

`Available` từ GitHub API chưa đủ. Codespace mới chỉ được promote khi đồng thời có:

- Codespace API state là `Available`.
- Worker đã kết nối RTDB.
- Catch-up pending đã hoàn tất.
- Realtime listener đã attach.
- `runtimeCommitSha` đúng SHA bootstrap branch được preflight.
- Heartbeat còn fresh.

Chỉ worker có `CODESPACES=true` + `CODESPACE_NAME` mới publish rotation readiness, nên upgrade không tạo thêm quyền RTDB bắt buộc cho worker Docker/local cũ. Worker Codespace ghi `starting` trước, sau đó chỉ ghi `ready` sau `listenPendingEvents()` đã được attach. Lỗi publish readiness không giết sync worker; orchestrator đơn giản không thấy `ready` và không promote. Nếu đổi `CODESPACE_ROTATION_BASE_PATH`, readiness mặc định tự đi theo `<base>/instances`; `CODESPACE_READINESS_PATH` chỉ cần khi muốn override riêng.

## Credential model

Lifecycle credential và runtime Git credential là hai lớp khác nhau.

### Lifecycle credential

Rotation config chỉ lưu tên env/profile, không lưu token:

```json
"codespaceAccount": {
  "expectedLogin": "mirror-user-07",
  "tokenEnv": "GH_CODESPACE_TOKEN_DAY_07"
}
```

Scheduler có thể cung cấp trực tiếp từng env, hoặc một secret duy nhất:

```text
CODESPACE_LIFECYCLE_TOKENS_B64=base64({
  "GH_CODESPACE_TOKEN_DAY_07":"...",
  "GH_CODESPACE_TOKEN_DAY_08":"..."
})
```

Trước side effect, orchestrator gọi `/user` và bắt buộc login khớp `expectedLogin`. State chỉ giữ `credentialProfile` để rollback có thể resolve lại credential của owner cũ.

Codespaces adapter mặc định gửi `X-GitHub-Api-Version: 2026-03-10` (override bằng `GH_CODESPACE_API_VERSION`). Fine-grained lifecycle token phải có quyền Codespaces phù hợp trên bootstrap repository; create/delete cần `Codespaces: write`, còn start/stop dùng quyền lifecycle admin tương ứng. Luôn kiểm tra lại scope thực tế bằng `codespace:preflight` và canary với credential thật.

### Runtime source credential

Trong Codespace có thể provision các secret `GH_SOURCE_TOKEN_DAY_01` ... `GH_SOURCE_TOKEN_DAY_31`. `scripts/codespace-runtime-env.sh` chọn token theo ngày trong `CODESPACE_ROTATION_TIMEZONE`, export duy nhất:

```text
GH_SOURCE_TOKEN_CURRENT
```

sau đó unset toàn bộ biến `GH_SOURCE_TOKEN_DAY_XX` trước khi chạy Node. AppConfig v6 nên tham chiếu `${GH_SOURCE_TOKEN_CURRENT}`.

## RTDB layout

```text
/sync/codespace
├── config
├── lock
├── active
├── rotations
│   └── YYYY-MM-DD
└── instances
    └── instanceId
```

`lock` là global cho toàn rotation namespace, không phải lock theo ngày. `rotations/YYYY-MM-DD` mới là idempotency record theo ngày.

## State machine

```text
planned -> claimed -> preflight_ok -> create_requested
        -> codespace_available -> runtime_ready -> promoted
        -> old_stop_requested -> completed
```

Các trạng thái recovery:

```text
failed
cleanup_pending
rollback_pending
rolled_back
```

Rotation record chứa `configHash`; unfinished rotation từ chối tiếp tục nếu config snapshot đã đổi.

Codespace mới dùng `display_name` xác định theo rotation key (`git-mirror-YYYY-MM-DD`). Nếu process chết sau create nhưng trước khi persist `next`, lần chạy sau list Codespace theo display name này để recover thay vì tạo bản thứ hai. Nếu có hơn một match, orchestrator fail closed.

## Rollback

Nếu lỗi xảy ra sau promote:

1. Resolve lifecycle credential của previous endpoint.
2. Xác minh token login đúng previous owner.
3. Start Codespace cũ.
4. Chờ `Available`.
5. Chờ readiness + đúng previous commit SHA.
6. Transaction active pointer về Codespace cũ.
7. Best-effort stop Codespace mới.
8. Ghi `rolled_back`; nếu rollback chưa hoàn tất, ghi `rollback_pending`.

`deleteOldAfterStop` mặc định `false` để giữ đường rollback.

GitHub trả `202 Accepted` cho delete. Vì thao tác này bất đồng bộ, rotation chỉ ghi `cleanup.deleteRequested=true` sau khi request được chấp nhận; không đánh dấu `deleted=true` nếu chưa có bằng chứng resource đã biến mất.

## Cleanup

Nếu new create thành công nhưng chưa promote rồi fail, orchestrator best-effort stop new. Nếu không cleanup được, state là `cleanup_pending`.

Manual cleanup là **stop-only**; nó không delete Codespace dựa trên config hiện tại vì config có thể đã khác snapshot của rotation cũ. Operator có thể chạy:

```bash
node dist/cli.js codespace:cleanup --rotation 2026-08-07
node dist/cli.js codespace:rollback --rotation 2026-08-07
```

## CLI

```bash
node dist/cli.js codespace:config:encode codespace-rotation.example.json
node dist/cli.js codespace:config:push codespace-rotation.example.json
node dist/cli.js codespace:plan --rotation-config codespace-rotation.example.json --date 2026-08-07
node dist/cli.js codespace:preflight --rotation-config codespace-rotation.example.json --date 2026-08-07
node dist/cli.js codespace:rotate --fake --rotation-config codespace-rotation.example.json --date 2026-08-07
node dist/cli.js codespace:rotate --no-stop-old --date 2026-08-07
node dist/cli.js codespace:status --date 2026-08-07
```

Testing config có `useRealCodespace=false` bị chặn cả ở CLI và core library nếu không truyền fake lifecycle adapter. Nếu rotation kết thúc ở `cleanup_pending`/`rollback_pending`, CLI trả exit code khác 0 để scheduler phát cảnh báo dù state recovery đã được persist.

## Scheduler

`.github/workflows/codespace-rotation.yml` chạy 16:00 UTC, tương ứng 23:00 `Asia/Ho_Chi_Minh`. Nếu đổi `timezone`/`startAt`, phải đổi cron workflow tương ứng; `startAt` là contract cấu hình/audit, scheduler bên ngoài mới là nơi kích hoạt. Workflow dùng fixed concurrency group:

```text
git-mirror-codespace-rotation-production
```

RTDB global lock vẫn là nguồn quyết định cuối nếu có orchestrator khác ngoài GitHub Actions.

Manual dispatch mặc định `no_stop_old=true` để chạy canary an toàn.

## Preflight thực hiện được

`codespace:preflight` hiện kiểm tra:

- token identity;
- bootstrap repository/branch HEAD;
- machine type có nằm trong danh sách machine Codespaces khả dụng.

Secret injection của Codespaces không được chứng minh hoàn toàn chỉ bằng pre-create REST check vì secret có thể thuộc user/repository/organization policy khác nhau. Điều kiện này được kiểm chứng end-to-end bằng runtime readiness: Codespace không có secret RTDB/runtime cần thiết sẽ không thể publish `ready`, vì vậy không được promote.

## Bootstrap repository

Production rotation **không tự tạo bootstrap repository** và không tự push working tree. Repo/branch/devcontainer phải được provision trước; thiếu repo/branch thì preflight fail và Codespace cũ tiếp tục chạy. Đây là chủ ý để tách provisioning khỏi failover/rotation.

`bootstrap.retentionPeriodDays` là business-level config và được đổi sang `retention_period_minutes`; validator giới hạn 1..30 ngày để không gửi quá mức tối đa 43200 phút của GitHub.

## Canary production đề nghị

1. `codespace:preflight`.
2. `codespace:rotate --no-stop-old`.
3. Quan sát `/sync/codespace/active`, `instances`, và `rotations`.
4. Lặp lại ít nhất vài rotation thật với old vẫn giữ.
5. Sau đó mới bật `stopOldAfterHealthy=true` cho scheduler.
6. Giữ `deleteOldAfterStop=false` cho tới khi rollback đã được chứng minh bằng live canary.

## Những gì chưa được live-verify trong artifact này

- GitHub Codespaces API với credential thật.
- Organization/repository Codespaces secret policy thật.
- Scheduler GitHub Actions thật.
- Multi-account start/stop/rollback thật qua các account khác nhau.

Các path này đã có unit/in-memory tests; không được coi là live proof cho tới khi chạy canary với credential thực.
