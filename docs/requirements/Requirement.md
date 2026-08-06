# Requirement

# Git Mirror Sync Service — Requirements
> Trạng thái: **DRAFT v2 — chỉ đặc tả yêu cầu, chưa implement.**  
> Cập nhật v2: env secret riêng cho RTDB, listener tự ghi kết quả, RTDB làm kho dữ liệu chung, clone/fetch + check remote trước khi push, schema tổ chức theo source/channel, auto-create repo + script init, N→1 dạng **thư mục con**, commit message mang marker nguồn.  
> Ngôn ngữ: TypeScript (Node.js LTS mới nhất). Nguyên tắc: **ráp package có sẵn, code tối thiểu**.
* * *
## 1\. Mục tiêu & phạm vi
### 1.1 Mục tiêu
Service TypeScript chạy nền: nhận sự kiện `push` từ GitHub qua Firebase Realtime Database, fetch code về và đẩy sang **nhiều repo đích thuộc nhiều kênh (channel)** khác nhau — mỗi loại provider có thể có nhiều kênh: `github`, `gitea1`, `gitea2`, `azure1`, `azure2`... mỗi kênh có credential riêng.
### 1.2 Trong phạm vi
*   Lắng nghe event qua RTDB (không tự host webhook server).
*   Hai chế độ sync: **1→1 (mirror, trùng tên repo)** và **N→1 (gộp vào thư mục con của repo đích)**.
*   Cấu hình 100% bằng JSON, mở rộng được, lưu base64 trên RTDB, chạy được bằng raw JSON để test.
*   Xác thực git bằng **credential header**, không nhét token vào URL remote.
*   Tự tạo repo đích nếu chưa có + script init hàng loạt, ghi URL đã resolve ngược lại config.
*   RTDB là kho dữ liệu dùng chung cho nhiều instance chạy song song an toàn.
### 1.3 Ngoài phạm vi (Non-goals)
*   Không viết webhook receiver (bên ngoài đã push vào RTDB).
*   Không có UI quản trị.
*   Không đồng bộ issue / PR / wiki / release, chỉ nội dung git.
*   Không xử lý Git LFS ở phase 1.

* * *
## 2\. Kiến trúc luồng tổng thể

```plain
GitHub push (nhiều repo bắn noti vào)
   └─> Webhook (external) ──> RTDB /events/pending/{eventId}
                                     │
                            App instance (listener)
                                     ├─ claim event (transaction, chống trùng)
                                     ├─ resolve sync rule từ config
                                     ├─ local cache: chưa có → clone, có rồi → fetch
                                     ├─ remote đích: có rồi → bỏ qua, chưa có → add
                                     ├─ repo đích chưa tồn tại → gọi API tạo
                                     ├─ push: 1→1 mirror  |  N→1 vào thư mục con
                                     └─ LISTENER TỰ GHI kết quả → /events/processed
```

Đặc tính bắt buộc:
*   **Sequential processing**: mỗi instance xử lý 1 event tại 1 thời điểm (queue concurrency = 1).
*   **At-least-once + idempotent**: chạy lại 1 event không gây hỏng dữ liệu.
*   **Stateless**: mọi state nằm trên RTDB + thư mục cache repo (có thể xoá).

* * *
## 3\. Cấu hình (JSON)
### 3.1 Biến môi trường

| Env | Bắt buộc | Mô tả |
| ---| ---| --- |
| `CONFIG_JSON` | không | Raw JSON (hoặc base64) — dùng để test, ưu tiên cao nhất |
| `CONFIG_FILE` | không | Đường dẫn file JSON local |
| `RTDB_URL` | có (khi dùng RTDB) | Base URL database, ví dụ `https://x.firebaseio.com` |
| `RTDB_CONFIG_PATH` | không | Path node chứa config, mặc định `/sync/config` |
| `RTDB_AUTH_SECRET` | không | Env riêng cho secret gắn `?auth=` khi không có service account |
| `GOOGLE_SERVICE_ACCOUNT_B64` | không | Service account JSON dạng base64 |
| `INSTANCE_ID` | không | Mặc định `hostname-pid-random` |

