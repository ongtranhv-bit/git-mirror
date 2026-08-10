# Plan

## Mục tiêu
Xây dựng service TypeScript đồng bộ Git từ hook event lưu trên Firebase Realtime Database sang nhiều destination provider.

## Quyết định đã chốt
* `src` chỉ chứa credentials nguồn.
* Source URL, repo, provider, ref và SHA lấy từ hook data.
* `dest` chứa nhiều provider; mỗi provider có credential inline, `mode`, `org`, `project` khi cần và `repo`.
* `one-to-one`: full sync source sang repo đích, tên repo đích theo config hoặc placeholder.
* `many-to-one`: đồng bộ source vào thư mục con, nội dung phải khớp source, file dư phải bị xóa.
* Repo thiếu thì `repo:init` hoặc listener tự tạo rồi push lại.
* RTDB dùng chung cho config, event, state, lock và heartbeat.
* Nhiều instance claim event và lock destination bằng RTDB transaction.

## Thứ tự triển khai tổng thể
### Phase 0: Bootstrap
* TypeScript strict, ESM, Node.js LTS.
* CLI, logger, error model, env loader.
* `npm ci`, typecheck, lint, test, build.

### Phase 1: Config
* Raw JSON, file JSON, RTDB base64.
* Decode base64 và interpolate env.
* Zod schema và cross-validation.
* Validate provider, credential, org, project, repo và mode.

### Phase 2: Git layer
* Credential header per command.
* Clone nếu chưa có, fetch nếu có.
* Check/add/set remote.
* Source SHA/ref availability.

### Phase 3: Provider adapters
* Interface check repository, create repository, resolve clone URL.
* GitHub, Gitea, Azure.
* `repo:check` read-only.
* `repo:init` idempotent.

### Phase 4: Sync engine
* One-to-one full sync.
* Many-to-one directory sync.
* Xóa file dư, commit marker, author/email, prefix.
* Idempotency theo source SHA.

### Phase 5: RTDB worker
* Listener pending.
* Claim event transaction.
* Sequential queue.
* Processed/failed writes.
* Shared sync state.

### Phase 6: Multi-instance
* Destination lock.
* TTL, heartbeat, reaper.
* Graceful shutdown.
* Race tests.

### Phase 7: Release
* Unit/integration tests.
* RTDB Emulator và Gitea Docker.
* Docker image.
* README, DEPLOY, USAGE, ERROR.
* Handover evidence.

## Kế hoạch triển khai org config, reconcile report và tối ưu clone

### Phase A: Bổ sung org config cho source
* Mở rộng schema cấu hình Reconcile để hỗ trợ `orgs` dạng chuỗi CSV, ví dụ `--orgs org-a,org-b` hoặc trường config tương ứng; phạm vi này chỉ dùng cho nghiệp vụ `Reconcile`, các nghiệp vụ hook/listener/sync khác không đổi.
* Giữ tương thích ngược: nếu không cấu hình org thì vẫn dùng cơ chế hiện tại lấy repository qua credential (`/user/repos`).
* Với GitHub source, bổ sung discovery theo organization:
  * Gọi API danh sách repository của từng org đã cấu hình.
  * Phân trang đầy đủ với `per_page=100`.
  * Deduplicate theo `owner/repo` khi một repo xuất hiện từ nhiều nguồn discovery.
  * Áp dụng owner/repo filter sau khi đã có danh sách tổng để report tổng nguồn chính xác.
* Cross-validation:
  * Kiểm tra credential id tồn tại.
  * Parse chuỗi `orgs` theo dấu `,`, trim khoảng trắng, loại org rỗng và dedupe org trùng trong cùng credential.
  * Log cảnh báo hoặc lỗi cấu hình rõ ràng khi provider chưa hỗ trợ org discovery.

### Phase B: Reconcile dựa trên tổng số repository source
* Tách bước reconcile thành 3 tầng rõ ràng:
  1. Discovery toàn bộ source repositories.
  2. Build danh sách cặp `source repository -> destination target` cần kiểm tra.
  3. Check trạng thái destination và quyết định queue/dry-run.
