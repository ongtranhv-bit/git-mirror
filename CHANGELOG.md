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

### Decisions resolving document conflicts

1. `ConfigSchema v6` mới hơn Requirement v2, nên config runtime dùng `src`/`dest`; không dùng `source`/`destinations`/`syncs`/`resolved` v2.
2. Với schema v6, source repo không tồn tại trong config. Vì vậy `repo:init --all` chỉ init repo cố định; destination có `{sourceRepo}` cần event mẫu hoặc được listener tạo khi hook đến.
3. Many-to-one triển khai exact directory replacement thay vì `git subtree --squash`. Cách này khớp ImplementationGuide mới hơn: xóa folder, copy tree, `git add -A`, commit trailer; test chứng minh source A không sửa source B.
4. Requirement cũ nói `firebase-admin`, Zod, simple-git, pino, p-queue, p-retry và Vitest. Registry npm trong sandbox trả 404, DNS npmjs không khả dụng. Để có artifact thực sự build/test được, 0.1.0 dùng Node.js built-in equivalents. Đây là deviation package-level, không thay đổi security model, lifecycle hoặc sync behavior.
5. Service account vẫn được hỗ trợ: decode base64 trong memory, ký OAuth JWT RS256 và dùng RTDB REST/SSE; không ghi key ra file.

### Known limitations

- Hook branch deletion (`after` zero SHA) chưa hỗ trợ many-to-one.
- RTDB Emulator, local Gitea Docker và provider live smoke test chưa chạy trong sandbox không có Docker/network.
- `custom` provider create/check adapter chưa có.