**Quy tắc chọn cách kết nối RTDB (đã chốt):**
1. Có `GOOGLE_SERVICE_ACCOUNT_B64` → decode base64, dùng `firebase-admin` (đường chính: realtime listener + transaction).
2. Không có → fallback dùng `RTDB_AUTH_SECRET` gắn `?auth=` vào URL, đi qua REST/SSE.
3. Không có cả hai → chỉ chạy được chế độ raw JSON / `--dry-run`, fail-fast với thông báo rõ.
> Secret **không nằm sẵn** trong `RTDB_URL`; app tự ghép lúc gọi để không lộ URL đầy đủ trong log.
### 3.2 Lưu trữ
*   Config lưu trên RTDB dưới dạng **chuỗi base64** của JSON (tránh vấn đề ký tự đặc biệt / key không hợp lệ của RTDB).
*   App: `base64 → utf8 → JSON.parse → validate schema` rồi mới dùng.
*   Service account key cũng nạp bằng **base64** qua env, không commit file.
### 3.3 Yêu cầu về schema
*   Phải **validate bằng schema runtime**, sai config thì fail-fast với thông báo rõ (path lỗi).
*   Phải **mở rộng được**: thêm provider mới / thêm field mới không phá config cũ (unknown field cho phép, có versioning `configVersion`).
*   Hỗ trợ **biến môi trường trong giá trị**: `"token": "${GITEA_PAT}"` để không lưu secret thô nếu người dùng muốn.
### 3.4 Cấu trúc config (v2)
Tổ chức lại theo đúng mô hình thực tế: **một nguồn (source) có nhiều repo bắn noti vào, dùng creds của source để pull/fetch** + **nhiều kênh đích (channel), mỗi kênh creds riêng**.

