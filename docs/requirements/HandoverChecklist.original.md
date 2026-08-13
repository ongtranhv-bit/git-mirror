# HandoverChecklist

# Handover Checklist - Git Sync Service
> Checklist bàn giao dự án, bám requirement và yêu cầu mỗi mục phải có bằng chứng bằng file, test hoặc hàm cụ thể. Chưa code; đây là tiêu chuẩn nghiệm thu và cấu trúc tài liệu cần bàn giao.
## 1\. Quy tắc bằng chứng
Mỗi yêu cầu chỉ được đánh dấu `DONE` khi có đủ:
*   File triển khai cụ thể.
*   Hàm/class/module đáp ứng.
*   Test hoặc log/output chứng minh.
*   Link tới tài liệu liên quan nếu là nghiệp vụ vận hành.

Mẫu ghi nhận:

```text
[ ] Requirement: ...
    File: src/...
    Function: ...
    Test: test/...
    Evidence: command + expected output
    Status: TODO | IN_PROGRESS | DONE | BLOCKED
```

## 2\. Cấu trúc bàn giao bắt buộc

```text
README.md
DEPLOY.md
USAGE.md
ERROR.md
CHANGELOG.md
.env.example
config.example.json
Dockerfile
docker-compose.yml
package.json
package-lock.json
src/
test/
scripts/
```

## 3\. Checklist requirement và bằng chứng
### 3.1 TypeScript và package
- [ ]     TypeScript strict, ESM, Node.js LTS.
    *   File: `tsconfig.json`, `package.json`.
    *   Evidence: `npm run typecheck` pass.
- [ ]     Package được pin trong lockfile, không dùng dependency không cần thiết.
    *   File: `package.json`, `package-lock.json`.
    *   Evidence: `npm ci && npm run build` pass.
- [ ]     CLI chạy được bằng raw JSON.
    *   File: `src/cli.ts`, `src/config/load.ts`.
    *   Hàm: `loadRawConfig()`, `parseCliArgs()`.
    *   Evidence: `npm run cli -- validate --config ./config.example.json`.
### 3.2 Config theo đúng schema
- [ ]     `src` chỉ chứa credentials, không chứa source URL/repo.
    *   File: `src/config/schema.ts`.
    *   Hàm: `parseConfig()`.
    *   Test: `test/config/schema.test.ts` reject `src.url`, `src.repo`.
- [ ]     Source URL/repo/provider/ref/SHA lấy từ hook data.
    *   File: `src/sync/router.ts`, `src/rtdb/events.ts`.
    *   Hàm: `resolveSourceFromHook()`.
    *   Test: `test/sync/router.test.ts`.
- [ ]     `dest` hỗ trợ nhiều provider; mỗi provider có credential inline, mode, org, repo.
    *   File: `src/config/schema.ts`.
    *   Hàm: `parseDestinationProvider()`.
    *   Test: GitHub + Gitea1 + Gitea2 + Azure config.
- [ ]     Azure bắt buộc `org` và `project`.
    *   File: `src/config/schema.ts`.
    *   Test: thiếu từng field phải báo path lỗi.
- [ ]     `one-to-one` và `many-to-one` được validate khác nhau.
    *   File: `src/config/cross-validate.ts`.
    *   Hàm: `validateSyncMode()`.
- [ ]     N→1 folder không absolute, không `..`, không trùng/lồng nhau.
    *   File: `src/config/cross-validate.ts`, `src/shared/paths.ts`.
    *   Hàm: `validateDestinationDirectory()`.
    *   Test: `test/config/folder-safety.test.ts`.
### 3.3 Secret và credential header
- [ ]     Credential source lấy từ `src.creds` theo provider hook.
    *   File: `src/git/auth.ts`, `src/sync/router.ts`.
    *   Hàm: `resolveSourceCredential()`.
- [ ]     Credential destination lấy inline từ `dest.<key>.creds`.
    *   File: `src/providers/factory.ts`.
    *   Hàm: `createProviderAdapter()`.
- [ ]     Không đưa token vào remote URL hoặc `.git/config`.
    *   File: `src/git/auth.ts`, `src/git/workspace.ts`.
    *   Test: `test/security/credential-leak.test.ts`.
    *   Evidence: grep `.git/config`, process args và log không có token.
- [ ]     Header auth đúng theo provider.
    *   File: `src/git/auth.ts`.
    *   Hàm: `buildAuthorizationHeader()`.
    *   Test: Bearer, Basic, custom header.
- [ ]     Token/PAT bị redact trong log và lỗi.
    *   File: `src/shared/logger.ts`, `src/shared/errors.ts`.
    *   Hàm: `redactSecrets()`, `sanitizeError()`.
### 3.4 Git clone, fetch, remote và push
- [ ]     Repo chưa có thì clone; có rồi thì fetch/update.
    *   File: `src/git/workspace.ts`.
    *   Hàm: `ensureSourceWorkspace()`, `fetchSource()`.
    *   Test: `test/git/workspace.test.ts`.
