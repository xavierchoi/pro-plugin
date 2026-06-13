# ChatGPT Pro Oracle for Codex

This plugin adds a local MCP tool that lets Codex ask the ChatGPT web app in Pro mode through a browser session you control.

It does not read or store ChatGPT credentials. It connects to Chrome or Chromium through the Chrome DevTools Protocol, so you log in manually in the browser and the plugin only automates the visible web UI.

## Install dependencies

```bash
npm install
```

## Start a browser session

Use a dedicated profile so remote debugging is scoped to this workflow:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.cache/codex-chatgpt-pro-profile"
```

Then open `https://chatgpt.com` in that browser and log in. Select or make available GPT-5.5 Pro in the UI.

### Comet

Comet is Chromium-based, so the same CDP approach should work when Comet accepts Chromium flags. Start Comet with a dedicated debugging profile and the same port:

```bash
/Applications/Comet.app/Contents/MacOS/Comet \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/codex-chatgpt-pro-comet-profile"
```

If the executable path differs, inspect the app bundle or start Comet from a terminal with the equivalent `--remote-debugging-port=9222` and `--user-data-dir=...` flags.

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

- `chatgpt_pro_status`: checks that the CDP endpoint is reachable and whether a ChatGPT tab is visible.
- `ask_chatgpt_pro`: opens ChatGPT, tries to select Pro mode, submits a prompt, waits for the answer to stabilize, and returns the final text.

## Notes

This is a browser automation bridge, not a native Codex model provider. It is intentionally heuristic because chatgpt.com UI labels and DOM structure can change.
