# Codespace Rotation — Implementation & 5-Round Review

Ngày review: 2026-08-07.

## Baseline

Source ban đầu đã có Git Mirror schema v6, RTDB transaction/locks/heartbeat, provider adapters, listener và Codespace keepalive. Rotation được triển khai như control plane bổ sung; sync engine không bị viết lại.

## Vòng 1 — Implementer + Architecture Reviewer

### Implement

- Tách rotation config khỏi AppConfig v6 (`/sync/codespace/config`).
- Thêm schema/validation/hash cho rotation config.
- Thêm global rotation lock và durable rotation state.
- Thêm GitHub Codespaces lifecycle interface + fake adapter.
- Thêm runtime readiness record và promote theo readiness/SHA.

### Reviewer phát hiện

Nếu lỗi xảy ra sau active pointer đã promote nhưng trong stabilization, implementation ban đầu có thể để pointer ở Codespace mới dù runtime đã mất readiness.

### Sửa

Thêm rollback thật: start old -> Available -> readiness/SHA -> promote old -> stop new. Trạng thái `rollback_pending`/`rolled_back` được lưu bền.

## Vòng 2 — Correctness / State-Machine Reviewer

### Review

Kiểm tra idempotency, previous/next ownership, retry sau crash, và terminal states.

### Phát hiện & sửa

- Tách lifecycle credential theo owner; record giữ `credentialProfile`, không giữ secret.
- Xác minh `/user` phải khớp `expectedLogin` trước side effect.
- `rolled_back` trở thành terminal/idempotent, không được retry để promote lại.
- Config hash bảo vệ unfinished rotation khỏi đổi snapshot giữa chừng.

## Vòng 3 — Security / Runtime Reviewer

### Phát hiện

Nếu 31 token ngày đều tồn tại trong environment của Codespace, Node child process có thể nhìn thấy toàn bộ mặc dù chỉ cần token ngày hiện tại.

### Sửa

- `scripts/codespace-runtime-env.sh` resolve token theo timezone.
- Export alias `GH_SOURCE_TOKEN_CURRENT`.
- Unset toàn bộ `GH_SOURCE_TOKEN_DAY_01..31` trước khi spawn Node.
- AppConfig v6 dùng `${GH_SOURCE_TOKEN_CURRENT}`.
- Không suy repository từ raw Git remote trong startup, tránh đưa credential URL vào RTDB/readiness.
- Secret lifecycle có thể đóng gói trong `CODESPACE_LIFECYCLE_TOKENS_B64`; logger chỉ thấy profile name.

## Vòng 4 — Reliability / Operations Reviewer

### Phát hiện

- Crash ngay sau GitHub create nhưng trước khi persist state có thể tạo duplicate Codespace.
- Lock heartbeat mất lease nhưng orchestration có thể vẫn tiếp tục side effect.
- Thiếu manual recovery commands.
- Scheduler theo ngày có thể cho hai ngày khác nhau chạy song song.

### Sửa

- Deterministic `display_name` theo rotation key; retry list/recover existing Codespace trước create.
- Nếu nhiều match, fail closed.
- Lock lease có heartbeat và `assertOwned()` tại side effects/polls; mất lock thì abort.
- Thêm `codespace:rollback` và `codespace:cleanup`.
- GitHub Actions dùng fixed concurrency group, cộng RTDB global lock.
- Cleanup pre-promote cũng không side-effect nếu lock đã mất.

## Vòng 5 — Release / QA Reviewer

### Phát hiện & sửa

- Testing config `useRealCodespace=false` trước đây chỉ được guard ở CLI; thêm guard ngay core `rotateCodespace()`.
- Fake readiness trước đây dùng path mặc định; sửa để tôn trọng `CODESPACE_ROTATION_BASE_PATH`.
- Loại các config knob không có behavior (`runtimeProfile`, test `maxRuns`/`keepOldUntilHealthy`) thay vì để dead configuration tạo cảm giác đã hỗ trợ short-loop/profile switching.
- `--date` được resolve theo timezone sao cho calendar key giữ nguyên cả UTC+14/UTC-12; ngày lịch không hợp lệ bị reject.
- Codespace list được phân trang thay vì chỉ nhìn 100 record đầu.
- `runWorker()` được đóng gói cleanup trong `finally`; readiness chỉ publish trong GitHub Codespace thật và lỗi publish không làm worker sync cũ chết (rotation sẽ fail-safe vì không thấy `ready`).
- Periodic heartbeat/readiness write catch rejection để không sinh unhandled promise rejection.
- Runtime token test không còn phụ thuộc ngày hệ thống.
- Đối chiếu contract GitHub REST `2026-03-10`: create chấp nhận `201/202`, start/stop yêu cầu `200`, delete là `202 Accepted`; adapter được siết theo contract hiện hành.
- Delete là bất đồng bộ nên state chỉ ghi `cleanup.deleteRequested=true`, không tuyên bố `deleted=true` ngay sau HTTP 202.
- `retentionPeriodDays` bị chặn ở 1..30 ngày trước khi gọi API; mặc định Codespaces adapter dùng `X-GitHub-Api-Version: 2026-03-10`.
- Global `--help`/`-h` được tách parse guard khỏi config loading; CLI help không còn đòi AppConfig/RTDB credential.
- Cập nhật docs/version/changelog/handover.

## Kết quả nghiệm thu local

```text
npm run typecheck       PASS
npm run lint            PASS
npm test                PASS — 68/68
npm test -- --coverage  PASS — lines 85.15%, branches 71.79%, funcs 86.12%
npm run build           PASS
npm run security:scan   PASS
```

Coverage rotation tests quan trọng gần đầy đủ ở test layer; toàn project vẫn có các provider/live branches cũ chưa được chạy do không có endpoint/credential thật.

## Phân loại readiness

### Đã implement + local verified

- Config separation.
- Global lock/lease.
- Multi-account credential profile model.
- GitHub Codespaces REST adapter qua native fetch.
- Deterministic crash recovery.
- Runtime readiness/SHA gate.
- Promotion transaction.
- Post-promote rollback.
- Cleanup/manual operations.
- Scheduler workflow/concurrency.
- Daily runtime token narrowing.

### Chưa thể coi là production live-verified

- Real Codespaces create/start/stop/delete.
- Real account identity/scopes across 31 accounts.
- Codespaces user/org/repository secret injection policies.
- GitHub Actions scheduled run.
- Multi-account rollback with real old/new owners.

Production nên bắt đầu bằng `codespace:preflight` và manual `codespace:rotate --no-stop-old` trước khi cho scheduler stop old.