```jsonc
{
  "configVersion": 2,

  // ---------- NGUỒN: creds git dùng để clone/fetch ----------
  "source": {
    "provider": "github",
    "baseUrl": "https://github.com",
    "owner": "my-org",
    "credential": { "scheme": "bearer", "token": "${GH_PAT}" },
    // whitelist repo được phép sync; rỗng = nhận mọi repo bắn noti vào
    "repos": ["app", "lib", "web"],
    // override creds cho repo cá biệt (khác tổ chức, PAT riêng...)
    "credentialOverrides": {
      "web": { "scheme": "basic", "username": "bot", "token": "${GH_PAT_WEB}" }
    }
  },

  // ---------- ĐÍCH: chia theo channel, mỗi channel creds riêng ----------
  "destinations": {
    "github": {
      "provider": "github", "baseUrl": "https://github.com", "owner": "mirror-org",
      "credential": { "scheme": "bearer", "token": "${GH_MIRROR_PAT}" },
      "autoCreate": { "enabled": true, "private": true }
    },
    "gitea1": {
      "provider": "gitea", "baseUrl": "https://git.a.com", "owner": "team",
      "credential": { "scheme": "basic", "username": "bot", "token": "${GITEA1_PAT}" },
      "autoCreate": { "enabled": true, "private": true }
    },
    "gitea2": {
      "provider": "gitea", "baseUrl": "https://git.b.com", "owner": "infra",
      "credential": { "scheme": "basic", "username": "bot", "token": "${GITEA2_PAT}" },
      "autoCreate": { "enabled": true, "private": true }
    },
    "azure1": {
      "provider": "azure", "baseUrl": "https://dev.azure.com",
      "organization": "org-a", "project": "Platform",
      "credential": { "scheme": "basic", "username": "", "token": "${AZDO1_PAT}" },
      "autoCreate": { "enabled": true }
    },
    "azure2": {
      "provider": "azure", "baseUrl": "https://dev.azure.com",
      "organization": "org-b", "project": "Legacy",
      "credential": { "scheme": "basic", "username": "", "token": "${AZDO2_PAT}" },
      "autoCreate": { "enabled": false }
    }
  },

  // ---------- QUY TẮC SYNC ----------
  "syncs": [
    {
      "id": "mirror-all",
      "mode": "one-to-one",              // tên repo đích = tên repo nguồn
      "enabled": true,
      "sources": ["app", "lib", "web"],  // "*" = tất cả repo trong source.repos
      "destinations": ["github", "gitea1", "azure1"],
      "refs": { "include": ["refs/heads/*", "refs/tags/*"], "exclude": ["refs/heads/tmp/*"] },
      "push": { "mirror": true, "force": true, "pushTags": true, "deleteMissingRefs": false }
    },
    {
      "id": "join-monorepo",
      "mode": "many-to-one",             // mỗi repo nguồn = 1 THƯ MỤC trong repo đích
      "enabled": true,
      "sources": [
        { "repo": "app", "folder": "apps/app" },
        { "repo": "lib", "folder": "packages/lib" }
      ],
      "destination": {
        "channel": "gitea2",
        "repoName": "monorepo"           // hoặc "url": "https://git.b.com/infra/monorepo.git"
      },
      "branchMap": { "refs/heads/main": "refs/heads/main" },
      "strategy": "subtree-squash",      // xem mục 5.4
      "commit": {
        "authorName": "mirror-bot",
        "authorEmail": "mirror-bot@company.com",
        "committerName": "mirror-bot",
        "committerEmail": "mirror-bot@company.com",
        "messagePrefix": "[sync]",
        "template": "{{prefix}} {{sourceRepo}}: {{sourceSubject}}",
        "trailers": {
          "Source-Repo":   "{{sourceOwner}}/{{sourceRepo}}",
          "Source-Ref":    "{{sourceRef}}",
          "Source-Commit": "{{sourceSha}}",
          "Synced-At":     "{{timestamp}}",
          "Synced-By":     "{{instanceId}}"
        }
      }
    }
  ],

  // ---------- DO SCRIPT INIT GHI NGƯỢC LẠI ----------
  "resolved": {
    "gitea1/app":      { "url": "https://git.a.com/team/app.git",       "createdAt": 1730000000000 },
    "gitea2/monorepo": { "url": "https://git.b.com/infra/monorepo.git", "createdAt": 1730000000000 },
    "azure1/app":      { "url": "https://dev.azure.com/org-a/Platform/_git/app", "createdAt": 1730000000000 }
  },

  "runtime": {
    "workdir": "./.cache/repos",
    "lockTtlSeconds": 900,
    "maxRetries": 3,
    "retryBackoffMs": 5000,
    "gitTimeoutMs": 600000,
    "logLevel": "info"
  },

  "rtdb": {
    "pendingPath":    "/sync/events/pending",
    "processingPath": "/sync/events/processing",
    "processedPath":  "/sync/events/processed",
    "failedPath":     "/sync/events/failed",
    "statePath":      "/sync/state",
    "locksPath":      "/sync/locks",
    "instancesPath":  "/sync/instances",
    "retentionDays": 14
  }
}
```

### 3.5 Validate chéo (bắt buộc)
*   Repo nguồn trong `syncs` phải tồn tại trong `source.repos`.
*   Channel trong `syncs.destinations` phải tồn tại trong `destinations`.
*   `many-to-one`: hai source **không được** trùng `folder`, và folder không được lồng nhau (`app` vs `app/sub`).
*   `many-to-one`: bắt buộc có `repoName` **hoặc** `url`, thiếu cả hai → fail.
*   Channel bật `autoCreate` phải đủ thông tin API (owner / organization / project).

* * *
## 4\. Xác thực Git (credential header)
*   **Bắt buộc** dùng header, không dùng `https://user:token@host/...`.
*   Cơ chế: `git -c http.extraHeader="Authorization: <scheme> <value>"` truyền per-command.
*   Scheme theo provider:
    *   GitHub: `Bearer <PAT>` (hoặc `Basic base64(x-access-token:PAT)`)
    *   Azure DevOps: `Basic base64(:PAT)`
    *   Gitea / GitLab / Bitbucket: `Basic base64(user:PAT)` hoặc token header riêng
    *   `custom`: cho phép khai báo raw `headerName` + `headerValueTemplate` để mở rộng provider mới
