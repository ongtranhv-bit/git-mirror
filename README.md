# Git Mirror Sync Service

Dịch vụ TypeScript/Node.js nhận hook event từ Firebase Realtime Database (RTDB), claim event bằng transaction và đồng bộ Git sang nhiều destination độc lập.

## Kiến trúc

```text
GitHub/Gitea/Azure push hook
          │
          ▼
/sync/events/pending/{eventId}
          │
          ▼
transaction claim ──> /processing/{eventId}
          │
          ├─ source: clone mirror lần đầu, các lần sau fetch/prune
          ├─ destination API: check repo, tạo idempotent nếu thiếu
          ├─ one-to-one: push branches/tags/history
          └─ many-to-one: thay đúng thư mục con, commit marker, push tuần tự
          │
          ├─ success ──> /processed + /state
          └─ failure ──> /failed
```

Mỗi process xử lý tuần tự. Nhiều instance dùng RTDB transaction để claim event và lock theo destination repository. Cache được tách theo `instanceId`, nên không có hai process cùng sửa một Git worktree.

## Schema v6

`src` **chỉ chứa source credentials**. URL, provider, repo, ref và SHA của source lấy từ hook event. Mỗi entry trong `dest` tự chứa credential riêng:

```json
{
  "src": {
    "creds": {
      "github": { "type": "github", "token": "${SOURCE_GITHUB_PAT}" }
    }
  },
  "dest": {
    "github-main": {
      "type": "github",
      "mode": "one-to-one",
      "creds": { "type": "github", "token": "${DEST_GITHUB_PAT}" },
      "org": "mirror-org",
      "repo": "{sourceRepo}"
    }
  }
}
```

Xem cấu hình đầy đủ tại [`config.example.json`](config.example.json).

## Hai chế độ sync

### One-to-one

- Resolve `{sourceRepo}` và `{sourceOwner}` từ hook.
- Check/tạo repo đích qua GitHub, Gitea hoặc Azure REST API.
- Push branch/tag/ref theo `push.include`, `push.exclude`, `force`, `pushTags` và `deleteMissingRefs`.
- Credential được truyền bằng `GIT_CONFIG_*`/`http.extraHeader`; token không nằm trong URL, argv hoặc `.git/config`.

### Many-to-one

- Source được checkout đúng SHA vào worktree tạm.
- Chỉ thư mục đã cấp cho source bị xóa và copy lại; thư mục source khác giữ nguyên.
- `git add -A -- <directory>` bắt cả file bị xóa.
- Commit có prefix, author/committer cấu hình và Git trailer `Source-Commit`/`Source-Directory`.
- Trailer trong Git là nguồn sự thật để skip cùng source SHA; RTDB state là cache.

## Yêu cầu chạy

- Node.js 22 trở lên.
- Git CLI 2.30 trở lên.
- Quyền đọc/ghi thư mục `runtime.workdir`.
- RTDB URL cùng service account base64 hoặc `RTDB_AUTH_SECRET` cho lệnh listener.

## Kiểm tra nhanh

```bash
cp .env.example .env
npm ci
npm run typecheck
npm run lint
npm test
npm run build

SOURCE_GITHUB_PAT=test \
SOURCE_GITEA_PAT=test \
SOURCE_AZURE_PAT=test \
DEST_GITHUB_PAT=test \
DEST_GITEA_PAT=test \
DEST_AZURE_PAT=test \
npm run cli -- validate --config ./config.example.json
```

## CLI

```text
validate --config <file> | --config-json <json>
repo:check [--event-file <file>]
repo:init [--event-file <file>] [--dry-run]
run [--once] [--dry-run]
sync --event-file <file> [--dry-run]
replay --event <eventId>
config:encode <config.json>
config:decode <config.b64>
config:push <config.json>
webhook:bridge [--once]
```

`webhook:bridge` đọc delivery webhook GitHub nằm dưới node RTDB (mặc định `/github-noti`, đổi bằng `WEBHOOK_PATH`), chuyển event push sang `/sync/events/pending` để worker xử lý.

Chi tiết trong [`USAGE.md`](USAGE.md), triển khai trong [`DEPLOY.md`](DEPLOY.md), xử lý lỗi trong [`ERROR.md`](ERROR.md).

## Bảo mật

- Reject URL có username/password hoặc query key giống token/secret/PAT.
- Git auth chỉ đi qua process environment `GIT_CONFIG_COUNT`, không ghi config repository.
- Logger redact token đã đăng ký, Authorization header và auth query.
- Service account được decode và ký JWT trong memory; không ghi key ra disk.
- Không commit `.env` hoặc config đã resolve secret.

## Công nghệ thực tế

| Thành phần | Implementation |
| --- | --- |
| Runtime/build | Node.js 22, TypeScript strict, `tsc` 5.8.3 vendored dưới `vendor/typescript` |
| Git | Git CLI qua `child_process.spawn` |
| RTDB | Native `fetch`: REST, ETag transaction và SSE |
| Service account | OAuth JWT RS256 bằng `node:crypto` |
| Queue/retry/log | Module nhỏ dùng Node built-in |
| Test | `node:test`, Git bare repositories |

Implementation guide đề xuất Zod, firebase-admin, simple-git, pino, p-queue, p-retry và Vitest. Registry npm trong môi trường triển khai trả 404 và DNS ngoài không khả dụng, nên bản bàn giao dùng Node built-in và vendored TypeScript compiler để `npm ci`, build và test vẫn chạy được trên máy sạch mà không giả lập lockfile. Quyết định này được ghi trong [`CHANGELOG.md`](CHANGELOG.md).

## Giới hạn hiện tại

- Push xóa branch có `after` toàn số 0 chưa được hỗ trợ cho many-to-one.
- Git LFS, wiki, issue, PR, release và full-history many-to-one ngoài phase này.
- Provider `custom` có schema credential nhưng chưa có adapter tạo repo.
- `repo:init` không thể tự liệt kê repo động `{sourceRepo}` vì schema v6 không lưu danh sách source; cần `--event-file`, hoặc listener tự tạo khi nhận hook.
- RTDB Emulator và Gitea Docker smoke test không áp dụng; đã verified GitHub destination live với Docker (3 containers) và node-native. Gitea/Azure destinations unreachable.

## Tài liệu nguồn

Bản đặc tả gốc được lưu nguyên văn trong [`docs/requirements`](docs/requirements). `ConfigSchema v6` được ưu tiên khi mâu thuẫn với Requirement v2, đúng theo AgentPrompt.