* Bổ sung counters cấp toàn bộ run:
  * `sourceTotal`: tổng repository source sau discovery và trước khi lọc theo destination.
  * `sourceSelected`: tổng repository source sau owner/repo filter.
  * `destinationChecksTotal`: tổng số destination/repository cần kiểm tra.
  * `destinationExisting`: tổng destination repository đã tồn tại và truy cập được.
  * `destinationMissing`: tổng destination repository chưa tồn tại.
  * `needsReconcile`: tổng destination check bị drift/missing và cần reconcile.
  * `valid`: tổng check hợp lệ/in-sync.
  * `invalid`: tổng check không hợp lệ/drift/missing/error.
* Bổ sung counters theo từng source repository để report biết repo nào thiếu destination nào, lý do nào, và event nào sẽ được queue.
* Đảm bảo `--dry-run` đi qua cùng code path kiểm tra, chỉ bỏ qua thao tác ghi RTDB pending event và mọi thao tác thay đổi dữ liệu.

### Phase C: Cải tiến kiểm tra one-to-one và many-to-one
* Với destination chưa tồn tại:
  * Adapter `getRepository` là nguồn xác nhận chính.
  * Ghi `destination-missing` vào drift list.
  * Đưa destination vào danh sách cần reconcile để luồng hiện tại tạo repo/sync khi không dry-run.
* Với one-to-one:
  * Giữ nghiệp vụ hiện tại là so sánh refs theo `push` policy.
  * Ưu tiên kiểm tra commit mới nhất của default branch/source ref trước để phát hiện nhanh drift phổ biến.
  * Sau đó vẫn chạy so sánh refs đầy đủ để không thay đổi hành vi mirror hiện tại.
* Với many-to-one:
  * Tính số lượng thư mục/repository con kỳ vọng trong destination theo source repositories map vào cùng destination repo.
  * Đếm số thư mục con thực tế trong destination branch theo directory mapping đã render.
  * Nếu số lượng không khớp, đánh dấu drift với lý do dạng `directory-count-mismatch` và vẫn giữ các kiểm tra hiện tại theo commit marker/tree match cho từng repo.
  * Không coi thư mục ngoài phạm vi mapping là lỗi nếu cấu hình hiện tại cho phép nhiều nội dung cùng tồn tại; chỉ so sánh các thư mục được quản lý bởi cấu hình mirror.

### Phase D: Report và logging
* Bổ sung log đầu run: credential/orgs được scan, `sourceTotal`, filter đang áp dụng, dry-run hay không.
* Bổ sung log cuối run dạng summary có đầy đủ:
  * Tổng số repo source.
  * Tổng số đã tồn tại.
  * Tổng số thiếu.
  * Tổng số cần reconcile.
  * Tổng số hợp lệ/không hợp lệ.
  * Tổng số queued/would-queue/errors như hiện tại.
* Chuẩn hóa output CLI reconcile để in cùng summary cho cả normal mode và `--dry-run`.
* Giữ chi tiết per-repo/per-destination trong JSON result để phục vụ audit.

### Phase E: Tối ưu clone one-to-one
* Kiểm tra các lệnh hiện tại cần working tree đầy đủ hay chỉ cần refs/object metadata:
  * Reconcile one-to-one hiện chỉ dùng `listRemoteRefs`, không cần clone destination.
  * Sync one-to-one cần mirror/fetch/push refs, không cần checkout working tree.
* Áp dụng clone tiết kiệm an toàn theo phạm vi:
  * Reconcile one-to-one: không clone nếu chỉ cần so sánh remote refs.
  * Destination workspace có checkout: chỉ dùng sparse khi thao tác many-to-one cần một số thư mục cụ thể.
  * Không bật sparse checkout cho path cần full working tree.
  * Cân nhắc `--filter=blob:none` cho clone one-to-one bare/mirror nếu test chứng minh push mirror không thiếu object; fallback tự động fetch đầy đủ khi Git báo missing object.
* Thêm test hồi quy để chứng minh hành vi nghiệp vụ không đổi: refs/tags/push policy, branch missing, destination missing, dry-run không ghi dữ liệu.

