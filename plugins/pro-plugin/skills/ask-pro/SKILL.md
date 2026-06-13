---
name: ask-pro
description: Use when the user asks Codex to consult ChatGPT Pro, GPT-5.5 Pro, the web app Pro mode, or wants a high-quality second opinion from ChatGPT web rather than Codex's native model.
---

# Ask ChatGPT Pro

Use the `ask_chatgpt_pro` MCP tool when the user explicitly asks for ChatGPT Pro, GPT-5.5 Pro, the chatgpt.com Pro mode, or a Pro-mode second opinion.

Before calling `ask_chatgpt_pro`, make sure the user has a Chrome, Comet, or other Chromium-based browser instance running with remote debugging enabled and already logged into `https://chatgpt.com`.

If the user asks to set up the browser, connect ChatGPT Pro, prepare Comet, or otherwise wants the setup handled inside Codex, call `setup_chatgpt_pro_browser` first. Use the default profile mode unless the user asks for an isolated profile; the default mode tries to reuse the user's existing Comet/Chrome profile so onboarding and ChatGPT login carry over.

If default-profile Comet launches but CDP is not ready, do not immediately switch to a dedicated profile. First call `install_comet_cdp_launchagent` so future Comet launches use the existing profile with `--remote-debugging-port`. If Comet was already running, explain that Chromium cannot add CDP to an already-running profile; the user may need to quit and reopen Comet once, or wait for the next login. If the user wants Codex to handle that restart, call `restart_comet_cdp_launchagent`, which gracefully asks macOS to quit Comet and then kickstarts the installed LaunchAgent. Use a dedicated profile only when the user accepts separate onboarding/login or needs an immediate isolated fallback.

After the browser is reachable, tell the user to complete ChatGPT login and 2FA in that browser window if prompted, then call `chatgpt_pro_status`.

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

For a smoother macOS Comet setup with the user's existing profile, prefer the `install_comet_cdp_launchagent` tool over asking the user to edit shell scripts. It installs a per-user LaunchAgent that starts Comet with CDP enabled on future launches.

If Codex is running on a remote machine over SSH while the browser is local, ask the user to connect with a reverse tunnel:

```bash
ssh -R 9222:127.0.0.1:9222 <remote-codex-host>
```

If the tool reports that ChatGPT is not logged in, ask the user to open that browser window and complete login and 2FA manually. Do not ask for ChatGPT cookies, passwords, OTP codes, access tokens, or session headers.

When using the tool:

- Prefer `setup_chatgpt_pro_browser` over asking the user to run shell commands manually.
- If existing-profile Comet does not expose CDP, call `install_comet_cdp_launchagent` before falling back to `profile_mode: "dedicated"`.
- If LaunchAgent is installed but Comet still opened without CDP, use `restart_comet_cdp_launchagent` when the user has agreed that Codex may quit and reopen Comet.
- Call `chatgpt_pro_status` before the first Pro request in a new Codex thread.
- Prefer `conversation_mode: "new"` for isolated questions.
- Use `session_name` with `conversation_mode: "named"` for a deliberate multi-turn Pro-mode review thread.
- Use `require_pro_mode: true` unless the user says best-effort is acceptable.
- Keep `long_prompt_strategy: "chunk"` for large diffs or logs unless the user explicitly wants fail-fast behavior.
- Include enough context in the prompt because the web conversation is separate from the Codex thread.
- Treat the returned answer as a second opinion, not as an authoritative source for current facts unless it cites verifiable sources.
- Do not kill the running MCP server process from the same Codex thread to force a plugin reload. If plugin code was upgraded, ask the user to start a new Codex thread or reinstall/upgrade the plugin outside the active tool call path.

When reporting a Pro consultation, use this structure:

1. `ChatGPT Pro`: summarize or quote the returned answer.
2. `Codex assessment`: say where you agree, disagree, or see gaps.
3. `Recommendation`: give the actionable conclusion for the user.

For setup issues, call `chatgpt_pro_status` first and relay its `next_steps` instead of guessing.