*   Yêu cầu bảo mật:
    *   Không log giá trị header, **redact** toàn bộ token trong log & error message.
    *   Không ghi credential vào `.git/config` của repo cache.
    *   Ưu tiên truyền qua stdin/`-c` thay vì argv nếu môi trường chia sẻ process list.

* * *
## 5\. Chiến lược Git & hai chế độ sync
### 5.1 Local cache + remote (nguyên tắc "chưa có thì clone, có rồi thì fetch")
*   Đường dẫn cache ổn định: `{workdir}/{provider}/{owner}/{repo}.git`.
*   Repo cache **chưa có** → `git clone --mirror` (một lần duy nhất).
*   Repo cache **có rồi** → `git remote update --prune` / `git fetch --prune --tags`, **không clone lại**.
*   Cache hỏng (thiếu `HEAD`, kẹt lock file) → tự xoá và clone lại, log cảnh báo.
*   Remote đích: **check** **`git remote`** **trước khi push** — đã có tên remote đó thì bỏ qua, chưa có thì `git remote add`.
*   Remote tồn tại nhưng URL khác config → `git remote set-url` + log warning.
*   Đặt tên remote theo channel cho dễ debug: `dst-github`, `dst-gitea1`, `dst-azure2`.
### 5.2 Repo đích chưa tồn tại → tự tạo
*   Trước lần push đầu, gọi API provider kiểm tra repo đích tồn tại chưa.
*   Chưa có + `autoCreate.enabled = true` → tạo repo (private theo config), ghi URL thật vào `resolved` trên RTDB.
*   Chưa có + `autoCreate.enabled = false` → fail event kèm thông báo rõ, **không tự tạo**.
*   Việc tạo repo phải **idempotent**: lỗi "đã tồn tại" coi như thành công.
### 5.3 One-to-one (mirror, trùng tên)
*   Tên repo đích **giống hệt** tên repo nguồn → không cần khai báo mapping từng repo.
*   Push mirror sang từng channel trong `destinations`.
*   Mỗi channel độc lập: 1 channel fail không chặn channel còn lại; event chỉ `processed` khi tất cả OK, ngược lại vào `failed` kèm danh sách channel lỗi.
*   `deleteMissingRefs` mặc định `false` (an toàn); bật lên thì mirror xoá ref thừa ở đích.
### 5.4 Many-to-one (gộp vào thư mục con)
Mỗi repo nguồn tương ứng **một thư mục** trong repo đích (`apps/app`, `packages/lib`...). Đây **không phải** push ref thông thường mà là ghép nội dung, nên phải tạo commit mới ở repo đích.

| `strategy` | Cách làm | Ưu / nhược |
| ---| ---| --- |
| `subtree-squash` (mặc định) | `git subtree add/pull --prefix=<folder> --squash` | Lệnh git có sẵn, gần như không cần code, tự sinh marker `git-subtree-split: <sha>` |
| `read-tree` | `git read-tree --prefix=<folder>/ <src-sha>` + `git commit-tree` | Nhanh nhất, kiểm soát 100% commit message, mỗi lần sync = 1 commit |
| `full-history` | `git filter-repo --to-subdirectory-filter` rồi merge | Giữ full lịch sử, nặng — phase sau |

Ràng buộc bắt buộc:
*   **Cấm** `--mirror` / force toàn repo ở chế độ này (sẽ xoá công của source khác).
*   Chỉ đụng đúng thư mục của source đó, thư mục khác giữ nguyên.
*   Nhiều source cùng đẩy vào 1 repo đích phải **xếp hàng qua lock** (mục 7), không push song song.
*   Trước khi ghi phải `fetch` repo đích để tránh non-fast-forward; xung đột → retry, hết retry → `failed`.
### 5.5 Commit message & dấu hiệu đã đồng bộ
Commit tạo ở repo đích phải mang thông tin commit nguồn:

```plain
[sync] app: fix login redirect

Source-Repo: my-org/app
Source-Ref: refs/heads/main
Source-Commit: 9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456
Synced-At: 2026-08-06T06:15:00Z
Synced-By: worker-3
```

