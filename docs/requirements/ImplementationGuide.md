# ImplementationGuide

# Implementation Guide - Git Sync Service
> Mục tiêu: hướng dẫn triển khai chi tiết theo từng nghiệp vụ, ưu tiên package phổ biến, đang được duy trì và ít code nhất. **Chưa viết code sản phẩm.**  
> Schema áp dụng: `src` chỉ chứa source credentials; URL/repo source lấy từ hook data; `dest` chứa nhiều provider, mỗi provider có credential inline, `mode`, `org`, `project` khi cần và `repo`.
## 0\. Quyết định công nghệ

| Nghiệp vụ | Chọn | Lý do |
| ---| ---| --- |
| Runtime | Node.js LTS + TypeScript strict | Native fetch, AbortSignal, env file và async APIs đủ dùng |
| Build/dev | `tsx` + `tsup` hoặc `tsc` | Ít cấu hình, ESM rõ ràng |
| Config schema | `zod` 4 | TypeScript-first, runtime validation, infer type |
| RTDB | `firebase-admin` | Service account, listener, transaction, atomic writes |
| RTDB fallback | Native `fetch`/`undici` + REST/SSE | Chỉ dùng khi không có service account |
| Git | `simple-git` 3.x + git CLI | Wrapper phổ biến, giữ logic Git đúng theo Git CLI |
| Queue | `p-queue` với `concurrency: 1` | Tuần tự trong một instance; RTDB mới là nơi claim giữa nhiều instance |
| Retry | `p-retry` | Backoff và phân loại abortable error |
| REST provider | Native `fetch` | Không thêm SDK riêng cho từng provider, adapter mỏng hơn |
| Log | `pino` | JSON log nhanh, redact secret |
| Test | `vitest` | Test TypeScript nhanh, mock đơn giản |

Không dùng `p-queue` làm distributed queue. Nó chỉ điều phối trong process; claim/lock liên instance bắt buộc dùng RTDB transaction.
## 1\. Cấu trúc thư mục tối thiểu

```text
src/
  cli.ts
  config/
    schema.ts
    load.ts
    resolve-env.ts
  providers/
    provider.ts
    github.ts
    gitea.ts
    azure.ts
    factory.ts
  git/
    auth.ts
    workspace.ts
    mirror.ts
    directory-sync.ts
  rtdb/
    client.ts
    events.ts
    locks.ts
    state.ts
  sync/
    router.ts
    one-to-one.ts
    many-to-one.ts
  app/
    run.ts
    init.ts
    check.ts
  shared/
    errors.ts
    logger.ts
    paths.ts
```