- [ ]     Remote đích có rồi thì dùng; chưa có thì add; URL lệch thì set-url.
    *   File: `src/git/workspace.ts`.
    *   Hàm: `ensureRemote()`.
- [ ]     Source SHA/ref được fetch và kiểm tra trước sync.
    *   File: `src/git/workspace.ts`.
    *   Hàm: `ensureCommitAvailable()`.
- [ ]     1→1 full sync giữ branch/tag/ref/lịch sử theo policy.
    *   File: `src/sync/one-to-one.ts`, `src/git/mirror.ts`.
    *   Hàm: `syncOneToOne()`.
    *   Test: `test/sync/one-to-one.integration.test.ts`.
- [ ]     N→1 không dùng `--mirror` và chỉ cập nhật thư mục được cấp.
    *   File: `src/sync/many-to-one.ts`, `src/git/directory-sync.ts`.
    *   Hàm: `syncDirectory()`.
    *   Test: source A không làm thay đổi folder source B.
- [ ]     File bị xoá ở source cũng bị xoá trong folder đích.
    *   File: `src/git/directory-sync.ts`.
    *   Hàm: `removeStaleFiles()`, `stageDirectoryChanges()`.
- [ ]     Commit N→1 có prefix, source repo, source SHA, folder, user/email.
    *   File: `src/sync/many-to-one.ts`.
    *   Hàm: `buildSyncCommitMessage()`, `commitDirectorySync()`.
    *   Test: `test/sync/commit-marker.test.ts`.
- [ ]     Cùng source SHA không tạo commit lặp.
    *   File: `src/sync/many-to-one.ts`, `src/rtdb/state.ts`.
    *   Hàm: `hasSourceCommitMarker()`, `isAlreadySynced()`.
### 3.5 Provider API và tự tạo repo
- [ ]     Provider adapter có check/create/resolve URL.
    *   File: `src/providers/provider.ts`, `src/providers/github.ts`, `src/providers/gitea.ts`, `src/providers/azure.ts`.
    *   Hàm: `getRepository()`, `createRepository()`, `resolveCloneUrl()`.
- [ ]     `repo:check` chỉ đọc, không tạo/sửa repo.
    *   File: `src/app/check.ts`, `src/cli.ts`.
    *   Hàm: `checkRepositories()`.
- [ ]     `repo:init` tạo repo thiếu, chạy lặp không tạo trùng.
    *   File: `src/app/init.ts`.
    *   Hàm: `initRepositories()`, `ensureRepository()`.
- [ ]     Listener tự tạo repo nếu repo bị thiếu lúc push, sau đó push lại.
    *   File: `src/providers/provider.ts`, `src/sync/router.ts`.
    *   Hàm: `ensureDestinationBeforePush()`, `retryAfterRepositoryCreate()`.
- [ ]     Trạng thái repo được ghi RTDB.
    *   File: `src/rtdb/state.ts`.
    *   Hàm: `saveRepositoryState()`.
### 3.6 RTDB listener và event lifecycle
- [ ]     Service account base64 được decode trong memory.
    *   File: `src/rtdb/admin-client.ts`.
    *   Hàm: `createAdminRtdbClient()` (hybrid: listener `onChildAdded` qua SDK, CRUD/transaction qua REST).
- [ ]     Có fallback `RTDB_AUTH_SECRET` khi không có service account.
    *   File: `src/rtdb/rest-client.ts`.
    *   Hàm: `createRtdbClientFromEnv()` (async, ưu tiên Admin SDK).
- [ ]     Listener đọc `pending` và xử lý tuần tự.
    *   File: `src/rtdb/events.ts`, `src/app/run.ts`.
    *   Hàm: `listenPendingEvents()`, `processPendingEvent()`.
- [ ]     Event đi `pending → processing → processed|failed`.
    *   File: `src/rtdb/events.ts`.
    *   Hàm: `claimEvent()`, `markProcessed()`, `markFailed()`.
- [ ]     Listener tự ghi kết quả sau khi xử lý.
    *   File: `src/rtdb/events.ts`.
    *   Test: `test/rtdb/event-lifecycle.integration.test.ts`.
- [ ]     State source SHA/destination SHA được ghi sau mỗi sync.
    *   File: `src/rtdb/state.ts`.
    *   Hàm: `saveSyncState()`.
### 3.7 Multi-instance và an toàn đồng thời
- [ ]     Claim event bằng RTDB transaction, một event chỉ có một owner.
    *   File: `src/rtdb/locks.ts`.
    *   Hàm: `claimEventAtomically()`.
    *   Test: 3 worker × 20 events.
- [ ]     Lock theo destination repo, đặc biệt bắt buộc cho N→1.
    *   File: `src/rtdb/locks.ts`.
    *   Hàm: `acquireDestinationLock()`, `releaseDestinationLock()`.
- [ ]     Lock có TTL/heartbeat/reaper.
    *   File: `src/rtdb/locks.ts`, `src/app/run.ts`.
    *   Hàm: `refreshLock()`, `recoverExpiredJobs()`.
