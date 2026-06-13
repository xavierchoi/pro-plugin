# ChatGPT Pro Oracle for Codex

This plugin adds a local MCP tool that lets Codex ask the ChatGPT web app in Pro mode through a browser session you control.

It does not read or store ChatGPT credentials. It connects to Chrome or Chromium through the Chrome DevTools Protocol, so you log in manually in the browser and the plugin only automates the visible web UI.

## Dependencies

The MCP server will try to install its Node dependency (`playwright-core`) automatically the first time a browser connection is checked. For local development, you can still run `npm install` manually in this plugin directory.

## Start a browser session from Codex

In a Codex thread, ask:

```text
ChatGPT Pro browser setup을 해줘.
```

Codex should call `setup_chatgpt_pro_browser`, which starts Comet or Chrome with CDP enabled and opens ChatGPT. If a CDP browser is already running, the tool focuses an existing ChatGPT/OpenAI auth tab or opens one through CDP instead of asking you to do it manually. By default it tries to reuse your existing browser profile so ChatGPT login and Comet onboarding are preserved. Complete login and 2FA manually in the browser window if prompted, then ask Codex to check status.

If Comet is already running with your normal profile, Chromium may reuse the existing process and ignore newly supplied CDP flags. In that case, ask Codex:

```text
Comet 기본 프로필로 ChatGPT Pro CDP LaunchAgent 설치해줘.
```

Codex should call `install_comet_cdp_launchagent`. This installs a per-user macOS LaunchAgent that starts Comet with `--remote-debugging-port=9222` using your existing Comet profile. You may need to quit and reopen Comet once after installation; future launches should keep the normal profile and expose CDP. If you want Codex to perform the restart, ask it to restart Comet through the installed LaunchAgent.

## Manual browser session

To use a separate profile so remote debugging is scoped to this workflow:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.cache/codex-chatgpt-pro-profile"
```

Then open `https://chatgpt.com` in that browser and log in. Select or make available GPT-5.5 Pro in the UI.

### Comet

Comet is Chromium-based, so the same CDP approach should work when Comet accepts Chromium flags. On macOS, the bundled launcher is the easiest path:

```bash
npm run start:comet
```

Or start Comet directly with a dedicated debugging profile and the same port:

```bash
/Applications/Comet.app/Contents/MacOS/Comet \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/codex-chatgpt-pro-comet-profile"
```

If the executable path differs, inspect the app bundle or start Comet from a terminal with the equivalent `--remote-debugging-port=9222` and `--user-data-dir=...` flags.

If you prefer the isolated profile from inside Codex, ask Codex to call setup with `profile_mode: "dedicated"`. The smoother default is `profile_mode: "default"`, which reuses the existing Comet or Chrome profile when the plugin can find it.

The dedicated profile is useful as an immediate fallback, but it will have separate Comet onboarding and ChatGPT login state.

### macOS Comet LaunchAgent

The plugin can install this from inside Codex through `install_comet_cdp_launchagent`. It writes:

```text
~/Library/LaunchAgents/com.codex.pro-plugin.comet-cdp.plist
```

The LaunchAgent uses your existing Comet profile and keeps CDP bound to `127.0.0.1`. If Comet was already open before installation, quit and reopen Comet once. Chromium cannot enable remote debugging on an already-running browser profile.

Codex can also call `restart_comet_cdp_launchagent` after the LaunchAgent is installed. That tool asks macOS to quit Comet gracefully and then kickstarts the LaunchAgent, which is useful when reopening Comet from the Dock still starts the normal app path.

### Remote Codex Sessions

The plugin runs where Codex runs. If Codex is connected to a remote Linux host over SSH but Comet is running on your laptop or desktop, `127.0.0.1:9222` on the remote host will not see your local browser. Use an SSH reverse tunnel:

```bash
ssh -R 9222:127.0.0.1:9222 <remote-codex-host>
```

Then the remote Codex plugin can keep using `http://127.0.0.1:9222`.

Do not expose the debugging port to an untrusted network. CDP can control the browser, including pages where you are logged in.

### 2FA

2FA is handled manually in the browser. Start the CDP-enabled browser, open `https://chatgpt.com`, complete login and 2FA yourself, then run the Codex tool. The plugin never asks for passwords, OTP codes, cookies, access tokens, or session headers.

## Tools

- `setup_chatgpt_pro_browser`: starts or verifies a local Comet/Chrome CDP browser and opens ChatGPT.
- `chatgpt_pro_status`: checks CDP reachability, SSH/tunnel hints, ChatGPT tab or OpenAI auth visibility, login/composer state, and visible model hints.
- `install_comet_cdp_launchagent`: installs a macOS per-user LaunchAgent so Comet starts with CDP enabled while reusing the existing profile.
- `restart_comet_cdp_launchagent`: gracefully quits Comet and kickstarts the installed LaunchAgent so Comet reopens with CDP enabled.
- `ask_chatgpt_pro`: opens ChatGPT, tries to select Pro mode, submits a prompt, waits for the answer to stabilize, and returns the final text. It uses a mode-selection adapter: `auto` first tries strict DOM/coordinate selection of a short Pro leaf row, verifies that Pro is actually selected, then falls back to the legacy DOM strategy.
- `read_chatgpt_pro_response`: reads or waits for the latest assistant response in the current/named ChatGPT conversation without submitting a new prompt. This tool is read-only: it does not create a new ChatGPT tab or navigate to a saved session URL.

Useful `ask_chatgpt_pro` options:

- `target_model`: visible label to select, default `GPT-5.5 Pro`; the selector treats Pro as a mode/effort choice because ChatGPT may expose Pro separately from the model name.
- `mode_selection_strategy`: `auto`, `strict-dom`, `legacy-dom`, or `skip`; default `auto`. Use `skip` only when you have manually selected Pro in the browser and want the tool to submit without changing the menu.
- `session_name`: saves and reuses a ChatGPT conversation URL for follow-up questions.
- `conversation_mode`: `new`, `current`, or `named`.
- `long_prompt_strategy`: `chunk`, `fail`, or `truncate`; default `chunk`.
- `max_prompt_chars`: single-message character budget before chunking.

`ask_chatgpt_pro` returns `answer_status` and `response`. Possible statuses include `complete`, `streaming`, and `timeout_partial`. If a response is still streaming or Codex was interrupted, use `read_chatgpt_pro_response` instead of sending a "continue" prompt; this avoids polluting the ChatGPT conversation while the original answer is still being generated. For chunked prompts, the tool stops before sending the next chunk if the previous chunk has not completed cleanly.

Recommended result format in Codex:

1. ChatGPT Pro answer
2. Codex assessment
3. Final recommendation

## Notes

This is a browser automation bridge, not a native Codex model provider. It is intentionally heuristic because chatgpt.com UI labels and DOM structure can change.

The mode-selection path is intentionally isolated behind `mode_selection_strategy` so a future Browser Agent sidecar, such as Playwright MCP, Stagehand, or browser-use, can replace only the selection adapter without changing prompt submission and response collection.

Do not kill the active MCP server process from the same Codex thread to force plugin reloads; that can close the tool transport. Upgrade or reinstall the plugin, then start a new Codex thread.