### Phase F: Test và tiêu chí nghiệm thu
* Unit tests:
  * Parse config với nhiều org, cấu hình cũ, org trùng, credential không tồn tại.
  * Discovery GitHub org pagination/dedup/filter.
  * Reconcile counters cho missing/existing/drift/error.
  * Dry-run tạo report nhưng không ghi pending event.
  * Many-to-one directory count match/mismatch.
* Integration/local Git tests:
  * One-to-one in-sync theo latest commit.
  * One-to-one drift khi destination thiếu commit/ref.
  * Many-to-one thiếu directory con.
  * Clone blobless/sparse không làm thay đổi output sync.
* Acceptance criteria:
  * Report reconcile luôn thể hiện đủ các tổng số yêu cầu.
  * `--dry-run` và mode thật cho cùng kết quả kiểm tra, khác nhau duy nhất ở thao tác ghi/queue.
  * Repo source từ nhiều org được lấy đầy đủ và không bị đếm trùng.
  * Tối ưu clone có fallback an toàn và không phá nghiệp vụ hiện tại.


## Đề xuất chi tiết cần xác nhận trước khi thay đổi code

### Nguyên tắc triển khai an toàn
* Không thay đổi hành vi sync đang chạy nếu config mới không được bật. Cấu hình hiện tại phải tiếp tục chạy theo cơ chế cũ.
* Mọi thay đổi reconcile phải ưu tiên read-only ở bước kiểm tra; chỉ queue event như hiện tại khi không dùng `--dry-run`.
* Triển khai theo feature nhỏ, có test hồi quy cho từng luồng trước khi bật mặc định.
* Không bật tối ưu clone cho đường sync production nếu chưa chứng minh được không thiếu object khi push/fetch.

### Luồng 1: Source discovery và org config
#### Hiện tại
* `src.creds` chỉ chứa credential nguồn.
* Manual reconcile lấy repository GitHub qua credential bằng API dạng user repositories.
* Tổng số repo source hiện phụ thuộc vào phạm vi trả về của credential, chưa có cấu hình org rõ ràng để audit.

#### Đề xuất thay đổi
* Thêm tham số/cấu hình `orgs` dạng chuỗi, nhiều org join bằng dấu `,`, chỉ áp dụng cho lệnh/nghiệp vụ `Reconcile`. Ví dụ:
  ```json
  {
    "reconcile": {
      "orgs": "org-a,org-b,org-c"
    }
  }
  ```
  hoặc CLI tương đương:
  ```bash
  git-mirror reconcile --orgs org-a,org-b,org-c --dry-run
  ```
* Nếu `orgs` không được truyền hoặc chuỗi rỗng sau khi trim, giữ nguyên discovery theo credential như hiện tại.
* Nếu có `orgs`, Reconcile parse chuỗi CSV, trim từng phần tử, bỏ phần tử rỗng, dedupe, rồi gọi danh sách repo của từng org, phân trang đầy đủ và dedupe repo theo `owner/repo`.
* Owner/repo filter của CLI chỉ áp dụng sau discovery để report vẫn biết tổng repo source ban đầu.
* Các nghiệp vụ khác ngoài `Reconcile` không đọc `orgs` và không thay đổi hành vi.

#### Ảnh hưởng so với hiện tại
* Config/luồng hiện tại không đổi hành vi khi không chạy `Reconcile` hoặc không truyền `orgs`.
* `Reconcile` có `orgs` giúp kiểm soát chính xác org nào được scan, tránh bỏ sót repo org do quyền/affiliation không rõ.
* Số lượng API call sẽ tăng theo số org và số trang repo.

#### Ưu điểm
* Audit được tổng repo theo từng organization.
* Hỗ trợ nhiều org một cách rõ ràng, dễ mở rộng cho provider khác.
* Dedupe giúp tránh queue trùng khi credential nhìn thấy cùng repo qua nhiều đường.

