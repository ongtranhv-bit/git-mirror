#!/usr/bin/env python3
"""Drive `agy` through a real PTY to capture the two web-app auth URLs:

  1. Google OAuth authorization URL (accounts.google.com/o/oauth2/auth?...)
  2. Account eligibility / verification URL (accounts.google.com/signin/continue?...)

Only one step is manual: pasting the Google authorization code into the script.
Everything else (login-method selection, onboarding screens, prompt submission,
URL extraction) is automated by this script via PTY key events.

Usage:
    python3 agy_oauth_flow.py [--code-file PATH] [--outdir DIR] [--timeout SECONDS]

Example:
    python3 agy_oauth_flow.py --outdir ./out
"""
import argparse
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

URL_RE = re.compile(rb"(?i)\bhttps?://[^\s\x1b\x07<>\"'{}|\\^`\x00-\x1f]+")


def strip_ansi(data: bytes) -> str:
    text = data.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][A-Z0-9]", "", text)
    text = re.sub(r"\x1b[@-Z\\-_]", "", text)
    text = re.sub(r"\x1b[=>]", "", text)
    return text


def clean_url(u: bytes) -> bytes:
    open_p = u.count(b"(")
    close_p = u.count(b")")
    while u:
        last = u[-1:]
        if last in b")];.,:>\"'}" :
            if last == b")" and open_p >= close_p:
                break
            u = u[:-1]
        else:
            break
    return u


