import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPromptPlan,
  isChatGptAppUrl,
  isChatGptRelatedUrl,
  isOpenAiAuthUrl,
  scoreModeCandidate,
  selectPreferredPageCandidate,
  sendButtonSelectors,
  shouldAbortChunkResponse,
} from "./chatgpt-pro-mcp.mjs";

test("mode scoring rejects full Korean effort menu containers as a Pro selection", () => {
  const scored = scoreModeCandidate(
    {
      text: "지능 즉시 중간 높음 매우 높음 Pro 확장 GPT-5.5 지능즉시중간높음매우 높음Pro 확장GPT-5.5",
      role: "menu",
      checked: false,
      has_popup: false,
    },
    "GPT-5.5 Pro",
  );

  assert.equal(scored.has_pro, true);
  assert.equal(scored.has_non_pro_effort, true);
  assert.ok(scored.score < 80);
});

test("mode scoring accepts a focused Korean Pro expansion leaf", () => {
  const scored = scoreModeCandidate(
    {
      text: "Pro 확장",
      role: "menuitem",
      checked: false,
      has_popup: false,
    },
    "GPT-5.5 Pro",
  );

  assert.equal(scored.has_pro, true);
  assert.equal(scored.has_non_pro_effort, false);
  assert.ok(scored.score >= 80);
});

test("send button selectors do not include generic SVG button fallback", () => {
  const selectors = sendButtonSelectors();

  assert.ok(selectors.some((selector) => selector.includes("send-button")));
  assert.ok(selectors.some((selector) => selector.includes("aria-label")));
  assert.equal(selectors.some((selector) => selector === "button:has(svg)"), false);
});

test("page selection prefers saved sessions, then the visible current ChatGPT tab", () => {
  const older = {
    url: "https://chatgpt.com/c/older",
    visibility_state: "hidden",
  };
  const visible = {
    url: "https://chatgpt.com/c/visible",
    visibility_state: "visible",
  };
  const saved = {
    url: "https://chatgpt.com/c/saved",
    visibility_state: "hidden",
  };

  assert.equal(
    selectPreferredPageCandidate([older, visible, saved], {
      savedUrl: "https://chatgpt.com/c/saved",
    }),
    saved,
  );
  assert.equal(selectPreferredPageCandidate([older, visible, saved]), visible);
  assert.equal(selectPreferredPageCandidate([older]), older);
});

test("URL helpers distinguish ChatGPT app pages and OpenAI auth pages", () => {
  assert.equal(isChatGptAppUrl("https://chatgpt.com/"), true);
  assert.equal(isChatGptAppUrl("https://auth.openai.com/log-in/password"), false);
  assert.equal(isOpenAiAuthUrl("https://auth.openai.com/log-in/password"), true);
  assert.equal(isChatGptRelatedUrl("https://auth.openai.com/log-in/password"), true);
  assert.equal(isChatGptRelatedUrl("https://example.com/"), false);
});

test("chunk flow aborts before sending the next chunk when the current response is incomplete", () => {
  assert.equal(
    shouldAbortChunkResponse(0, 3, { status: "streaming", still_running: true }),
    true,
  );
  assert.equal(
    shouldAbortChunkResponse(0, 3, { status: "timeout_partial", still_running: false }),
    true,
  );
  assert.equal(
    shouldAbortChunkResponse(0, 3, { status: "complete", still_running: false }),
    false,
  );
  assert.equal(
    shouldAbortChunkResponse(2, 3, { status: "streaming", still_running: true }),
    false,
  );
});

test("chunk prompt planning still creates ack-only context messages", () => {
  const plan = buildPromptPlan("a".repeat(10000), 5000, "chunk");

  assert.equal(plan.summary.strategy, "chunk");
  assert.ok(plan.messages.length > 1);
  assert.match(plan.messages[0], /Reply only: ACK PART 1\//);
  assert.match(plan.messages.at(-1), /Now answer the user's request/);
});