#### Nhược điểm/rủi ro
* Token cần quyền đọc repo trong các org cấu hình; thiếu quyền sẽ gây lỗi discovery org đó.
* Nhiều org lớn có thể làm reconcile lâu hơn do tăng API calls.
* Khi org discovery lỗi do permission/rate limit, Reconcile phải log lỗi rõ org/credential, xử lý retry theo retry policy hiện có, và đưa lỗi vào report nếu vẫn thất bại sau retry.

### Luồng 2: Reconcile summary và kiểm tra số lượng
#### Hiện tại
* Reconcile duyệt từng source repo được discover, rồi kiểm tra từng destination tương ứng.
* Result hiện có các nhóm `scanned`, `queued`, `wouldQueue`, `inSync`, `filtered`, `empty`, `errors`, `destinationErrors`.
* Chưa có counters riêng cho destination tồn tại, thiếu, hợp lệ/không hợp lệ và tổng số destination checks.

#### Đề xuất thay đổi
* Tách reconcile thành các bước rõ ràng:
  1. Discover toàn bộ source repos.
  2. Apply filter để ra source repos được chọn.
  3. Build ma trận kiểm tra `sourceRepo x destination` sau khi loại destination disabled/self-loop.
  4. Dùng API/provider thực tế để kiểm tra repository tồn tại ở destination; không lấy trạng thái từ RTDB để kết luận existing/missing.
  5. Check drift theo mode bằng dữ liệu thực tế từ provider/Git remote.
  6. Tổng hợp report và queue event nếu cần.
* Bổ sung summary fields:
  * `sourceTotal`: tổng repo source discover được trước filter.
  * `sourceSelected`: tổng repo source sau filter.
  * `destinationChecksTotal`: tổng cặp source/destination cần kiểm tra.
  * `destinationExisting`: số check có destination repo tồn tại/truy cập được.
  * `destinationMissing`: số check xác nhận destination repo chưa tồn tại.
  * `needsReconcile`: số check missing/drift cần reconcile.
  * `valid`: số check hợp lệ/in-sync.
  * `invalid`: số check không hợp lệ gồm missing/drift/error.
* `--dry-run` chạy đủ các bước trên bằng API/provider thực tế nhưng không ghi pending event vào RTDB.

#### Ảnh hưởng so với hiện tại
* Normal mode vẫn queue event giống hiện tại khi phát hiện drift.
* Dry-run sẽ tốn thời gian tương đương normal reconcile vì phải kiểm tra thật đầy đủ qua API/provider thực tế, không dựa vào cache/state trong RTDB.
* Output report có thêm fields, các field cũ vẫn giữ để tránh phá automation hiện có.

#### Ưu điểm
* Người vận hành biết chính xác tổng source, tổng đã tồn tại, tổng thiếu và tổng cần reconcile.
* Dry-run trở thành công cụ audit an toàn trước khi chạy thật.
* Dễ phát hiện lệch số lượng trong many-to-one thay vì chỉ dựa vào từng commit marker.

#### Nhược điểm/rủi ro
* Thêm API calls `getRepository` cho destination có thể tăng thời gian chạy.
* Vì không dùng RTDB để kết luận trạng thái existing/missing, kết quả chính xác hơn nhưng phụ thuộc nhiều hơn vào provider API availability/rate limit.
* Nếu provider API rate limit, reconcile có thể chậm hoặc fail nhiều hơn trước.
* Cần định nghĩa rõ `valid/invalid` để không gây hiểu nhầm: đề xuất `valid = in-sync`, `invalid = missing + drift + error`; skipped/filtered/empty nằm ở nhóm riêng.

### Luồng 3: Destination missing
#### Hiện tại
* Khi `listRemoteRefs` không được, code gọi adapter để kiểm tra repo; nếu repo không tồn tại thì đánh dấu drift và queue.

#### Đề xuất thay đổi
* Giữ nguyên nghiệp vụ này.
* Chuẩn hóa reason `destination-missing` vào report và tăng `destinationMissing`, `needsReconcile`, `invalid`.
* Với `--dry-run`, chỉ report `would-queue`, không tạo repo, không ghi RTDB.

