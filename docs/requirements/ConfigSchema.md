# ConfigSchema

# Config Schema v6 - Inline Provider Credentials
> Bản này thay thế phần credentials của v5. Chỉ đặc tả requirement, chưa code.
## 1\. Quy tắc cấu hình
Config gồm hai phần chính:
*   `src`: chỉ chứa credentials dùng để truy cập các source repo.
*   `dest`: chứa nhiều provider đích. **Credential của destination nằm trực tiếp bên trong từng provider**, không có block `credentials` dùng chung bên ngoài.

URL source, repo source và thông tin hook lấy từ data hook lưu trên RTDB.
## 2\. Schema chính

```jsonc
{
  "src": {
    "creds": {
      "github": {
        "type": "github",
        "token": "${SOURCE_GITHUB_PAT}"
      },
      "gitea": {
        "type": "gitea",
        "token": "${SOURCE_GITEA_PAT}"
      },
      "azure": {
        "type": "azure",
        "token": "${SOURCE_AZURE_PAT}"
      }
    }
  },
  "dest": {
    "github-main": {
      "type": "github",
      "mode": "one-to-one",
      "creds": {
        "type": "github",
        "token": "${DEST_GITHUB_PAT}"
      },
      "org": "mirror-org",
      "repo": "{sourceRepo}"
    },
    "gitea-main": {
      "type": "gitea",
      "mode": "many-to-one",
      "creds": {
        "type": "gitea",
        "token": "${DEST_GITEA_PAT}"
      },
      "org": "mirror-team",
      "repo": "monorepo"
    },
    "azure-main": {
      "type": "azure",
      "mode": "one-to-one",
      "creds": {
        "type": "azure",
        "token": "${DEST_AZURE_PAT}"
      },
      "org": "acme",
      "project": "platform",
      "repo": "{sourceRepo}"
    }
  }
}
```

## 3\. Quy tắc credential
*   `src.creds` là credential nguồn, được chọn theo provider trong hook data.
*   `dest.<provider>.creds` là credential riêng của provider đích đó.
*   Không có block `credentials` cấp root cho destination.
*   Hai provider đích khác nhau có thể dùng token khác nhau, dù cùng `type`.
*   Token có thể tham chiếu environment variable bằng `${NAME}`.
*   Token không được ghi vào URL, `.git/config`, log hoặc error message.
*   Credential object có thể mở rộng cho `scheme`, `username`, `headerName`, `headerValueTemplate` theo từng provider.
## 4\. Quy tắc destination provider
Mỗi entry trong `dest` bắt buộc có:
*   `type`
*   `mode`: `one-to-one` hoặc `many-to-one`
*   `creds`
*   `org`
*   `repo`

Azure DevOps bắt buộc thêm `project`. Các provider khác có thể có trường bắt buộc riêng theo adapter.
### One-to-one
*   `repo` là repo đích, hỗ trợ placeholder `{sourceRepo}`.
*   Listener kiểm tra repo; nếu thiếu thì tạo bằng chính `dest.<provider>.creds`, sau đó push lại.
*   Trạng thái tồn tại/tạo repo lưu trên RTDB để tránh gọi create thừa.
*   Đồng bộ full branch, tag, ref và lịch sử.
### Many-to-one
*   `repo` là repo đích duy nhất.
*   Tên thư mục con lấy từ source repo hoặc quy tắc mapping mở rộng.
*   Nội dung source phải khớp hoàn toàn thư mục con: thêm, sửa và xoá file.
*   Không dùng `--mirror`.
*   Push tuần tự theo lock đích.
*   Commit có source repo, source SHA, directory, prefix, user và email.
## 5\. Luồng xử lý
1. Listener đọc hook event.
2. Lấy `provider`, `repo`, `url`, `ref`, `after` từ hook data.
3. Chọn source credential trong `src.creds`.
4. Clone hoặc fetch source bằng credential nguồn.
5. Duyệt từng provider trong `dest`.
6. Gọi API đích bằng `dest.<provider>.creds`.
7. Tạo repo nếu cần, sync theo mode, push và ghi kết quả RTDB.
## 6\. Validate và script
*   `repo:check`: kiểm tra credential source, credential từng destination provider, org, project, repo và quyền API; không tạo repo.
*   `repo:init`: dùng credential inline của từng destination provider để tạo repo thiếu, lưu URL/ID/trạng thái vào RTDB; chạy lại không tạo trùng.
*   Schema reject nếu destination provider thiếu `creds`, `org` hoặc `repo`; Azure thiếu `project` cũng reject.
## 7\. Acceptance criteria
*   Không còn `credentials` block cấp root cho destination.
*   `src` chỉ giữ source credentials.
*   Mỗi `dest` provider tự chứa credential riêng.
*   Hai Gitea provider có thể dùng hai token khác nhau.
*   Listener và `repo:init` dùng đúng credential của provider đang xử lý.
*   Secret không lộ trong URL, log hoặc `.git/config`.