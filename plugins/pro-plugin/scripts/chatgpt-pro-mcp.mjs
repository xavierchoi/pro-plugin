#!/usr/bin/env node

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_CDP_ENDPOINT =
  process.env.CHATGPT_PRO_CDP_ENDPOINT || "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = Number(process.env.CHATGPT_PRO_TIMEOUT_MS || 180000);
const CHATGPT_URL = process.env.CHATGPT_PRO_URL || "https://chatgpt.com/";
const DEFAULT_MAX_PROMPT_CHARS = Number(
  process.env.CHATGPT_PRO_MAX_PROMPT_CHARS || 24000,
);
const SESSION_STORE_PATH =
  process.env.CHATGPT_PRO_SESSION_STORE ||
  join(homedir(), ".cache", "pro-plugin", "sessions.json");
const DEFAULT_CDP_PORT = Number(process.env.CHATGPT_PRO_CDP_PORT || 9222);

const tools = [
  {
    name: "setup_chatgpt_pro_browser",
    description:
      "Start or verify a local Chrome/Comet browser with CDP enabled for ChatGPT Pro.",
    inputSchema: {
      type: "object",
      properties: {
        browser: {
          type: "string",
          enum: ["comet", "chrome", "auto"],
          default: "auto",
          description:
            "Browser to launch. auto prefers Comet on macOS, then Chrome/Chromium.",
        },
        cdp_port: {
          type: "integer",
          minimum: 1024,
          maximum: 65535,
          default: DEFAULT_CDP_PORT,
          description: "Local CDP port to use.",
        },
        executable_path: {
          type: "string",
          description:
            "Optional explicit browser executable path, useful when Comet is installed outside /Applications.",
        },
        profile_dir: {
          type: "string",
          description:
            "Optional browser user-data-dir. Overrides profile_mode.",
        },
        profile_mode: {
          type: "string",
          enum: ["default", "dedicated"],
          default: "default",
          description:
            "Use the existing browser profile when possible, or a dedicated pro-plugin profile. Default is default for smoother UX.",
        },
        open_url: {
          type: "string",
          default: CHATGPT_URL,
          description: "URL to open after launching the browser.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "chatgpt_pro_status",
    description:
      "Check whether the ChatGPT Pro browser bridge can reach a CDP browser endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        cdp_endpoint: {
          type: "string",
          description:
            "Chrome DevTools endpoint. Defaults to CHATGPT_PRO_CDP_ENDPOINT or http://127.0.0.1:9222.",
        },
        include_page_diagnostics: {
          type: "boolean",
          default: true,
          description:
            "When true, inspect ChatGPT tabs for composer and Pro-mode hints.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ask_chatgpt_pro",
    description:
      "Ask ChatGPT web Pro mode through a user-owned browser session connected over CDP.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The full prompt to submit to ChatGPT Pro mode.",
        },
        cdp_endpoint: {
          type: "string",
          description:
            "Chrome DevTools endpoint. Defaults to CHATGPT_PRO_CDP_ENDPOINT or http://127.0.0.1:9222.",
        },
        conversation_mode: {
          type: "string",
          enum: ["new", "current", "named"],
          default: "new",
          description:
            "Use a fresh ChatGPT conversation, continue the current visible one, or reuse a named saved ChatGPT URL.",
        },
        session_name: {
          type: "string",
          description:
            "Optional stable name for a ChatGPT web conversation. When set with conversation_mode=named, the tool reopens the saved URL when possible.",
        },
        target_model: {
          type: "string",
          default: "GPT-5.5 Pro",
          description:
            "Visible model/mode label to select in ChatGPT. Defaults to GPT-5.5 Pro.",
        },
        require_pro_mode: {
          type: "boolean",
          default: true,
          description:
            "Fail if the tool cannot confidently select a Pro mode control.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 30000,
          maximum: 1800000,
          default: DEFAULT_TIMEOUT_MS,
          description: "Maximum wait time for the web answer.",
        },
        long_prompt_strategy: {
          type: "string",
          enum: ["chunk", "fail", "truncate"],
          default: "chunk",
          description:
            "How to handle prompts longer than max_prompt_chars before the final answer request.",
        },
        max_prompt_chars: {
          type: "integer",
          minimum: 4000,
          maximum: 120000,
          default: DEFAULT_MAX_PROMPT_CHARS,
          description:
            "Character limit for a single ChatGPT composer submission before long_prompt_strategy is applied.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    writeError(null, -32700, `Invalid JSON: ${error.message}`);
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return;
  }

  try {
    const result = await dispatch(message.method, message.params || {});
    write({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeError(message.id, -32000, error.message, {
      name: error.name,
      stack: process.env.CHATGPT_PRO_DEBUG ? error.stack : undefined,
    });
  }
});

async function dispatch(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion || "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "chatgpt-pro-oracle",
        version: "0.1.0",
      },
    };
  }

  if (method === "tools/list") {
    return { tools };
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params;
    if (name === "setup_chatgpt_pro_browser") {
      return textResult(await setupBrowser(args));
    }
    if (name === "chatgpt_pro_status") {
      return textResult(await status(args));
    }
    if (name === "ask_chatgpt_pro") {
      return textResult(await askChatGptPro(args));
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  if (method === "ping") {
    return {};
  }

  throw new Error(`Unsupported MCP method: ${method}`);
}

async function setupBrowser(args) {
  const port = Number(args.cdp_port || DEFAULT_CDP_PORT);
  const endpoint = `http://127.0.0.1:${port}`;
  const openUrl = args.open_url || CHATGPT_URL;

  const existing = await probeCdp(endpoint);
  if (existing.ok) {
    return JSON.stringify(
      {
        ok: true,
        already_running: true,
        endpoint,
        browser: existing.version?.Browser || existing.version,
        next_steps: [
          "Open or focus the ChatGPT tab in the CDP-enabled browser.",
          "Complete ChatGPT login and 2FA manually if prompted.",
          "Run chatgpt_pro_status, then ask_chatgpt_pro.",
        ],
      },
      null,
      2,
    );
  }

  const selection = selectBrowserExecutable(args.browser || "auto", args.executable_path);
  if (!selection.executable) {
    return JSON.stringify(
      {
        ok: false,
        endpoint,
        checks: [
          {
            name: "browser_executable",
            ok: false,
            detail: selection.reason,
          },
        ],
        next_steps: [
          "Install Comet/Chrome or pass executable_path to setup_chatgpt_pro_browser.",
          "On macOS Comet is usually /Applications/Comet.app/Contents/MacOS/Comet.",
        ],
      },
      null,
      2,
    );
  }

  const profileMode = args.profile_mode || "default";
  const profile = resolveProfileDir(selection.kind, profileMode, args.profile_dir);
  const profileDir = profile.path;
  await mkdir(profileDir, { recursive: true });

  const launchArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    openUrl,
  ];
  const child = spawn(selection.executable, launchArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ready = await waitForCdp(endpoint, 10000);
  return JSON.stringify(
    {
      ok: ready.ok,
      launched: true,
      endpoint,
      browser: selection.kind,
      executable: selection.executable,
      profile_dir: profileDir,
      profile_mode: profile.mode,
      profile_note: profile.note,
      security_note:
        profile.mode === "default"
          ? "Default profile mode reuses your logged-in browser profile. Keep the CDP port bound to localhost and close this browser when finished."
          : "Dedicated profile mode isolates this workflow but may require separate onboarding and login.",
      pid: child.pid,
      cdp_ready: ready.ok,
      browser_version: ready.version?.Browser || ready.version || null,
      next_steps: ready.ok
        ? [
            "Complete ChatGPT login and 2FA manually in the opened browser window if prompted.",
            "Run chatgpt_pro_status to verify composer and Pro mode visibility.",
            "Then ask ChatGPT Pro from Codex.",
          ]
        : [
            "The browser process was started but CDP did not respond within 10 seconds.",
            "Check whether the browser blocked remote-debugging flags or whether another instance is reusing the profile.",
            `Try opening ${endpoint}/json/version manually.`,
          ],
    },
    null,
    2,
  );
}

async function status(args) {
  const endpoint = args.cdp_endpoint || DEFAULT_CDP_ENDPOINT;
  const diagnostics = {
    ok: false,
    endpoint,
    environment: {
      is_ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT),
      display: process.env.DISPLAY || "",
      wayland_display: process.env.WAYLAND_DISPLAY || "",
      platform: process.platform,
    },
    checks: [],
    next_steps: [],
  };

  let connection;
  try {
    connection = await connectBrowser(endpoint);
    diagnostics.checks.push({
      name: "cdp_endpoint",
      ok: true,
      detail: `Connected to ${endpoint}`,
    });

    const { browser } = connection;
    const version = await browser.version().catch(() => "");
    const pages = browser.contexts().flatMap((context) => context.pages());
    const chatgptPages = pages
      .filter((page) => page.url().includes("chatgpt.com"));

    diagnostics.browser_version = version;
    diagnostics.page_count = pages.length;
    diagnostics.chatgpt_pages = chatgptPages.map((page) => page.url());
    diagnostics.checks.push({
      name: "chatgpt_tab",
      ok: chatgptPages.length > 0,
      detail:
        chatgptPages.length > 0
          ? `Found ${chatgptPages.length} ChatGPT tab(s).`
          : "No ChatGPT tab is open yet.",
    });

    if (args.include_page_diagnostics !== false && chatgptPages[0]) {
      const page = chatgptPages[0];
      await page.bringToFront().catch(() => {});
      const composer = await findComposer(page);
      const bodyText = await visibleBodyText(page);
      const modelHints = extractModelHints(bodyText);
      diagnostics.checks.push({
        name: "chatgpt_login",
        ok: Boolean(composer),
        detail: composer
          ? "Composer is visible; ChatGPT appears logged in."
          : "Composer is not visible; login or 2FA may still be required.",
      });
      diagnostics.checks.push({
        name: "pro_mode_hint",
        ok: modelHints.some((hint) => /\bPro\b/i.test(hint)),
        detail:
          modelHints.length > 0
            ? `Visible model hints: ${modelHints.join(", ")}`
            : "No visible model/mode hints found.",
      });
      diagnostics.model_hints = modelHints;
    }

    diagnostics.ok = diagnostics.checks.every((check) => check.ok);
  } catch (error) {
    diagnostics.checks.push({
      name: "cdp_endpoint",
      ok: false,
      detail: error.message,
    });
  } finally {
    await connection?.close();
  }

  if (!diagnostics.checks.find((check) => check.name === "cdp_endpoint")?.ok) {
    diagnostics.next_steps.push(
      "Run setup_chatgpt_pro_browser to start Chrome or Comet with CDP enabled.",
    );
    if (diagnostics.environment.is_ssh) {
      diagnostics.next_steps.push(
        "If the browser is on your MacBook and Codex is remote, reconnect with: ssh -R 9222:127.0.0.1:9222 <remote-codex-host>",
      );
    }
  }

  if (
    diagnostics.checks.find((check) => check.name === "chatgpt_tab")?.ok ===
    false
  ) {
    diagnostics.next_steps.push(
      "Open https://chatgpt.com in the CDP-enabled browser.",
    );
  }

  if (
    diagnostics.checks.find((check) => check.name === "chatgpt_login")?.ok ===
    false
  ) {
    diagnostics.next_steps.push(
      "Complete ChatGPT login and 2FA manually in the browser, then retry.",
    );
  }

  return JSON.stringify(diagnostics, null, 2);
}

async function askChatGptPro(args) {
  if (!args.prompt || !args.prompt.trim()) {
    throw new Error("prompt is required");
  }

  const timeoutMs = Number(args.timeout_ms || DEFAULT_TIMEOUT_MS);
  const requireProMode = args.require_pro_mode !== false;
  const sessionName = normalizeSessionName(args.session_name);
  const conversationMode =
    args.conversation_mode || (sessionName ? "named" : "new");
  const longPromptStrategy = args.long_prompt_strategy || "chunk";
  const maxPromptChars = Number(args.max_prompt_chars || DEFAULT_MAX_PROMPT_CHARS);
  const { browser, close } = await connectBrowser(args.cdp_endpoint);

  try {
    const page = await getChatGptPage(browser, conversationMode, sessionName);
    page.setDefaultTimeout(Math.min(timeoutMs, 60000));

    const loginReady = await waitForComposer(page, timeoutMs);
    if (!loginReady) {
      throw new Error(
        "ChatGPT composer was not found. Open the connected browser, log into chatgpt.com, then retry.",
      );
    }

    const proSelection = await selectProMode(page, args.target_model || "GPT-5.5 Pro");
    if (!proSelection.selected && requireProMode) {
      throw new Error(
        `Could not confidently select Pro mode: ${proSelection.reason}. Set require_pro_mode=false for a best-effort call.`,
      );
    }

    const promptPlan = buildPromptPlan(
      args.prompt,
      maxPromptChars,
      longPromptStrategy,
    );
    let answer = "";
    for (let index = 0; index < promptPlan.messages.length; index += 1) {
      const message = promptPlan.messages[index];
      const beforeCount = await assistantMessageCount(page);
      await submitPrompt(page, message);
      const response = await waitForStableAssistantText(
        page,
        beforeCount,
        timeoutMs,
      );
      if (index === promptPlan.messages.length - 1) {
        answer = response;
      }
    }

    if (sessionName) {
      await saveNamedSession(sessionName, page.url());
    }

    return JSON.stringify(
      {
        ok: true,
        pro_mode: proSelection,
        session: sessionName
          ? { name: sessionName, url: page.url() }
          : undefined,
        prompt_plan: promptPlan.summary,
        answer,
      },
      null,
      2,
    );
  } finally {
    await close();
  }
}

async function connectBrowser(endpoint = DEFAULT_CDP_ENDPOINT) {
  let playwright;
  try {
    playwright = await import("playwright-core");
  } catch {
    throw new Error(
      "Missing dependency: run `npm install` in the pro-plugin directory so playwright-core is available.",
    );
  }

  try {
    const browser = await playwright.chromium.connectOverCDP(endpoint);
    return {
      browser,
      close: async () => {
        await browser.close().catch(() => {});
      },
    };
  } catch (error) {
    throw new Error(
      `Could not connect to Chromium CDP endpoint ${endpoint}: ${error.message}. Start Chrome or Comet with --remote-debugging-port=9222. If Codex is remote and the browser is local, connect with ssh -R 9222:127.0.0.1:9222 <remote-codex-host>.`,
    );
  }
}

async function getChatGptPage(browser, conversationMode, sessionName) {
  const context = browser.contexts()[0] || (await browser.newContext());
  const pages = context.pages();
  const existing = pages.find((page) => page.url().includes("chatgpt.com"));

  if (conversationMode === "named" && sessionName) {
    const saved = await loadNamedSession(sessionName);
    const matching = saved
      ? pages.find((page) => normalizeUrl(page.url()) === normalizeUrl(saved.url))
      : null;
    const page = matching || existing || (await context.newPage());
    await page.bringToFront();
    if (saved?.url) {
      await page.goto(saved.url, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
      await openNewChat(page);
    }
    return page;
  }

  if (conversationMode === "current" && existing) {
    await existing.bringToFront();
    return existing;
  }

  const page = existing || (await context.newPage());
  await page.bringToFront();
  await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });

  if (conversationMode === "new") {
    await openNewChat(page);
  }

  return page;
}

async function openNewChat(page) {
  const candidates = [
    '[data-testid="create-new-chat-button"]',
    'a[href="/"]',
    'button[aria-label*="New chat" i]',
    'a[aria-label*="New chat" i]',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator, 1200)) {
      await locator.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }

  if (!page.url().match(/chatgpt\.com\/?($|\?)/)) {
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
  }
}