#### Ưu điểm
* Không đổi logic tạo/sync thực tế.
* Report rõ repo nào thiếu và thiếu ở destination nào.

#### Nhược điểm/rủi ro
* Repo private có lỗi permission có thể bị nhầm với missing nếu adapter/provider trả về 404 cho cả hai trường hợp. Cần log context để phân biệt khi có thể.

### Luồng 4: One-to-one reconcile
#### Hiện tại
* So sánh refs source/destination theo push policy.
* Reconcile one-to-one không cần clone destination, chỉ cần remote refs.

#### Đề xuất thay đổi
* Giữ so sánh refs đầy đủ là nguồn quyết định cuối cùng.
* Thêm fast-path kiểm tra commit mới nhất của source ref/default branch để log reason dễ hiểu hơn, nhưng không bỏ qua bước refs policy hiện tại.
* Nếu latest commit lệch, report reason `latest-commit-mismatch`; nếu refs khác theo policy, report `ref-mismatch:<ref>` hoặc `extra-ref:<ref>` như hiện tại.

#### Ảnh hưởng so với hiện tại
* Không thay đổi tiêu chí cuối cùng để queue one-to-one.
* Log/report dễ đọc hơn vì chỉ ra latest commit lệch trước.

#### Ưu điểm
* Phát hiện nhanh tình huống destination chưa cập nhật latest branch.
* Giảm nhu cầu clone vì remote refs đủ để kiểm tra.

#### Nhược điểm/rủi ro
* Có thể thêm độ phức tạp trong reason nếu latest commit lệch nhưng refs policy loại trừ ref đó. Đề xuất chỉ dùng fast-path trên refs nằm trong push policy.

### Luồng 5: Many-to-one reconcile và đối chiếu số lượng thư mục
#### Hiện tại
* Kiểm tra từng source repo trong destination bằng commit marker nếu có.
* Nếu không có marker phù hợp, clone workspace destination và so sánh tree của thư mục con với source commit.

#### Đề xuất thay đổi
* Trước hoặc sau check từng repo, tính nhóm many-to-one theo cùng destination repo/branch.
* Với mỗi nhóm, render directory của toàn bộ source repos được chọn để có tập thư mục kỳ vọng.
* Đọc danh sách thư mục thực tế trong destination branch, chỉ trong phạm vi directory root mà cấu hình quản lý.
* So sánh số lượng/tập thư mục kỳ vọng với thực tế:
  * Thiếu thư mục kỳ vọng: reason `directory-missing:<path>`.
  * Có thư mục được quản lý nhưng không còn source tương ứng: reason `directory-extra:<path>` nếu cấu hình bật kiểm tra extra managed dirs.
  * Số lượng lệch: summary reason `directory-count-mismatch`.
* Vẫn giữ check commit marker/tree match hiện tại cho từng source repo.

#### Ảnh hưởng so với hiện tại
* Có thêm khả năng phát hiện thiếu repo con ngay cả khi từng repo được scan chưa bao phủ hết trạng thái destination.
* Nếu bật kiểm tra extra dir, có thể phát hiện thư mục cũ cần dọn; mặc định đề xuất chỉ cảnh báo, chưa tự xóa để tránh ảnh hưởng dữ liệu ngoài mirror.

#### Ưu điểm
* Đáp ứng yêu cầu đối chiếu theo số lượng source/destination.
* Giúp phát hiện drift cấu trúc many-to-one rõ hơn.
* Vẫn giữ nghiệp vụ sync hiện tại làm cơ chế sửa drift.

#### Nhược điểm/rủi ro
* Cần xác định chính xác “phạm vi thư mục được quản lý” để không đếm nhầm file/thư mục do người dùng tạo thủ công.
* Directory mapping phức tạp có thể làm việc dedupe path khó hơn.
* Clone/check working tree nhiều hơn one-to-one, có thể tốn I/O nếu destination rất lớn.