*   `messagePrefix` cấu hình được (`[sync]`, `chore(mirror):`...).
*   `template` cấu hình được. Biến khả dụng: `{{prefix}}`, `{{sourceOwner}}`, `{{sourceRepo}}`, `{{sourceRef}}`, `{{sourceBranch}}`, `{{sourceSha}}`, `{{sourceShortSha}}`, `{{sourceSubject}}`, `{{sourceAuthor}}`, `{{timestamp}}`, `{{instanceId}}`.
*   `trailers` cấu hình được, ghi theo chuẩn git trailer để `git interpret-trailers` đọc được.
*   **Author/committer name + email** lấy từ config, không phụ thuộc git config của máy.

**Nhận biết "commit nguồn đã chuyển lên rồi" — dùng cả 2 lớp:**
1. **Trailer trong commit đích**: trước khi sync, `git log -1 --grep="Source-Commit: <sha>" -- <folder>` → có rồi thì **skip**.
2. **Sổ cái trên RTDB** (check nhanh, không phải quét git): `/sync/state/{channel}/{repo}/{folder}` lưu `{ lastSourceSha, destCommitSha, lastSyncedAt, eventId }`.

Quy tắc: RTDB là cache để check nhanh, **commit trailer là nguồn sự thật**. Lệch nhau → tin git và ghi lại RTDB.
### 5.6 Script khởi tạo repo (init)
Chạy một lần trước khi sync, hoặc khi thêm repo/channel mới — `app init --all` / `app init --sync <id>`:

1. Duyệt toàn bộ cặp (source, channel) trong `syncs`.
2. Kiểm tra repo đích tồn tại chưa qua API provider.
3. Chưa có → tạo theo `autoCreate`; đã có → bỏ qua.
4. Với `many-to-one`: tạo repo đích, khởi tạo nhánh mặc định nếu repo trống.
5. **Ghi URL thật vào** **`resolved`** trong config trên RTDB (encode base64 lại).
6. In bảng tổng kết: tạo mới / đã có / lỗi.

Hỗ trợ `--dry-run`, và chạy lại nhiều lần phải an toàn (idempotent).

* * *
## 6\. RTDB: hàng đợi & dữ liệu dùng chung
### 6.1 Cây dữ liệu (RTDB là kho dùng chung duy nhất giữa các instance)

```plain
/sync
  /config            (base64 JSON)
  /events
    /pending/{id}    ← webhook ghi vào
    /processing/{id} ← instance đã claim
    /processed/{id}  ← LISTENER TỰ GHI khi xong
    /failed/{id}
  /state/{channel}/{repo}/{folder}   ← lastSourceSha, destCommitSha, lastSyncedAt
  /locks/{lockKey}                   ← owner, claimedAt, expiresAt
  /instances/{instanceId}            ← heartbeat, event đang chạy
```

Không dùng DB/redis nào khác: config, hàng đợi, lock, sổ ghi sha đã sync, heartbeat đều nằm trên RTDB.
### 6.2 Cấu trúc node event (do webhook ghi vào)

```jsonc
"/sync/events/pending/{eventId}": {
  "provider": "github",
  "repo": "org/app",
  "ref": "refs/heads/main",
  "after": "<sha>",
  "receivedAt": 1730000000000,
  "raw": { }
}
```

### 6.3 Vòng đời
`pending` → (claim) `processing` → `processed` **hoặc** `failed`
*   Listener bám `child_added` trên `pendingPath`, xử lý **tuần tự** theo thứ tự thời gian nhận.
*   **Chính listener ghi kết quả**: xong thì xoá node khỏi `pending` và ghi node `processed` kèm chi tiết từng đích (channel, repo, ref, sha nguồn, sha đích, thời gian, kết quả). Không phụ thuộc process bên ngoài.
*   Ghi `/sync/state` sau mỗi lần sync thành công.
*   Hết retry → `failed` kèm error đã redact; replay thủ công bằng `app replay --event <id>`.
*   Job dọn `processed` / `failed` cũ hơn `retentionDays`.
### 6.4 Gộp event (khuyến nghị)
*   Nhiều push liên tiếp cùng repo/branch → được phép gộp, chỉ sync trạng thái mới nhất. Có cờ bật/tắt trong config.

