# Handover Checklist — Implementation Evidence

Ngày kiểm tra: **2026-08-07**  
Version: **0.2.0**  
Trạng thái tổng thể: **IMPLEMENTED WITH EXTERNAL-SERVICE BLOCKERS**

Quy ước:

- **DONE**: có code path, test/evidence đã chạy trong artifact này.
- **PARTIAL**: code có, nhưng bằng chứng chỉ dùng local/in-memory test.
- **BLOCKED**: cần Docker, emulator, mạng hoặc credential thật không có trong sandbox.
- **DEVIATION**: behavior giữ nguyên nhưng package lựa chọn khác ImplementationGuide; xem `CHANGELOG.md`.

## 1. Bootstrap và package

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| TypeScript strict/ESM | DONE | `tsconfig.json`, `src/**/*.ts`; `npm run typecheck` PASS |
| CLI raw JSON/file/RTDB | DONE | `src/cli.ts`, `src/config/load.ts`; validate smoke PASS |
| Lockfile sạch | DONE | `package-lock.json`; `npm ci` PASS; TypeScript 5.8.3 là local file dependency |
| Package theo guide | DEVIATION | Sandbox npm registry 404/DNS blocked; dùng Node built-in equivalents, ghi trong `CHANGELOG.md` |

## 2. Config v6

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| `src` chỉ credentials | DONE | `src/config/schema.ts`; `test/config/schema.test.ts` reject `src.url/repo` |
| Source metadata từ hook | DONE | `resolveSourceFromHook()`; `test/sync/router.test.ts` |
| Destination inline creds | DONE | `DestinationConfig`, schema test |
| Azure yêu cầu project | DONE | schema test |
| One-to-one/many-to-one discriminated | DONE | `parseDestination()` |
| Folder path safety/trùng/lồng | DONE | `src/shared/paths.ts`; 7 folder tests |
| `${ENV}` interpolation | DONE | `src/config/resolve-env.ts`, validate smoke với config example |

## 3. Secret và Git auth

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| Source/destination credential resolve | DONE | `src/sync/router.ts`, `src/providers/factory.ts` |
| Header theo provider | DONE | `src/git/auth.ts`; auth tests |
| Token không vào URL/argv/.git/config | DONE | `gitCredentialEnv()`, workspace integration test đọc `.git/config` |
| Redact log/error | DONE | `src/shared/logger.ts`, `src/shared/errors.ts`, auth redaction test |
| Static secret scan | DONE | `npm run security:scan` PASS |

## 4. Git clone/fetch/remote/push

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| Clone lần đầu, fetch lần sau | DONE | `ensureSourceWorkspace()`; `test/git/workspace.test.ts` |
| Remote add/unchanged/set-url | DONE | `ensureRemote()`; workspace test |
| Verify source SHA | DONE | `ensureCommitAvailable()` |
| One-to-one refs/tags/history | DONE | `test/sync/one-to-one.integration.test.ts` |
| Many-to-one không mirror | DONE | `syncDirectory()` dùng worktree bình thường |
| Chỉ sửa folder được cấp | DONE | multi-source integration test |
| Xóa file stale | DONE | multi-source integration test |
| Commit prefix/source SHA/folder/identity | DONE | commit builder test; many-to-one integration marker |
| Cùng SHA không commit lặp | DONE | commit count trước/sau bằng nhau trong integration test |

## 5. Provider API

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| Adapter check/create/resolve URL | DONE | `src/providers/{github,gitea,azure}.ts` |
| `repo:check` read-only | DONE | `src/app/check.ts` |
| `repo:init` idempotent | DONE | `src/app/init.ts`, check-before-create + conflict recheck |
| Listener create missing repo rồi push | DONE | `ensureDestinationRepository()` trong router trước sync |
| Save repository state | DONE | `saveRepositoryState()` |
| GitHub mock API test | DONE | `test/providers/provider.test.ts` |
| Gitea/Azure live provider smoke | BLOCKED | Cần endpoint/credential thật hoặc Docker Gitea |

