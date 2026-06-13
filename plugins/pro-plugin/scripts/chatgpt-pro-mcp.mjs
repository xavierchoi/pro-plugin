#!/usr/bin/env node

import { createInterface } from "node:readline";

const DEFAULT_CDP_ENDPOINT =
  process.env.CHATGPT_PRO_CDP_ENDPOINT || "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = Number(process.env.CHATGPT_PRO_TIMEOUT_MS || 180000);
const CHATGPT_URL = process.env.CHATGPT_PRO_URL || "https://chatgpt.com/";

const tools = [
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
          enum: ["new", "current"],
          default: "new",
          description:
            "Use a fresh ChatGPT conversation or continue the current visible one.",
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

async function status(args) {
  const { browser, close } = await connectBrowser(args.cdp_endpoint);
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const chatgptPages = pages
      .map((page) => page.url())
      .filter((url) => url.includes("chatgpt.com"));
    return JSON.stringify(
      {
        ok: true,
        endpoint: args.cdp_endpoint || DEFAULT_CDP_ENDPOINT,
        page_count: pages.length,
        chatgpt_pages: chatgptPages,
      },
      null,
      2,
    );
  } finally {
    await close();
  }
}

async function askChatGptPro(args) {
  if (!args.prompt || !args.prompt.trim()) {
    throw new Error("prompt is required");
  }

  const timeoutMs = Number(args.timeout_ms || DEFAULT_TIMEOUT_MS);
  const requireProMode = args.require_pro_mode !== false;
  const conversationMode = args.conversation_mode || "new";
  const { browser, close } = await connectBrowser(args.cdp_endpoint);

  try {
    const page = await getChatGptPage(browser, conversationMode);
    page.setDefaultTimeout(Math.min(timeoutMs, 60000));

    const loginReady = await waitForComposer(page, timeoutMs);
    if (!loginReady) {
      throw new Error(
        "ChatGPT composer was not found. Open the connected browser, log into chatgpt.com, then retry.",
      );
    }

    const proSelection = await selectProMode(page);
    if (!proSelection.selected && requireProMode) {
      throw new Error(
        `Could not confidently select Pro mode: ${proSelection.reason}. Set require_pro_mode=false for a best-effort call.`,
      );
    }

    const beforeCount = await assistantMessageCount(page);
    await submitPrompt(page, args.prompt);
    const answer = await waitForStableAssistantText(page, beforeCount, timeoutMs);

    return JSON.stringify(
      {
        ok: true,
        pro_mode: proSelection,
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

async function getChatGptPage(browser, conversationMode) {
  const context = browser.contexts()[0] || (await browser.newContext());
  const pages = context.pages();
  const existing = pages.find((page) => page.url().includes("chatgpt.com"));

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

async function selectProMode(page) {
  const currentText = await visibleBodyText(page);
  if (/\bPro\b/.test(currentText) && /GPT-?5\.5/i.test(currentText)) {
    return { selected: true, reason: "Visible page already mentions GPT-5.5 and Pro." };
  }

  const pickerSelectors = [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label*="model" i]',
    'button:has-text("GPT-5.5")',
    'button:has-text("ChatGPT")',
  ];

  for (const selector of pickerSelectors) {
    const picker = page.locator(selector).first();
    if (!(await isVisible(picker, 1000))) continue;

    await picker.click().catch(() => {});
    await page.waitForTimeout(700);

    const option = await firstVisibleLocator(page, [
      'text=/GPT-?5\\.5\\s+Pro/i',
      'text=/\\bPro\\b/i',
      '[role="menuitem"]:has-text("Pro")',
      '[role="option"]:has-text("Pro")',
      'button:has-text("Pro")',
    ]);

    if (option) {
      await option.click().catch(() => {});
      await page.waitForTimeout(1000);
      return { selected: true, reason: "Clicked a visible Pro option." };
    }
  }

  return {
    selected: false,
    reason:
      "No visible model picker option matching GPT-5.5 Pro or Pro was found.",
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