### Luồng 6: Tối ưu clone blobless/sparse
#### Hiện tại
* Many-to-one destination workspace có hỗ trợ `blobless + sparse` khi truyền `sparseDirectories`.
* One-to-one reconcile không cần clone destination.
* One-to-one sync hiện chủ yếu làm việc với refs/mirror, cần cẩn trọng vì push mirror có thể cần object đầy đủ.

#### Đề xuất quyết định
* Triển khai luôn blobless/sparse cho one-to-one ở các nơi an toàn, vì many-to-one đã chạy ổn với cơ chế này.
* Reconcile one-to-one tiếp tục dùng remote refs, không clone nếu chỉ cần so sánh refs.
* Khi one-to-one cần workspace, clone bằng `--filter=blob:none` để giảm bandwidth/object download.
* Không dùng sparse checkout cho one-to-one nếu nghiệp vụ cần full working tree; chỉ dùng sparse khi thao tác chỉ cần một tập path cụ thể.
* Many-to-one tiếp tục dùng `--filter=blob:none --sparse` và truyền `sparseDirectories` đầy đủ hơn nếu chỉ cần một số directory.
* Thêm fallback bắt buộc: khi Git báo thiếu object/blob do partial clone, fetch lại không filter rồi retry một lần.

#### Ảnh hưởng so với hiện tại
* One-to-one có thay đổi cơ chế clone/fetch workspace theo hướng blobless ngay khi triển khai.
* Many-to-one tiếp tục hưởng lợi từ blobless/sparse hiện có và có thể giảm thêm bandwidth/I/O nếu sparseDirectories được truyền đúng.
* Không dùng feature flag; an toàn được đảm bảo bằng test hồi quy và fallback fetch đầy đủ khi thiếu object.

#### Ưu điểm
* Giảm bandwidth, disk I/O và thời gian clone cho cả n-1 và 1-1.
* Vẫn giữ lợi ích reconcile one-to-one vì không clone khi chỉ cần remote refs.
* Không cần vận hành thêm feature flag/cấu hình bật tắt.

#### Nhược điểm/rủi ro
* Thay đổi clone one-to-one có rủi ro cao hơn so với chỉ tối ưu many-to-one vì đang tác động luồng production 1-1.
* Fallback fetch đầy đủ có thể làm một số lần sync đầu tiên chậm hơn.
* Blobless support phụ thuộc version Git và server/provider; phải có log để biết khi nào fallback xảy ra.

### Thứ tự rollout đề xuất
1. Cập nhật CLI/config Reconcile nhận `orgs` dạng chuỗi CSV, chỉ áp dụng cho nghiệp vụ Reconcile.
2. Cập nhật GitHub discovery theo org, thêm retry/log lỗi org và tests pagination/dedup/backward compatibility.
3. Bổ sung summary counters từ API/provider thực tế, không kết luận existing/missing từ RTDB, và giữ nguyên fields cũ.
4. Chuẩn hóa dry-run đi qua cùng path kiểm tra bằng API/provider thực tế nhưng không ghi RTDB.
5. Bổ sung many-to-one directory count ở chế độ report-only cho extra directories; thiếu directory/drift vẫn đưa vào needs reconcile theo nghiệp vụ hiện tại.
6. Tối ưu clone many-to-one trong phạm vi sparse an toàn.
7. Triển khai blobless cho one-to-one luôn, không feature flag, kèm fallback fetch đầy đủ khi thiếu object và test hồi quy bắt buộc.

### Câu hỏi cần xác nhận trước khi code
* Khi một org discovery lỗi do permission/rate limit: log lỗi, retry theo retry policy hiện có, và đưa vào report nếu vẫn lỗi sau retry.
* Với many-to-one, thư mục extra trong phạm vi mirror: report-only, không queue reconcile để dọn ở giai đoạn này.
* Blobless cho one-to-one sync: triển khai luôn, không feature flag, nhưng bắt buộc có fallback fetch đầy đủ và test hồi quy.

## Tiêu chuẩn hoàn thành
Không phase nào được đánh dấu hoàn tất nếu thiếu code path, test và evidence tương ứng trong `HandoverChecklist`. Ưu tiên tích hợp Git local trước, provider API sau, RTDB concurrency cuối cùng.