async function waitForComposer(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = await findComposer(page);
    if (handle) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function findComposer(page) {
  const selectors = [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'div[contenteditable="true"][data-testid="prompt-textarea"]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"]',
    "textarea",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if (await isVisible(locator, 500)) {
      return locator;
    }
  }
  return null;
}

async function selectProMode(page, targetModel = "GPT-5.5 Pro") {
  const currentText = await visibleBodyText(page);
  const targetWords = targetModel
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const targetRegex = new RegExp(targetWords.join("\\s+"), "i");
  if (targetRegex.test(currentText)) {
    return {
      selected: true,
      target_model: targetModel,
      reason: `Visible page already mentions ${targetModel}.`,
    };
  }
  if (/\bPro\b/i.test(currentText) && /GPT-?5\.5/i.test(currentText)) {
    return {
      selected: true,
      target_model: targetModel,
      reason: "Visible page already mentions GPT-5.5 and Pro.",
    };
  }

  const pickerSelectors = [
    '[data-testid="model-switcher-dropdown-button"]',
    '[data-testid*="model-switcher" i]',
    'button[aria-haspopup="menu"]:has-text("GPT")',
    'button[aria-haspopup="listbox"]:has-text("GPT")',
    'button[aria-label*="model" i]',
    'button[aria-label*="ChatGPT" i]',
    'button:has-text("GPT-5.5")',
    'button:has-text("GPT")',
    'button:has-text("ChatGPT")',
  ];

  for (const selector of pickerSelectors) {
    const picker = page.locator(selector).first();
    if (!(await isVisible(picker, 1000))) continue;

    await picker.click().catch(() => {});
    await page.waitForTimeout(700);

    const option = await firstVisibleLocator(page, [
      `text=/${targetWords.join("\\\\s+")}/i`,
      'text=/GPT-?5\\.5\\s+Pro/i',
      'text=/GPT-?5\\.5.*Pro/i',
      '[role="menuitem"]:has-text("GPT-5.5")',
      '[role="option"]:has-text("GPT-5.5")',
      'text=/\\bPro\\b/i',
      '[role="menuitem"]:has-text("Pro")',
      '[role="option"]:has-text("Pro")',
      'button:has-text("Pro")',
    ]);

    if (option) {
      await option.click().catch(() => {});
      await page.waitForTimeout(1000);
      return {
        selected: true,
        target_model: targetModel,
        reason: "Clicked a visible Pro option.",
      };
    }

    await page.keyboard.press("Escape").catch(() => {});
  }

  return {
    selected: false,
    target_model: targetModel,
    reason:
      `No visible model picker option matching ${targetModel}, GPT-5.5 Pro, or Pro was found.`,
  };
}

async function submitPrompt(page, prompt) {
  const composer = await findComposer(page);
  if (!composer) {
    throw new Error("Cannot submit prompt because the ChatGPT composer is missing.");
  }

  await composer.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(300);

  const sendButton = await firstVisibleLocator(page, [
    '[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button:has(svg)',
  ]);

  if (sendButton) {
    await sendButton.click();
  } else {
    await page.keyboard.press("Enter");
  }
}

async function waitForStableAssistantText(page, beforeCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stableSamples = 0;

  while (Date.now() < deadline) {
    const count = await assistantMessageCount(page);
    const text = await lastAssistantText(page);

    if (count > beforeCount && text.trim().length > 0) {
      if (text === lastText) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
        lastText = text;
      }

      if (stableSamples >= 4 && !(await responseStillRunning(page))) {
        return text.trim();
      }
    }

    await page.waitForTimeout(1500);
  }

  if (lastText.trim()) {
    return lastText.trim();
  }

  throw new Error("Timed out waiting for a ChatGPT response.");
}