* * *
## 7\. Chạy nhiều instance song song (concurrency safety)
Yêu cầu: nhiều instance chạy cùng lúc, **một event chỉ được xử lý đúng 1 lần**.
*   **Claim bằng RTDB transaction**: instance ghi `{ owner: instanceId, claimedAt, expiresAt }`; transaction fail → bỏ qua event đó.
*   **Lock theo tài nguyên đích**, key = `{channel}/{repo}`: hai event khác nhau cùng ghi vào 1 repo đích phải xếp hàng (cực kỳ quan trọng với chế độ N→1).
*   **TTL lock + heartbeat**: instance chết giữa chừng thì lock hết hạn (`lockTtlSeconds`) và event quay lại `pending` (có bộ reaper quét `processing` quá hạn).
*   **instanceId** duy nhất: hostname + pid + random, log kèm để truy vết.
*   **Graceful shutdown**: nhận SIGTERM/SIGINT → dừng nhận event mới, hoàn tất event đang chạy, nhả lock.
*   Cache repo trên đĩa phải an toàn khi nhiều instance dùng chung volume: lock file cục bộ hoặc workdir tách theo instance.

* * *
## 8\. Tech stack & package (ưu tiên dùng sẵn, code ít nhất)
> Cài bản **latest** rồi pin lại trong `package.json` khi implement.

| Nhu cầu | Package | Ghi chú |
| ---| ---| --- |
| Ngôn ngữ / build | `typescript`, `tsx` (dev), `tsup`/`tsc` (build) | ESM, strict mode |
| RTDB (service account) | `firebase-admin` | listener realtime + transaction |
| RTDB (URL + auth secret) | `undici` / fetch built-in | REST + SSE khi không có SA |
| Git commands | `simple-git` | wrapper git binary, hỗ trợ `-c http.extraHeader` |
| Gộp thư mục con (N→1) | `git subtree` của git binary | không tự code, dùng lệnh sẵn |
| Provider API (tạo repo) | `octokit` (GitHub), REST qua `undici` cho Gitea/Azure | check tồn tại + create |
| Queue / retry | `p-queue` (concurrency 1), `p-retry`, `p-limit` | xử lý tuần tự, backoff |
| Validate config | `zod` | schema + type inference, fail-fast |
| Log | `pino` (+ `pino-pretty` dev) | JSON log, redact built-in |
| CLI | `citty` hoặc `commander` | `run`, `init`, `sync`, `--dry-run` |
| Env | Node `--env-file` native | tránh thêm dep |
| Test | `vitest` | unit + integration |
| Lint/format | `biome` | gọn, thay cả eslint + prettier |

Ràng buộc: **git CLI phải có sẵn trong môi trường/Docker image** (kèm `git-subtree`). Không tự implement giao thức git.

* * *
## 9\. Yêu cầu phi chức năng
*   **Idempotency**: chạy lại event đã xử lý → no-op, **không tạo commit trùng**.
*   **Retry**: lỗi mạng/HTTP 5xx/timeout → retry với backoff; lỗi auth (401/403) → fail ngay, không retry vô ích.
*   **Timeout** cho mọi lệnh git và mọi call API provider.
*   **Log có cấu trúc**: `eventId`, `instanceId`, `syncId`, `sourceRepo`, `channel`, `destRepo`, `durationMs`, `result`. **Redact toàn bộ secret.**
*   **Health/readiness**: heartbeat lên `/sync/instances/{instanceId}`; HTTP health endpoint là tuỳ chọn.
*   **Hiệu năng**: mirror cache (clone một lần, sau đó chỉ fetch tăng dần), không clone lại mỗi lần.
*   **Đóng gói**: Dockerfile nhỏ (node alpine + git), chạy được bằng `docker run` chỉ với env.

* * *
## 10\. Chế độ chạy (CLI)