Nguyên tắc: provider adapter chỉ lo API repo; Git layer chỉ lo clone/fetch/commit/push; RTDB layer chỉ lo state/queue/lock; sync layer ghép các module. Không để provider code gọi trực tiếp RTDB hoặc tự chạy Git.
## 2\. Nghiệp vụ config và schema
### Cách làm
1. Đọc theo ưu tiên: raw JSON CLI/env → file JSON → RTDB base64.
2. Decode base64 nếu cần.
3. Interpolate `${ENV_NAME}` trong credential.
4. Parse bằng Zod.
5. Validate chéo: `src.creds` có provider từ hook; mỗi `dest` có `type`, `mode`, `creds`, `org`, `repo`; Azure có `project`; `many-to-one` không có folder trùng/path traversal.
6. Chuyển thành một object runtime đã resolve, không truyền config thô xuống Git layer.
### Gợi ý code
*   Dùng discriminated union theo `mode`.
*   Credential giữ token dưới kiểu opaque, chỉ builder auth được đọc.
*   Dùng `z.record(z.string(), ...)` cho nhiều destination provider.
*   Unknown fields nên giữ bằng `.passthrough()` để mở rộng config, nhưng reject field sai ở các phần bảo mật.
*   Error dùng `z.treeifyError()` hoặc formatter tương đương để trả path rõ ràng.
### Links
*   [Zod](https://zod.dev/)
*   [Zod npm](https://www.npmjs.com/package/zod)
*   [](https://www.typescriptlang.org/docs/handbook/intro)
*   [Node.js documentation](https://nodejs.org/api/)
## 3\. Nghiệp vụ source hook và credential
Hook data phải chứa tối thiểu:

```json
{
  "eventId": "evt_123",
  "provider": "github",
  "repo": "org/app",
  "url": "https://github.com/org/app.git",
  "ref": "refs/heads/main",
  "after": "<sha>"
}
```

Implementation:
*   Không lưu URL source trong config.
*   Validate URL là HTTPS, reject URL có username/password/query chứa secret.
*   Resolve credential bằng `hook.provider` từ `src.creds`.
*   Tạo `SourceRepository` runtime gồm URL, repo name, ref, SHA và credential đã resolve.
*   Không cho event tự chọn destination tùy ý; destination chỉ lấy từ config.
## 4\. Nghiệp vụ credential header cho Git
### Cách làm khuyến nghị
Dùng `simple-git` cho thao tác Git, nhưng inject auth theo từng process bằng Git config environment variables, tránh token trong remote URL và tránh lộ token trên process arguments:

```text
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=http.extraHeader
GIT_CONFIG_VALUE_0=Authorization: Bearer <token>
```

Với Basic auth, builder tạo `Basic <base64(username:token)>`. `username` có thể là chuỗi rỗng tùy provider. Tạo một `gitEnv(credential)` và truyền env vào command runner; không gọi `addConfig`, vì cấu hình đó có thể ghi vào `.git/config`.

Nếu wrapper không truyền env đủ cho một lệnh, dùng `simple-git.raw([...])` cho các lệnh cần option trước command, nhưng không nối token vào argv. Bắt buộc redact stdout/stderr trước khi log.
### Links
*   [simple-git npm](https://www.npmjs.com/package/simple-git)
*   [simple-git GitHub](https://github.com/steveukx/git-js)
*   [](https://git-scm.com/docs/git)
*   [](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpextraHeader)
## 5\. Nghiệp vụ clone, fetch, remote và push
### Flow
1. Tính path cache bằng hash an toàn của source URL/provider/repo, không dùng path trực tiếp từ hook.
2. Chưa có workspace: clone source.
3. Có workspace: kiểm tra `git rev-parse --is-inside-work-tree` hoặc bare state, rồi fetch/prune.
4. Kiểm tra remote bằng `getRemotes(true)`.
5. Remote có cùng name nhưng URL khác: `setRemote`; chưa có: `addRemote`; đúng rồi: bỏ qua.
6. Fetch source SHA/ref trước khi sync.
7. One-to-one: push refs/tags theo policy.
8. Many-to-one: dùng workspace destination riêng, fetch destination trước khi tạo commit.
### Chọn Git model
*   Source cache có thể dùng mirror/bare để fetch nhanh.
*   Destination one-to-one dùng mirror push chỉ khi config cho phép force/delete.
*   Destination many-to-one phải là worktree bình thường, vì cần copy vào thư mục con và tạo commit.
*   Không dùng mirror cho many-to-one.
### Links
*   [simple-git API](https://github.com/steveukx/git-js#readme)
*   [](https://git-scm.com/docs/git-clone)
*   [](https://git-scm.com/docs/git-fetch)
*   [](https://git-scm.com/docs/git-push)
*   [](https://git-scm.com/docs/git-remote)
## 6\. Nghiệp vụ provider API và tự tạo repo
Tạo interface nhỏ:

```ts
interface ProviderAdapter {
  validateCredential(): Promise<void>;
  getRepository(input: RepoLocator): Promise<RemoteRepository | null>;
  createRepository(input: CreateRepoInput): Promise<RemoteRepository>;
}
```

### GitHub
*   `GET /repos/{owner}/{repo}` để check.
*   `POST /orgs/{org}/repos` để create.
*   Dùng native fetch, header `Authorization: Bearer <token>`, `Accept` và API version theo docs.
### Gitea
*   `GET /api/v1/repos/{owner}/{repo}` để check.
*   `POST /api/v1/orgs/{org}/repos` để create organization repo.
*   Base URL phải nằm trong provider config; không hard-code cloud host.
### Azure DevOps
*   Check/list repo trong project.
*   `POST .../_apis/git/repositories?api-version=7.1` để create.
*   Azure bắt buộc organization và project; PAT thường dùng Basic auth với base64 `:<PAT>`.
### Idempotency
*   `404` khi check → create.
*   Create trả conflict/already exists → check lại, coi là success nếu repo đã tồn tại.
*   Lưu `exists`, `created`, `checkedAt`, provider ID và clone URL vào RTDB state.
*   Listener vẫn retry create khi push nhận `repository not found`, vì repo có thể bị xóa sau init.
### Links
*   [GitHub repository REST API](https://docs.github.com/rest/reference/repos)
*   [GitHub repositories API](https://docs.github.com/en/rest/repos/repos)
*   [Gitea API](https://docs.gitea.com/api/)
*   [Azure Repositories REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories?view=azure-devops-rest-7.1)
*   [Azure Create Repository](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories/create?view=azure-devops-rest-7.1)
*   [Azure Git authentication](https://learn.microsoft.com/en-us/azure/devops/repos/git/auth-overview?view=azure-devops)
## 7\. Nghiệp vụ one-to-one
Mục tiêu: source và destination giữ full refs/lịch sử theo policy.

Implementation sequence:

1. Resolve destination repo: `org`, `project`, `repo` placeholder từ hook.
2. `ensureRepository()` qua provider adapter.
3. Clone destination nếu chưa có, fetch nếu đã có.
4. Kiểm tra remote trước khi add.
5. Push mirror/full refs theo policy; mặc định không xóa ref thừa.
6. Ghi state per destination và kết quả event.

Không tự viết logic pack/ref. Để Git CLI xử lý qua `simple-git`. Chỉ expose các option cần thiết: `force`, `pushTags`, `deleteMissingRefs`.
## 8\. Nghiệp vụ many-to-one vào thư mục con
Mục tiêu: nội dung source tại SHA được sync chính xác vào một thư mục con trong destination.

Implementation sequence:

1. Acquire lock theo destination repo.
2. Fetch source tới SHA và checkout source SHA vào workspace tạm.
3. Clone/fetch destination branch.
4. Validate folder bằng `path.relative`, reject absolute path, `..`, folder trùng hoặc lồng nhau.
5. Xóa nội dung folder đích, giữ `.git` và các folder source khác.
6. Copy source tree vào folder đích, loại `.git` của source.
7. `git add -A -- <folder>` để bắt cả file xóa.
8. Nếu không có diff, ghi idempotent success, không tạo commit.
9. Nếu có diff, commit bằng `user.name`, `user.email`, message prefix, source SHA và Git trailers.
10. Push branch destination; lỗi non-fast-forward thì fetch, rebase/refresh theo policy rồi retry.

Marker chuẩn:

```text
Source-Repo: org/app
Source-Commit: <sha>
Source-Directory: apps/app
```

RTDB state chỉ là cache. Commit trailer trong Git là nguồn kiểm tra cuối để skip cùng source SHA.
## 9\. Nghiệp vụ RTDB config, listener và event state
### Service account path
*   Decode `GOOGLE_SERVICE_ACCOUNT_B64` thành JSON object trong memory; không ghi file ra disk.
*   `admin.initializeApp({credential: cert({projectId, clientEmail, privateKey}), databaseURL})` — chú ý `cert()` nhận **object** (hoặc path file), không nhận chuỗi JSON.
*   `RTDB_URL` có thể chứa child path prefix (ví dụ `/config-code-dh-hospital`). `databaseURL` của SDK phải là **root** (`scheme://host`); app tự tách prefix và dán vào mọi ref (`splitDatabaseUrl`).
*   Transport **hybrid** (`AdminRtdbClient`): listener `onChildAdded` chạy qua SDK (replay existing children rồi live add, callback async được bọc try/catch, không crash); CRUD + transaction delegate sang REST client (path chứa dấu `.` như `config.json` không ref được qua SDK).
*   `createRtdbClientFromEnv()` là **async**, ưu tiên Admin SDK khi có `GOOGLE_SERVICE_ACCOUNT_B64`; SDK khởi tạo lỗi → trả về REST thuần.
### Fallback secret path
*   Chỉ khi không có service account, dùng `RTDB_AUTH_SECRET` cho REST/SSE.
*   Không log URL sau khi gắn secret.
*   Nên coi fallback là compatibility/test path; production ưu tiên Admin SDK (REST SSE bị proxy / GitHub-hosted runner cắt sau thời gian idle).
### Event lifecycle
`pending → processing → processed|failed`
*   Listener đọc `child_added`.
*   Claim bằng transaction trên node event hoặc processing marker.
*   Xử lý qua queue concurrency 1.
*   Chính worker ghi processed/failed, xóa pending sau khi ghi kết quả thành công.
*   Ghi từng destination result, source SHA, destination SHA, duration và error đã redact.
### Links
*   [](https://firebase.google.com/docs/admin/setup)
*   [](https://firebase.google.com/docs/database/admin/start)
*   [](https://firebase.google.com/docs/database/admin/retrieve-data)
*   [](https://firebase.google.com/docs/database/admin/save-data)
*   [](https://firebase.google.com/docs/reference/admin/node/firebase-admin)
*   [](https://firebase.google.com/docs/database/rest/auth)
## 10\. Nghiệp vụ multi-instance, lock và retry
### RTDB transaction
Lock value:

```json
{
  "owner": "host-pid-random",
  "claimedAt": 1730000000000,
  "expiresAt": 1730000900000
}
```

Transaction chỉ nhận lock nếu node rỗng hoặc `expiresAt < now`. Instance giữ heartbeat cho event dài. Khi xử lý xong, giải phóng bằng transaction kiểm tra `owner` để không xóa lock của instance khác.
### Queue và retry
*   `p-queue({concurrency: 1})` cho event trong một instance.
*   `p-retry` cho network timeout, 5xx, non-fast-forward có thể xử lý.
*   Không retry 401/403, config validation, path traversal, permission denied rõ ràng.
*   Retry tạo repo phải check lại sau conflict.
*   Retry push phải fetch lại trước, không mù quáng force push.
### Links
*   [p-queue](https://www.npmjs.com/package/p-queue)
*   [p-queue GitHub](https://github.com/sindresorhus/p-queue)
*   [p-retry](https://www.npmjs.com/package/p-retry)
*   [p-retry GitHub](https://github.com/sindresorhus/p-retry)
*   [](https://firebase.google.com/docs/database/admin/save-data)
## 11\. Nghiệp vụ log, secret redaction và shutdown
*   Dùng child logger với `eventId`, `instanceId`, `destinationId`, `sourceSha`.
*   `pino` redact các path credential/token và dùng custom error serializer.
*   Không log URL chứa query auth, raw hook payload nếu payload có secret, stdout Git chưa redact.
*   SIGTERM/SIGINT: stop listener, pause queue, chờ job hiện tại, release lock, cập nhật instance status.
*   Heartbeat RTDB theo interval và đánh dấu `stoppedAt` khi shutdown bình thường.
### Links
*   [Pino](https://www.npmjs.com/package/pino)
*   [Pino API docs](https://github.com/pinojs/pino/blob/main/docs/api.md)
## 12\. CLI và scripts
Dùng `citty` hoặc `commander`; chọn một, không cần cả hai. Commands:

```text
app validate --config ./config.json
app repo:check --dry-run
app repo:init --all
app run
app run --once
app sync --event <eventId> --dry-run
app replay --event <eventId>
app config:encode ./config.json
app config:decode ./config.b64
```

`repo:check` read-only. `repo:init` tạo repo, nên phải có `--dry-run` và output rõ từng provider/repo.
## 13\. Test plan
### Unit
*   Zod schema và cross-validation.
*   Credential header builder, kiểm tra không lộ token.
*   Resolve URL/repo placeholder.
*   Folder safety và mapping.
*   Commit message/trailer.
*   Retry classifier.
### Integration
*   Firebase Emulator Suite cho RTDB.
*   Local Gitea bằng Docker để test create/check/push.
*   Git bare repositories để test one-to-one và many-to-one.
*   Test repository bị xóa sau init, listener tạo lại và push.
*   Test 3 instances xử lý 20 events, mỗi event chỉ một owner.
### Test package
*   [Vitest](https://vitest.dev/)
*   [](https://firebase.google.com/docs/emulator-suite)
*   [Git documentation](https://git-scm.com/doc)
## 14\. Thứ tự code khuyến nghị
1. Bootstrap TypeScript, logger, error model và CLI.
2. Config loader + Zod + raw JSON test.
3. Credential/header builder và secret redaction.
4. Git workspace clone/fetch/remote abstraction.
5. Provider interface + GitHub/Gitea/Azure adapters.
6. `repo:check` và `repo:init`.
7. One-to-one sync.
8. Many-to-one directory sync + marker.
9. RTDB Admin client + event state.
10. Claim/lock/heartbeat + multi-instance tests.
11. Retry, cleanup, Docker và README.

Đây là thứ tự ít debug nhất: test Git cục bộ trước, provider API sau, rồi mới ghép RTDB concurrency. Đừng bắt đầu bằng listener, vì lúc đó lỗi Git, API và queue sẽ trộn thành một cục khó truy.
## 15\. Package policy
*   Dùng package có release và TypeScript support rõ; pin lockfile sau khi cài.
*   Không thêm SDK provider riêng nếu native fetch + adapter đã đủ.
*   Không dùng package Git thuần JS để tự implement protocol Git.
*   Dùng Node built-in trước khi thêm dependency.
*   Mỗi dependency mới phải có lý do: giảm code, giảm bug hoặc giải quyết tính năng khó.