async function assistantMessageCount(page) {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
    return nodes.length;
  });
}

async function lastAssistantText(page) {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]'),
    );
    const node = candidates.at(-1);
    return node?.innerText || "";
  });
}

async function responseStillRunning(page) {
  return page.evaluate(() => {
    const labels = [
      "Stop streaming",
      "Stop generating",
      "Cancel",
    ];
    return labels.some((label) =>
      Array.from(document.querySelectorAll("button")).some((button) =>
        (button.getAttribute("aria-label") || button.innerText || "")
          .toLowerCase()
          .includes(label.toLowerCase()),
      ),
    );
  });
}

async function visibleBodyText(page) {
  return page.evaluate(() => document.body?.innerText || "").catch(() => "");
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator, 1000)) {
      return locator;
    }
  }
  return null;
}

function buildPromptPlan(prompt, maxPromptChars, strategy) {
  if (prompt.length <= maxPromptChars) {
    return {
      messages: [prompt],
      summary: {
        strategy: "single",
        original_chars: prompt.length,
        message_count: 1,
      },
    };
  }

  if (strategy === "fail") {
    throw new Error(
      `Prompt is ${prompt.length} characters, above max_prompt_chars=${maxPromptChars}. Use long_prompt_strategy=chunk or truncate.`,
    );
  }

  if (strategy === "truncate") {
    const truncated = prompt.slice(0, maxPromptChars);
    return {
      messages: [
        `${truncated}\n\n[Truncated by pro-plugin from ${prompt.length} to ${maxPromptChars} characters.]`,
      ],
      summary: {
        strategy: "truncate",
        original_chars: prompt.length,
        sent_chars: truncated.length,
        message_count: 1,
      },
    };
  }

  const chunkSize = Math.max(4000, maxPromptChars - 1200);
  const chunks = splitText(prompt, chunkSize);
  const messages = chunks.map(
    (chunk, index) =>
      `Context part ${index + 1}/${chunks.length}. Store this context for the final request. Reply only: ACK PART ${index + 1}/${chunks.length}.\n\n${chunk}`,
  );
  messages.push(
    "All context parts have been sent. Now answer the user's request using the complete context above. Be direct, preserve important caveats, and do not mention the chunking unless it affects the answer.",
  );
  return {
    messages,
    summary: {
      strategy: "chunk",
      original_chars: prompt.length,
      chunk_count: chunks.length,
      message_count: messages.length,
      chunk_size: chunkSize,
    },
  };
}

