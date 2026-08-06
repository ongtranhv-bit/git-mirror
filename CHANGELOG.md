# Changelog

## 0.1.0 - 2026-08-06

### Implemented

- Schema v6: `src.creds`, destination inline credentials, source metadata từ hook.
- Config raw/file/RTDB base64, `${ENV}` interpolation, path-level validation.
- Git credential header qua environment, mirror cache, fetch, remote add/set-url.
- GitHub/Gitea/Azure check/create adapters.
- One-to-one branch/tag/history sync.
- Many-to-one exact directory sync, file deletion, commit marker và idempotency.
- RTDB REST/SSE, ETag transactions, event lifecycle, state, destination locks, heartbeat/reaper.
- CLI, Docker, docs và local integration tests.
- Vận hành listener: catch-up `processAllPending` khi khởi động, reaper, retention event cũ theo `RTDB_RETENTION_DAYS` (mặc định 7, dọn lúc start và mỗi 6 giờ).
- Webhook bridge: xóa delivery `/github-noti` sau khi claim/queued/skipped/filtered và sweep delivery sót lúc khởi động, tránh node phình ra.
- Lọc push theo commit message (`src.filter.commit.exclude`: `prefix`/`suffix`/`contains`, hoặc env `SRC_FILTER_COMMIT_EXCLUDE`) — skip tại bridge hoặc đánh dấu destination `skipped`/`COMMIT_FILTERED`.
- Codespace keep-alive tích hợp trong listener (`runtime.codespaceKeepalive` hoặc `CODESPACE_KEEPALIVE_ENABLED`/`CODESPACE_KEEPALIVE_INTERVAL_MINUTES`): ping `gh codespace ssh` định kỳ để reset idle timer; guard `CODESPACES=true` + `CODESPACE_NAME` + `gh` CLI, thiếu điều kiện thì warn + skip, không lỗi.
- Docker build reproducibility: commit `package-lock.json`, sửa bin vendored `tsc` (`./bin/tsc` → `lib/tsc.js`) và thêm shebang để `npm ci` tạo `.bin` link trong image.

### Decisions resolving document conflicts

1. `ConfigSchema v6` mới hơn Requirement v2, nên config runtime dùng `src`/`dest`; không dùng `source`/`destinations`/`syncs`/`resolved` v2.
2. Với schema v6, source repo không tồn tại trong config. Vì vậy `repo:init --all` chỉ init repo cố định; destination có `{sourceRepo}` cần event mẫu hoặc được listener tạo khi hook đến.
3. Many-to-one triển khai exact directory replacement thay vì `git subtree --squash`. Cách này khớp ImplementationGuide mới hơn: xóa folder, copy tree, `git add -A`, commit trailer; test chứng minh source A không sửa source B.
4. Requirement cũ nói `firebase-admin`, Zod, simple-git, pino, p-queue, p-retry và Vitest. Registry npm trong sandbox trả 404, DNS npmjs không khả dụng. Để có artifact thực sự build/test được, 0.1.0 dùng Node.js built-in equivalents. Đây là deviation package-level, không thay đổi security model, lifecycle hoặc sync behavior.
5. Service account vẫn được hỗ trợ: decode base64 trong memory, ký OAuth JWT RS256 và dùng RTDB REST/SSE; không ghi key ra file.

### Known limitations

- Hook branch deletion (`after` zero SHA) chưa hỗ trợ many-to-one.
- RTDB Emulator and provider live smoke tests require Docker/network; currently not tested (live tests completed for GitHub via Docker [bridge+workers] and node-native). Gitea/Azure destinations unreachable in current environment.
- `custom` provider create/check adapter chưa có.
