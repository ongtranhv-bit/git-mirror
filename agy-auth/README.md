# agy-auth — lấy 2 URL auth của Antigravity CLI (`agy`)

Thư mục này chứa script dùng **PTY thật** để điều khiển CLI `agy` của Antigravity,
tự động bắt **2 URL quan trọng** mà AGY sinh ra trong quá trình Google OAuth:

| # | URL | Khi nào xuất hiện |
|---|-----|--------------------|
| 1 | **OAuth authorization URL** — `https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=...&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&...` | Khi chọn **Google OAuth** trong menu login |
| 2 | **Eligibility / verify URL** — `https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&...` | Sau khi login thành công, **chỉ khi Eligibility Check fail** (tài khoản chưa được verify/không đủ điều kiện) |

## Files

```
agy-auth/
├── agy_oauth_flow.py   # script chính (Python 3, dùng pty.fork)
└── README.md
```

## Yêu cầu

- Python 3.
- `agy` đã cài (`curl -fsSL https://antigravity.google/cli/install.sh | bash`), mặc định tại `~/.local/bin/agy` (có thể truyền `--agy-binary`).
- Môi trường có **terminal thật** (PTY). Script KHÔNG dùng pipe `stdin/stdout` thường để `agy` nhận biết nó đang chạy trong terminal.

## Cách chạy

```bash
python3 agy_oauth_flow.py --outdir ./out
```

Tùy chọn:

```bash
# đọc code từ file thay vì dán tay (code 1 dòng)
python3 agy_oauth_flow.py --code-file /path/to/auth-code --outdir ./out

# binary agy ở chỗ khác / timeout khác
python3 agy_oauth_flow.py --agy-binary /opt/agy --timeout 600 --outdir ./out
```

## Các bước — tự động hay thủ công?

Script điều khiển toàn bộ TUI bằng phím bấm (escape sequence) qua PTY.
**Không cần bạn chọn gì trong TUI.** Chia theo vai trò:

| Bước | Loại | Mô tả |
|------|------|-------|
| Mở `agy -i "Reply with OK"` trên PTY | 🔧 **Tự động** | `pty.fork()`, `TERM=xterm-256color`, terminal rộng 2000 cột (URL không bị wrap) |
| Chọn `Google OAuth` | 🔧 **Tự động** | khi thấy `Select login method` → gửi Enter (Google OAuth là mục mặc định) |
| Bắt **URL #1** (OAuth) | 🔧 **Tự động** | regex URL từ raw PTY bytes, in ra stdout + ghi `oauth-url.txt` |
| Mở URL #1, đăng nhập Google, copy code | 👤 **Thủ công — ngoài terminal** | bạn thao tác trên browser |
| Dán **authorization code** | 👤 **Thủ công — duy nhất trong terminal** | script in prompt `> ` và chờ bạn dán code rồi Enter |
| Gửi code vào session | 🔧 **Tự động** | script gửi code + Enter vào PTY |
| Onboarding: chọn color scheme → `[Next]` | 🔧 **Tự động** | giữ mặc định `terminal` |
| Onboarding: Terms of Service → bỏ tick data-sharing → `[Done]` | 🔧 **Tự động** | Space (bỏ tick) → ↓ → → → Enter |
| Onboarding: "Do you trust the contents?" → `Yes` | 🔧 **Tự động** | Enter |
| Gửi prompt `Reply with OK` | 🔧 **Tự động** | khi thấy chat input (`? for shortcuts`) |
| Eligibility Check | 🔧 **Tự động** | AGY tự chạy |
| Bắt **URL #2** (verify) nếu eligibility fail | 🔧 **Tự động** | in stdout + ghi `verify-url.txt`, thoát sau khi ổn định |

## Quan trọng về PKCE (nguyên nhân 4 lần fail "Invalid code verifier")

Mỗi lần chạy `agy -i` mới, AGY sinh **PKCE verifier/challenge mới**. Google authorization
code **chỉ dùng được 1 lần** và **gắn với đúng URL của lần chạy đó**:

- Code lấy từ URL của lần chạy A **không dùng được** trong lần chạy B (kể cả khi chạy song song
  cùng lúc) → lỗi `oauth2: "invalid_grant" "Invalid code verifier."`.
- Vì vậy script **giữ session sống** và chờ bạn dán code ngay trong chính lần chạy đó.
- Đừng tái sử dụng tab/cửa sổ cũ — mở **đúng URL mới** mà script in ra (tốt nhất là incognito).

## Kết quả đầu ra (`--outdir`, mặc định `out/`)

| File | Nội dung |
|------|----------|
| `oauth-url.txt` | URL #1 nguyên bản, không cắt/không decode |
| `verify-url.txt` | URL #2 nguyên bản (nếu có) |
| `urls.txt` | mọi URL HTTP/HTTPS bắt được, de-dup giữ thứ tự |
| `agy-output.raw` | raw PTY bytes |
| `agy-output.txt` | bản đã strip ANSI |
| `status` | `oauth_url=yes/no`, `verify_url=yes/no`, lỗi nếu có |

## Các trường hợp thực tế

**1. Máy chưa login** (login menu xuất hiện):
OAuth URL → bạn dán code → login → onboarding → prompt → Eligibility Check →
**verify URL nếu tài khoản chưa eligible**; nếu eligible thì không có URL #2.

**2. Máy đã login + đã onboarded** (không có login menu):
Script vào thẳng chat → gửi prompt → Eligibility Check → bắt verify URL nếu fail.
Trên tài khoản đã verify, không có URL #2, status bar chat hiển thị nhãn
`? for shortcuts (Antigravity Starter Quota)` — **Starter quota là nhãn trong TUI,
không phải URL**.

**3. Code sai/đã dùng/không khớp**:
Script phát hiện `token exchange failed` / `Invalid code verifier`, dừng lại,
ghi lỗi vào `status`, trả về exit 0 (vì đã có OAuth URL).

## Ghi chú bảo mật

- Không hiển thị `access_token` / `refresh_token` / authorization code trong output.
- URL #2 có tham số `plt=...` (page-load token tạm của Google) do chính AGY in ra — giữ nguyên.
- ToS checkbox để **không tick** (không gửi Interactions data); bạn vẫn có thể đổi trong settings của CLI.
- `auth-code` nên được xoá sau khi dùng (code dùng 1 lần).