- [ ]     SIGTERM/SIGINT dừng nhận event mới và nhả lock.
    *   File: `src/app/shutdown.ts`.
    *   Hàm: `gracefulShutdown()`.
### 3.8 Retry, error và observability
- [ ]     Retry network/5xx/timeout; không retry 401/403/config/path lỗi.
    *   File: `src/shared/retry.ts`.
    *   Hàm: `isRetryableError()`, `withRetry()`.
- [ ]     Error có mã, context, provider, repo, eventId; không có secret.
    *   File: `src/shared/errors.ts`.
    *   Hàm: `toPublicError()`.
- [ ]     Log có eventId, instanceId, source SHA, destination, duration, result.
    *   File: `src/shared/logger.ts`.
    *   Hàm: `createContextLogger()`.
- [ ]     Health/heartbeat instance được ghi RTDB.
    *   File: `src/rtdb/instances.ts`.
    *   Hàm: `startHeartbeat()`, `markInstanceStopped()`.
## 4\. Checklist tài liệu bàn giao
### `README.md`
- [ ] Mục tiêu, kiến trúc và giới hạn hệ thống.
- [ ] Sơ đồ `hook → RTDB → claim → Git → destination → processed`.
- [ ] Giải thích `src` chỉ credential và `dest` provider inline credential.
- [ ] Config JSON mẫu đã redact token.
- [ ] Bảng package và lý do chọn.
- [ ] Cách chạy test/build/validate.
- [ ] Link tới requirements và implementation guide.
### `DEPLOY.md`
- [ ] Yêu cầu Node.js LTS, Git CLI và quyền filesystem.
- [ ] Biến môi trường: `RTDB_URL`, `RTDB_AUTH_SECRET`, `GOOGLE_SERVICE_ACCOUNT_B64`, config path, workdir.
- [ ] Cách tạo service account và cấp quyền RTDB tối thiểu.
- [ ] Docker image, volume cache, restart policy, healthcheck.
- [ ] Chạy nhiều instance và lưu ý lock/volume.
- [ ] Rotate PAT/service account, không commit `.env`.
- [ ] Backup/restore RTDB paths.
### `USAGE.md`
- [ ] `validate` với raw JSON.
- [ ] `repo:check` read-only.
- [ ] `repo:init --all` và `--dry-run`.
- [ ] `run`, `run --once`, `sync`, `replay`.
- [ ] Cách đưa hook event vào RTDB để test.
- [ ] Cách đọc `processed`, `failed`, `state`.
- [ ] Ví dụ 1→1 và N→1.
### `ERROR.md`
- [ ] Bảng mã lỗi: config, auth, provider API, git, RTDB, lock, timeout, conflict.
- [ ] Phân biệt lỗi retryable và non-retryable.
- [ ] Cách xử lý 401/403, repo không tồn tại, create conflict, non-fast-forward.
- [ ] Cách replay event failed an toàn.
- [ ] Quy tắc redact secret trong log.
- [ ] Runbook khi instance chết hoặc lock hết hạn.
## 5\. Checklist kiểm thử bàn giao
- [ ] `npm ci` pass từ lockfile sạch.
- [ ] `npm run typecheck` pass.
- [ ] `npm run lint` pass.
- [ ] `npm test -- --coverage` pass với threshold đã công bố.
- [ ] `npm run build` pass.
- [ ] Raw JSON `validate` pass.
- [ ] RTDB Emulator test pass.
- [ ] Local Gitea test pass.
- [ ] 1→1: 1 source → nhiều destination pass.
- [ ] N→1: nhiều source → một repo, folder đúng, file xoá đúng.
- [ ] Repo đích chưa có: init tạo được.
- [ ] Repo đích bị xoá sau init: listener tạo lại và push lại.
- [ ] 3 instance × 20 event: không xử lý trùng.
- [ ] Kill instance giữa event: instance khác nhận lại sau TTL.
- [ ] Grep toàn bộ log/artifact không thấy PAT/token/service account.
- [ ] Docker chạy được từ `.env.example` và config test.
## 6\. Biên bản bàn giao cuối

```text
Version/commit:
Ngày bàn giao:
Người bàn giao:
Người nhận:

Build: PASS / FAIL
Unit test: PASS / FAIL
Integration test: PASS / FAIL
Security scan: PASS / FAIL
Docker smoke test: PASS / FAIL
RTDB emulator test: PASS / FAIL
Provider smoke test: PASS / FAIL

Known issues:
Deferred items:
Rollback procedure:
Dashboard/log location:
Credential rotation date:
```

## 7\. Tiêu chuẩn đóng dự án
Chỉ bàn giao chính thức khi mọi mục bắt buộc có `DONE`, file/hàm/test tương ứng tồn tại, tài liệu chạy được từ máy sạch, và không còn secret trong source, log, image hoặc artifact. Mục nào chưa chứng minh được thì ghi `BLOCKED`, không đánh dấu hoàn thành bằng mô tả miệng.