## 6. RTDB lifecycle

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| Service account base64 in-memory | DONE | `createServiceAccountTokenProvider()`; không ghi file |
| Secret fallback | DONE | `createRtdbClientFromEnv()` + query auth chỉ trong request |
| REST/SSE listener | DONE | `RestRtdbClient.onChildAdded()` |
| ETag transaction | DONE | `RestRtdbClient.transaction()` |
| Sequential event queue | DONE | promise chain trong `listenPendingEvents()` |
| pending→processing→processed/failed | DONE | event lifecycle integration test |
| Worker tự ghi result | DONE | `markProcessed()`/`markFailed()` test |
| Save sync state | DONE | `saveSyncState()` |
| Firebase Emulator test | BLOCKED | Emulator binary/network không có trong sandbox |

## 7. Multi-instance

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| Atomic event claim | DONE | 3 worker × 20 event in-memory race test |
| Destination lock | DONE | owner-safe lock test |
| TTL/heartbeat/reaper | DONE | refresh interval + expired processing recovery test |
| SIGTERM/SIGINT graceful | DONE | `src/app/shutdown.ts`, listener stop + queue idle |
| Kill process và worker khác nhận lại | PARTIAL | Reaper behavior test pass; chưa chạy multi-process RTDB Emulator |

## 8. Retry, error, observability

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| Retry network/5xx/timeout/NFF | DONE | `src/shared/retry.ts`, retry classifier |
| Không retry 401/403/config/path | DONE | `isRetryableError()` |
| Public error không secret | DONE | `toPublicError()` + redaction |
| Context log | DONE | JSON logger child context event/instance/destination |
| Instance heartbeat | DONE | `src/rtdb/instances.ts` |

## 9. Docs và đóng gói

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| README | DONE | architecture/schema/security/test/limits |
| DEPLOY | DONE | env, service account, Docker, multi-instance, backup/rotate |
| USAGE | DONE | validate/check/init/run/sync/replay/state |
| ERROR | DONE | code table, retry rules, runbook |
| Dockerfile/Compose | DONE | multi-stage offline build, non-root runtime, cache volume, restart, healthcheck |
| Docker smoke | BLOCKED | Docker CLI/daemon không có trong sandbox |

## 10. Lệnh kiểm tra đã chạy

```text
npm ci                              PASS
npm run typecheck                   PASS
npm run lint                        PASS
npm test                            PASS — 68/68
npm test -- --coverage              PASS — lines 85.15%, branches 71.79%, funcs 86.12%
npm run build                       PASS
npm run security:scan               PASS
CLI validate config.example.json    PASS
```

Coverage threshold công bố: **>=70% line**, hiện đạt **85.15%**.

## 10A. Codespace Rotation 0.2.0

| Mục | Trạng thái | Evidence |
| --- | --- | --- |
| Config riêng khỏi AppConfig v6 | DONE | `src/codespace/config.ts`, `/sync/codespace/config` |
| Global lock/lease | DONE | `src/codespace/lock.ts`; test cross-day lock |
| Lifecycle token identity | DONE | `credentials.ts`, `github-lifecycle.ts` |
| Machine + HEAD preflight | DONE | `codespace:preflight` |
| Crash-safe deterministic recovery | DONE | `rotation.ts`; recovery test |
| Runtime readiness after listener attach | DONE | `runtime-status.ts`, `app/run.ts` |
| Promote exact SHA + fresh heartbeat | DONE | `readiness.ts`, rotation tests |
| Post-promote rollback | DONE | rollback test |
| Manual rollback/cleanup | DONE | CLI commands + cleanup test |
| Runtime daily-token narrowing | DONE | `scripts/codespace-runtime-env.sh`; tests |
| GitHub Actions fixed concurrency | DONE | `.github/workflows/codespace-rotation.yml` |
| Real Codespaces API/multi-account canary | BLOCKED | Cần credential/quota/policy thật |

## 11. Blockers và deferred

- Firebase RTDB Emulator integration test.
- Local Gitea Docker create/check/push test.
- Live Azure/Gitea/GitHub smoke với credential thật.
- Docker image runtime smoke.
- Hook branch deletion (`after=000...`) cho many-to-one.
- Custom provider adapter, Git LFS, full-history many-to-one.

Không mục BLOCKED nào được đánh dấu DONE bằng mô tả miệng.