| Lệnh | Mục đích |
| ---| --- |
| `app run` | Listen RTDB, xử lý liên tục (mặc định) |
| `app run --once` | Xử lý hết pending rồi thoát (cron / CI) |
| `app init --all` / `--sync <id>` | Tạo repo đích còn thiếu, ghi URL vào `resolved` |
| `app sync --sync <id> [--repo <name>]` | Chạy tay, không cần event |
| `app replay --event <id>` | Đẩy event từ `failed` về `pending` |
| `app validate --config <file>` | Kiểm tra config raw JSON |
| `app config:encode / :decode / :push` | JSON ↔ base64, nạp lên RTDB |
| `--dry-run` | Chạy toàn luồng, không push và không tạo repo thật |

* * *
## 11\. Acceptance criteria
1. Chạy được bằng raw JSON, không cần Firebase (`validate` + `--dry-run` OK).
2. Có `GOOGLE_SERVICE_ACCOUNT_B64` → dùng service account; bỏ đi, chỉ còn `RTDB_AUTH_SECRET` → vẫn chạy được.
3. Repo cache chưa có → clone; chạy lần hai → chỉ fetch, không clone lại.
4. Remote đích đã tồn tại → không thêm trùng, không lỗi.
5. Repo đích chưa tồn tại + `autoCreate` bật → tự tạo, URL xuất hiện trong `resolved`.
6. 1→1: push 1 repo nguồn → xuất hiện đúng tên repo trên **github + gitea1 + azure1**.
7. N→1: `app` và `lib` vào cùng repo đích, nằm đúng `apps/app` và `packages/lib`, **không repo nào xoá file của repo kia**.
8. Commit ở repo đích có prefix, đúng author/email cấu hình, và trailer `Source-Commit`.
9. Chạy lại cùng event → **không tạo commit mới** (nhận diện qua trailer + `/sync/state`).
10. 3 instance × 20 event → mỗi event xử lý đúng 1 lần; kill 1 instance giữa chừng → instance khác nhận lại sau TTL.
11. Node event xong biến mất khỏi `pending`, xuất hiện ở `processed` **do chính listener ghi**.
12. Grep toàn bộ log: không lộ token/PAT/secret nào.
13. Thêm channel mới (ví dụ `gitea3`) chỉ bằng sửa JSON, không sửa code.

* * *
## 12\. Rủi ro & câu hỏi còn mở
Đã chốt ở v2: secret RTDB dùng **env riêng** (`RTDB_AUTH_SECRET`), có service account base64 thì ưu tiên dùng, không có thì fallback secret mặc định. Listener tự ghi kết quả. RTDB làm kho dữ liệu chung.

| # | Vấn đề | Cần chốt |
| ---| ---| --- |
| R1 | N→1 có cần giữ full lịch sử từng commit không? | Mặc định đang chọn squash 1 commit/lần sync |
| R2 | N→1: tag xử lý sao (tag nhiều source dễ trùng tên)? | Bỏ qua tag, hay thêm prefix `app/v1.0`? |
| R3 | N→1: file bị xoá ở nguồn có xoá ở đích không? | `subtree`/`read-tree` thay nguyên thư mục → có xoá, xác nhận đúng ý |
| R4 | Ai đó commit tay vào đúng thư mục ở repo đích | Ghi đè hay dừng và báo conflict? |
| R5 | Repo lớn / Git LFS | Phase nào hỗ trợ? |
| R6 | Dung lượng đĩa cache repo | Chính sách dọn (LRU / TTL)? |
| R7 | Ai ghi event vào RTDB | Cloud Function hay webhook relay riêng? |
| R8 | Branch mặc định lệch nhau (`main` vs `master`) | Dựa hoàn toàn vào `branchMap`? |

