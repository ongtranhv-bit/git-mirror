# Error and Operations Runbook

## Mã lỗi chính

| Nhóm | Mã tiêu biểu | Retry | Cách xử lý |
| --- | --- | --- | --- |
| Config | `CONFIG_INVALID`, `CONFIG_ENV_MISSING`, `CONFIG_JSON_INVALID` | Không | Sửa path/field/env theo message |
| Hook | `HOOK_INVALID`, `HOOK_REF_INVALID`, `HOOK_SHA_INVALID` | Không | Sửa webhook relay payload |
| URL/security | `SOURCE_URL_INVALID`, `SOURCE_URL_HAS_CREDENTIAL`, `PATH_TRAVERSAL` | Không | Chỉ dùng HTTPS/file URL sạch; sửa directory |
| Auth | `AUTH_CONFIG_INVALID`, HTTP 401/403 | Không | Rotate PAT, kiểm tra scope/org/project |
| Provider | `PROVIDER_HTTP_ERROR`, `PROVIDER_NETWORK_ERROR`, `PROVIDER_TIMEOUT` | 5xx/network/timeout | Kiểm tra provider status, DNS, proxy |
| Repo | `DESTINATION_NOT_FOUND`, `PROVIDER_CREATE_CONFLICT` | Tùy | Bật autoCreate hoặc cấp quyền create |
| Git | `GIT_COMMAND_FAILED`, `GIT_SOURCE_COMMIT_MISSING`, `GIT_NO_REFS` | Network/NFF có | Kiểm tra ref/SHA/quyền push |
| RTDB | `RTDB_HTTP_ERROR`, `RTDB_TRANSACTION_CONFLICT`, `RTDB_SSE_FAILED` | 5xx/conflict | Kiểm tra rules, service account, URL |
| Lock | `DESTINATION_LOCKED` | Có | Chờ lock, kiểm tra owner/heartbeat/TTL |
| Timeout | `PROCESS_TIMEOUT`, `PROVIDER_TIMEOUT` | Có | Tăng timeout hoặc giảm repo size |

## 401/403

Không retry. Kiểm tra:

- Source PAT có read repository.
- Destination PAT có read/create/push.
- GitHub PAT có quyền organization.
- Gitea token đúng instance/baseUrl.
- Azure PAT có Code Read/Write/Create và đúng organization/project.
- RTDB service account/rules cho phép path `/sync`.

Không dán token vào command hoặc issue. Dùng `repo:check` và log đã redact.

## Repo không tồn tại

- `autoCreate.enabled=true`: worker gọi API create rồi push.
- `autoCreate.enabled=false`: event vào failed với `DESTINATION_NOT_FOUND`.
- Create conflict: adapter check lại; nếu repo đã tồn tại thì coi là success.
- Repo bị xóa sau init: listener check lại mỗi event và tạo lại nếu được phép.

## Non-fast-forward

Lỗi được phân loại retryable. Mỗi retry N→1 fetch destination, reset theo remote branch, áp lại đúng source tree và commit lại; không force mù quáng. Hết retry thì event vào failed.

## Replay an toàn

1. Đọc failed result và sửa nguyên nhân.
2. Xác nhận source SHA vẫn tồn tại.
3. Chạy `replay --event <id>`.
4. Theo dõi processed/failed.

Cùng SHA được skip qua Git trailer `Source-Commit`; RTDB state chỉ tăng tốc kiểm tra.

## Instance chết hoặc lock hết hạn

- `/processing/{eventId}` chứa owner/expiresAt/payload.
- Reaper chuyển record hết hạn về pending nếu pending chưa tồn tại.
- Destination lock chỉ được release bởi đúng owner.
- Worker refresh event/destination lock mỗi 1/3 TTL.
- Khi instance chết đột ngột, instance khác nhận lại sau TTL.

Nếu cần can thiệp:

1. Xác nhận owner không còn heartbeat.
2. Backup processing/failed.
3. Không xóa lock đang có heartbeat mới.
4. Xóa lock/process record thật sự stale hoặc chờ reaper.
5. Chạy `run --once`.

## Redaction

Logger redact:

- Secret đã được parse từ config/env.
- `Authorization: Bearer|Basic|token ...`.
- Query `auth`, `access_token`, `token`, `pat`.
- Field key token/secret/authorization/credential/password/raw.

Dù có redaction, không bật shell trace (`set -x`) quanh lệnh export secret và không chụp toàn bộ environment vào artifact.
