---
name: ask-pro
description: Use when the user asks Codex to consult ChatGPT Pro, GPT-5.5 Pro, the web app Pro mode, or wants a high-quality second opinion from ChatGPT web rather than Codex's native model.
---

# Ask ChatGPT Pro

Use the `ask_chatgpt_pro` MCP tool when the user explicitly asks for ChatGPT Pro, GPT-5.5 Pro, the chatgpt.com Pro mode, or a Pro-mode second opinion.

Before calling the tool, make sure the user has a Chrome, Comet, or other Chromium-based browser instance running with remote debugging enabled and already logged into `https://chatgpt.com`.

Default local endpoint:

```bash
http://127.0.0.1:9222
```

Recommended browser launch pattern:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.cache/codex-chatgpt-pro-profile"
```

Comet on macOS usually follows the same Chromium flag pattern:

```bash
/Applications/Comet.app/Contents/MacOS/Comet \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/codex-chatgpt-pro-comet-profile"
```

If Codex is running on a remote machine over SSH while the browser is local, ask the user to connect with a reverse tunnel:

```bash
ssh -R 9222:127.0.0.1:9222 <remote-codex-host>
```

If the tool reports that ChatGPT is not logged in, ask the user to open that browser window and complete login and 2FA manually. Do not ask for ChatGPT cookies, passwords, OTP codes, access tokens, or session headers.

When using the tool:

- Prefer `conversation_mode: "new"` for isolated questions.
- Use `require_pro_mode: true` unless the user says best-effort is acceptable.
- Include enough context in the prompt because the web conversation is separate from the Codex thread.
- Treat the returned answer as a second opinion, not as an authoritative source for current facts unless it cites verifiable sources.