* * *
## 13\. Chia nhỏ công việc (backlog)
### Phase 0 — Nền tảng
- [ ] Khởi tạo repo TypeScript (ESM, strict, tsx/tsup, biome)
- [ ] Chia module: `config` / `rtdb` / `git` / `provider` / `sync` / `lock` / `log`
- [ ] Logger `pino` + rule redact secret
- [ ] Khung CLI (`run`, `init`, `sync`, `validate`, `replay`, `--dry-run`, `--once`)
### Phase 1 — Config
- [ ] Schema `zod` v2: `source` / `destinations` / `syncs` / `resolved` / `runtime` / `rtdb`
- [ ] Loader raw JSON (env `CONFIG_JSON` + file)
- [ ] Loader RTDB qua service account base64 (`firebase-admin`)
- [ ] Loader RTDB qua `RTDB_URL` + `RTDB_AUTH_SECRET` (env riêng, fallback)
- [ ] Decode base64 + interpolate `${ENV_VAR}`
- [ ] Validate chéo: folder trùng/lồng nhau, channel/repo không tồn tại, thiếu `repoName`/`url`
- [ ] `config:encode` / `config:decode` / `config:push`
### Phase 2 — Lớp Git
- [ ] Bọc `simple-git`, inject `http.extraHeader` theo từng lệnh
- [ ] Builder header theo provider (github / gitea / azure / custom)
- [ ] Cache repo: chưa có → clone mirror, có rồi → fetch --prune; tự sửa cache hỏng
- [ ] Quản lý remote: check tồn tại → bỏ qua / add / set-url
- [ ] Timeout + phân loại lỗi (auth / network / git)
### Phase 3 — Provider API & script init
- [ ] Adapter check repo tồn tại + tạo repo (GitHub / Gitea / Azure)
- [ ] `autoCreate` idempotent (đã tồn tại = thành công)
- [ ] Lệnh `app init --all` + `--dry-run` + bảng tổng kết
- [ ] Ghi `resolved` URL ngược lại config trên RTDB
### Phase 4 — Sync 1→1
- [ ] Push mirror sang nhiều channel, mỗi channel độc lập
- [ ] Lọc ref include/exclude, tags, `deleteMissingRefs`
- [ ] Tổng hợp kết quả theo từng channel
### Phase 5 — Sync N→1 (thư mục con)
- [ ] Chiến lược `subtree-squash` (mặc định) và `read-tree`
- [ ] Map repo nguồn → folder đích, chặn trùng/lồng nhau
- [ ] Render commit message: prefix + template + trailers
- [ ] Áp author/committer name & email từ config
- [ ] Nhận diện commit đã sync: trailer `Source-Commit` + `/sync/state`
- [ ] Xử lý non-fast-forward: fetch lại + retry
### Phase 6 — RTDB & hàng đợi
- [ ] Listener `child_added` trên `pending`, xử lý tuần tự (`p-queue` = 1)
- [ ] Chuyển node pending → processing → processed / failed, **listener tự ghi kết quả**
- [ ] Ghi `/sync/state` sau mỗi lần sync thành công
- [ ] Lệnh `replay`, job dọn theo `retentionDays`
- [ ] (Tuỳ chọn) Gộp event trùng repo/branch
### Phase 7 — Đa instance
- [ ] `instanceId` + heartbeat `/sync/instances`
- [ ] Claim event bằng transaction
- [ ] Lock theo `{channel}/{repo}`
- [ ] Reaper quét `processing` quá TTL → trả về `pending`
- [ ] Graceful shutdown (SIGTERM/SIGINT), nhả lock
- [ ] Test đua: 3 instance × 20 event
### Phase 8 — Chất lượng & vận hành
- [ ] Retry + backoff (`p-retry`), không retry lỗi auth
- [ ] Unit test: schema, header builder, folder mapping, render commit message
- [ ] Integration test: Gitea local (docker) + RTDB emulator
- [ ] Dockerfile (node + git) + docker-compose mẫu
- [ ] README: env vars, config mẫu, cách nạp base64 lên RTDB
- [ ] Kiểm tra rò rỉ secret trong log
### Phase 9 — Mở rộng (sau)
- [ ] Thêm provider: GitLab, Bitbucket, generic HTTP
- [ ] `full-history` cho N→1 (`git filter-repo`)
- [ ] Hỗ trợ Git LFS
- [ ] Metrics / alert khi `failed` tăng