def collect_urls(blob: bytes) -> list:
    out = []
    for m in URL_RE.finditer(blob):
        u = clean_url(m.group(0))
        if u not in out:
            out.append(u)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code-file", default=None,
                    help="File containing the Google authorization code (one line). "
                         "If omitted, the script prompts on stdin when the CLI asks for it.")
    ap.add_argument("--outdir", default="out",
                    help="Directory for the captured artifacts (default: out/)")
    ap.add_argument("--timeout", type=int, default=420,
                    help="Overall timeout in seconds (default: 420)")
    ap.add_argument("--prompt", default="Reply with OK",
                    help="Prompt sent to agy (default: 'Reply with OK')")
    ap.add_argument("--agy-binary", default=None,
                    help="Path to the agy binary (default: ~/.local/bin/agy)")
    args = ap.parse_args()

    agy = args.agy_binary or os.path.expanduser("~/.local/bin/agy")
    if not os.path.exists(agy):
        sys.exit("agy binary not found at %s. Install it first:\n"
                 "  curl -fsSL https://antigravity.google/cli/install.sh | bash" % agy)

    os.makedirs(args.outdir, exist_ok=True)
    cols, rows = 2000, 60
    deadline = time.time() + args.timeout

    # ---- spawn agy on a real PTY -------------------------------------------
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        env["PATH"] = os.path.dirname(agy) + ":" + env.get("PATH", "")
        os.execvpe(agy, [agy, "-i", args.prompt], env)
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    raw = bytearray()
    urls = []
    oauth_url = None
    verify_url = None
    start = time.time()

    # ---- flow state --------------------------------------------------------
    menu_done = False
    login_needed = False
    code_prompt_seen = None
    code_sent = False
    theme_done = False
    tos_done = False
    trust_done = False
    chat_ready = False
    prompt_sent = False
    prompt_sent_at = None
    verify_seen = False
    error_seen = None
    settle_from = None

    def send(b):
        try:
            os.write(fd, b)
        except OSError:
            pass

    def note(text):
        sys.stdout.write("[AUTO] %s\n" % text)
        sys.stdout.flush()

    def save():
        txt = strip_ansi(bytes(raw))
        with open(os.path.join(args.outdir, "agy-output.raw"), "wb") as f:
            f.write(bytes(raw))
        with open(os.path.join(args.outdir, "agy-output.txt"), "w") as f:
            f.write(txt)
        with open(os.path.join(args.outdir, "urls.txt"), "w") as f:
            for u in urls:
                f.write(u.decode("utf-8", "replace") + "\n")
        if oauth_url:
            with open(os.path.join(args.outdir, "oauth-url.txt"), "w") as f:
                f.write(oauth_url.decode("utf-8", "replace") + "\n")
        if verify_url:
            with open(os.path.join(args.outdir, "verify-url.txt"), "w") as f:
                f.write(verify_url.decode("utf-8", "replace") + "\n")
        with open(os.path.join(args.outdir, "status"), "w") as f:
            f.write("oauth_url=%s\nverify_url=%s\nerror=%s\n" % (
                "yes" if oauth_url else "no",
                "yes" if verify_url else "no",
                error_seen or ""))

    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                data = os.read(fd, 16384)
            except OSError:
                break
            if not data:
                break
            raw += data

            # minimal terminal capability replies (safe; none are mandatory)
            reply = b""
            if b"\x1b[c" in data:
                reply += b"\x1b[?62;1;6c"
            if b"\x1b[>c" in data:
                reply += b"\x1b[>0;0;0c"
            if b"\x1b[6n" in data:
                reply += b"\x1b[1;1R"
            if b"\x1b[>q" in data:
                reply += b"\x1b[>0;1.1.11;0c"
            for mode in re.findall(rb"\x1b\[\?([0-9;]+)\$p", data):
                reply += b"\x1b[?" + mode + b";2$y"
            if b"\x1b[?u" in data:
                reply += b"\x1b[?u;1$y"
            if b"\x1b[=u" in data:
                reply += b"\x1b[=u;1;0$y"
            if reply:
                send(reply)

            # capture URLs as they stream in
            for u in collect_urls(data):
                if u not in urls:
                    urls.append(u)
                if oauth_url is None and b"accounts.google.com/o/oauth2/auth" in u:
                    oauth_url = u
                    note("OAuth authorization URL captured.")
                    sys.stdout.write("\nOAuth URL:\n%s\n\n" % oauth_url.decode("utf-8", "replace"))
                    sys.stdout.flush()
                if verify_url is None and b"accounts.google.com/signin/continue" in u:
                    verify_url = u
                    verify_seen = True
                    note("Eligibility / verification URL captured.")
                    sys.stdout.write("\nVerify URL:\n%s\n\n" % verify_url.decode("utf-8", "replace"))
                    sys.stdout.flush()

        txt = strip_ansi(bytes(raw))
        low = txt.lower()

        # 1) select Google OAuth (default) when the login menu appears
        if not menu_done and ("select login method" in low or "select a login method" in low):
            if "google oauth" in low:
                login_needed = True
                time.sleep(0.6)
                send(b"\r")
                menu_done = True
                note("Selected '1. Google OAuth' in the login-method menu.")

        # 2) wait for the authorization-code input, then paste the code
        if oauth_url and not code_sent and "authorization code" in low:
            if code_prompt_seen is None:
                code_prompt_seen = time.time()
                if not args.code_file:
                    sys.stdout.write(
                        "[MANUAL] Open the OAuth URL above in your browser, sign in, and copy the\n"
                        "         authorization code shown afterwards. Paste it below and press Enter.\n"
                        "         (Alternatively re-run with --code-file PATH.)\n\n> ")
                    sys.stdout.flush()
            if time.time() - code_prompt_seen > 1.5:
                code = None
                if args.code_file and os.path.exists(args.code_file):
                    with open(args.code_file) as f:
                        code = f.read().strip().encode()
                elif code_prompt_seen is not None:
                    code = sys.stdin.readline().strip().encode()
                if code:
                    send(code + b"\r")
                    code_sent = True
                    note("Authorization code submitted.")
                else:
                    error_seen = "no code provided"
                    break

        # 3) onboarding: theme picker
        if (code_sent or not login_needed) and not theme_done and ("choose your color scheme" in low or "color scheme" in low):
            time.sleep(0.6)
            send(b"\r")
            theme_done = True
            note("Onboarding 'color scheme' confirmed (kept default 'terminal').")

        # 4) onboarding: Terms of Service — untick data-sharing, then Done
        if (code_sent or not login_needed) and not tos_done and "terms of service" in low:
            time.sleep(0.6)
            send(b" ")          # untick the interactions-data checkbox
            time.sleep(0.3)
            send(b"\x1b[B")     # focus Previous
            time.sleep(0.2)
            send(b"\x1b[C")     # focus Done
            time.sleep(0.2)
            send(b"\r")         # confirm Done
            tos_done = True
            note("Terms of Service accepted (data-sharing checkbox left unticked).")

        # 5) onboarding: workspace trust
        if (code_sent or not login_needed) and not trust_done and "do you trust the contents" in low:
            time.sleep(0.5)
            send(b"\r")         # 'Yes, I trust this folder'
            trust_done = True
            note("Workspace trust accepted ('Yes, I trust this folder').")

        # 6) submit the prompt once the chat input screen is ready
        if not prompt_sent and "? for shortcuts" in low:
            if chat_ready is False:
                chat_ready = time.time()
            if login_needed:
                submit_when = theme_done and tos_done and trust_done
            else:
                submit_when = True
            if submit_when and time.time() - chat_ready > 1.5:
                send(b"\r")
                prompt_sent = True
                prompt_sent_at = time.time()
                note("Prompt submitted: %r" % args.prompt)

        # 7) eligibility / verification detection
        if verify_seen and settle_from is None:
            settle_from = time.time()
        if verify_seen and settle_from is not None and time.time() - settle_from > 5:
            save()
            break

        # 8) hard errors
        if "invalid code verifier" in low or "token exchange failed" in low or "invalid_grant" in low:
            error_seen = "token exchange failed (bad/invalid authorization code)"
            note("ERROR: %s" % error_seen)
            save()
            break

        # 9) give the model call a grace period, then stop if no verify URL appeared
        if prompt_sent and not verify_seen and time.time() - prompt_sent_at > 45:
            break

    save()
    try:
        os.kill(pid, 15)
    except OSError:
        pass

    # ---- final summary ------------------------------------------------------
    print("=== DONE ===")
    print("Artifacts written to: %s/" % args.outdir)
    print("OAuth URL: %s" % (oauth_url.decode("utf-8", "replace") if oauth_url else "NOT FOUND"))
    print("Verify URL: %s" % (verify_url.decode("utf-8", "replace") if verify_url else "NOT FOUND"))
    if error_seen:
        print("Error: %s" % error_seen)
    # exit 0 if we captured at least the OAuth authorization URL
    return 0 if oauth_url else 1


if __name__ == "__main__":
    sys.exit(main())
