# Plan

# Plan
## Mục tiêu
Xây dựng service TypeScript đồng bộ Git từ hook event lưu trên Firebase Realtime Database sang nhiều destination provider.
## Quyết định đã chốt
*   `src` chỉ chứa credentials nguồn.
*   Source URL, repo, provider, ref và SHA lấy từ hook data.
*   `dest` chứa nhiều provider; mỗi provider có credential inline, `mode`, `org`, `project` khi cần và `repo`.
*   `one-to-one`: full sync source sang repo đích, tên repo đích theo config hoặc placeholder.
*   `many-to-one`: đồng bộ source vào thư mục con, nội dung phải khớp source, file dư phải bị xóa.
*   Repo thiếu thì `repo:init` hoặc listener tự tạo rồi push lại.
*   RTDB dùng chung cho config, event, state, lock và heartbeat.
*   Nhiều instance claim event và lock destination bằng RTDB transaction.
## Thứ tự triển khai
### Phase 0: Bootstrap
*   TypeScript strict, ESM, Node.js LTS.
*   CLI, logger, error model, env loader.
*   `npm ci`, typecheck, lint, test, build.
### Phase 1: Config
*   Raw JSON, file JSON, RTDB base64.
*   Decode base64 và interpolate env.
*   Zod schema và cross-validation.
*   Validate provider, credential, org, project, repo và mode.
### Phase 2: Git layer
*   Credential header per command.
*   Clone nếu chưa có, fetch nếu có.
*   Check/add/set remote.
*   Source SHA/ref availability.
### Phase 3: Provider adapters
*   Interface check repository, create repository, resolve clone URL.
*   GitHub, Gitea, Azure.
*   `repo:check` read-only.
*   `repo:init` idempotent.
### Phase 4: Sync engine
*   One-to-one full sync.
*   Many-to-one directory sync.
*   Xóa file dư, commit marker, author/email, prefix.
*   Idempotency theo source SHA.
### Phase 5: RTDB worker
*   Listener pending.
*   Claim event transaction.
*   Sequential queue.
*   Processed/failed writes.
*   Shared sync state.
### Phase 6: Multi-instance
*   Destination lock.
*   TTL, heartbeat, reaper.
*   Graceful shutdown.
*   Race tests.
### Phase 7: Release
*   Unit/integration tests.
*   RTDB Emulator và Gitea Docker.
*   Docker image.
*   README, DEPLOY, USAGE, ERROR.
*   Handover evidence.
## Tiêu chuẩn hoàn thành
Không phase nào được đánh dấu hoàn tất nếu thiếu code path, test và evidence tương ứng trong `HandoverChecklist`. Ưu tiên tích hợp Git local trước, provider API sau, RTDB concurrency cuối cùng.