function splitText(text, chunkSize) {
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + chunkSize);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n\n", end),
        text.lastIndexOf("\n", end),
        text.lastIndexOf(". ", end),
      );
      if (boundary > offset + chunkSize * 0.6) {
        end = boundary + 1;
      }
    }
    chunks.push(text.slice(offset, end).trim());
    offset = end;
  }
  return chunks.filter(Boolean);
}

function extractModelHints(text) {
  const hints = new Set();
  for (const match of text.matchAll(/(?:GPT-?5\.5|GPT-?5|ChatGPT)\s*(?:Pro|Thinking|Instant)?/gi)) {
    hints.add(match[0].trim());
  }
  for (const match of text.matchAll(/\b(?:Pro|Thinking|Instant)\b/g)) {
    hints.add(match[0].trim());
  }
  return Array.from(hints).slice(0, 12);
}

function normalizeSessionName(name) {
  if (!name) return "";
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function loadSessionStore() {
  try {
    return JSON.parse(await readFile(SESSION_STORE_PATH, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

async function loadNamedSession(name) {
  const store = await loadSessionStore();
  return store.sessions?.[name] || null;
}

async function saveNamedSession(name, url) {
  const store = await loadSessionStore();
  store.sessions ||= {};
  store.sessions[name] = {
    url,
    updated_at: new Date().toISOString(),
  };
  await mkdir(dirname(SESSION_STORE_PATH), { recursive: true });
  await writeFile(SESSION_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function selectBrowserExecutable(browser, explicitPath) {
  if (explicitPath) {
    return existsSync(explicitPath)
      ? { kind: browser === "auto" ? "custom" : browser, executable: explicitPath }
      : { kind: browser, executable: "", reason: `Path does not exist: ${explicitPath}` };
  }

  const candidates = [];
  if (process.platform === "darwin") {
    if (browser === "auto" || browser === "comet") {
      candidates.push({
        kind: "comet",
        path: "/Applications/Comet.app/Contents/MacOS/Comet",
      });
    }
    if (browser === "auto" || browser === "chrome") {
      candidates.push({
        kind: "chrome",
        path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });
      candidates.push({
        kind: "chrome",
        path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      });
    }
  } else {
    if (browser === "auto" || browser === "comet") {
      candidates.push({ kind: "comet", path: "comet" });
      candidates.push({ kind: "comet", path: "Comet" });
    }
    if (browser === "auto" || browser === "chrome") {
      candidates.push({ kind: "chrome", path: "google-chrome" });
      candidates.push({ kind: "chrome", path: "chromium" });
      candidates.push({ kind: "chrome", path: "chromium-browser" });
    }
  }

  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate.path);
    if (resolved) {
      return { kind: candidate.kind, executable: resolved };
    }
  }

  return {
    kind: browser,
    executable: "",
    reason: `No ${browser} browser executable was found. Checked: ${candidates
      .map((candidate) => candidate.path)
      .join(", ")}`,
  };
}

function resolveExecutable(commandOrPath) {
  if (commandOrPath.includes("/") && existsSync(commandOrPath)) {
    return commandOrPath;
  }
  const pathEntries = (process.env.PATH || "").split(":").filter(Boolean);
  for (const entry of pathEntries) {
    const fullPath = join(entry, commandOrPath);
    if (existsSync(fullPath)) return fullPath;
  }
  return "";
}

function resolveProfileDir(kind, mode, explicitPath) {
  if (explicitPath) {
    return {
      mode: "explicit",
      path: explicitPath,
      note: "Using explicit profile_dir from tool arguments.",
    };
  }

  if (mode === "default") {
    const defaultPath = findDefaultProfileDir(kind);
    if (defaultPath) {
      return {
        mode: "default",
        path: defaultPath,
        note: "Using an existing browser profile so ChatGPT login/onboarding is reused.",
      };
    }
  }

  return {
    mode: "dedicated",
    path: join(
      homedir(),
      ".cache",
      kind === "comet"
        ? "codex-chatgpt-pro-comet-profile"
        : "codex-chatgpt-pro-browser-profile",
    ),
    note:
      mode === "default"
        ? "Could not find an existing browser profile, so a dedicated pro-plugin profile is used."
        : "Using a dedicated pro-plugin browser profile.",
  };
}

function findDefaultProfileDir(kind) {
  const home = homedir();
  const candidates = [];

  if (process.platform === "darwin") {
    if (kind === "comet") {
      candidates.push(
        join(home, "Library", "Application Support", "Comet"),
        join(home, "Library", "Application Support", "Perplexity", "Comet"),
        join(home, "Library", "Application Support", "Perplexity Comet"),
        join(home, "Library", "Application Support", "com.perplexity.comet"),
      );
    }
    if (kind === "chrome" || kind === "custom") {
      candidates.push(
        join(home, "Library", "Application Support", "Google", "Chrome"),
        join(home, "Library", "Application Support", "Chromium"),
      );
    }
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    if (kind === "comet") {
      candidates.push(
        join(localAppData, "Comet", "User Data"),
        join(localAppData, "Perplexity", "Comet", "User Data"),
      );
    }
    if (kind === "chrome" || kind === "custom") {
      candidates.push(
        join(localAppData, "Google", "Chrome", "User Data"),
        join(localAppData, "Chromium", "User Data"),
      );
    }
  } else {
    if (kind === "comet") {
      candidates.push(
        join(home, ".config", "Comet"),
        join(home, ".config", "comet"),
        join(home, ".config", "perplexity-comet"),
      );
    }
    if (kind === "chrome" || kind === "custom") {
      candidates.push(
        join(home, ".config", "google-chrome"),
        join(home, ".config", "chromium"),
      );
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function waitForCdp(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probeCdp(endpoint);
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last || { ok: false };
}

async function probeCdp(endpoint) {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`);
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return { ok: true, version: await response.json() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function isVisible(locator, timeout) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

function textResult(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeError(id, code, message, data) {
  write({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  });
}
