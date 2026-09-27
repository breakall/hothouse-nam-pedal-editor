import assert from "node:assert/strict";
import test from "node:test";
import { unstable_dev } from "wrangler";

async function render() {
  const worker = await unstable_dev("dist/server/index.js", {
    config: "dist/server/wrangler.json",
    bundle: false,
    local: true,
    logLevel: "none",
    persist: false,
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  });

  try {
    const response = await worker.fetch("http://localhost/", {
      headers: { accept: "text/html" },
    });
    return { response, html: await response.text() };
  } finally {
    await worker.stop();
  }
}

test("server-renders the Hothouse capture editor", async () => {
  const { response, html } = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(html, /<title>Hothouse NAM Editor<\/title>/i);
  assert.match(html, /NAM captures/);
  assert.match(html, /A \/ B \/ C match the pedal/);
  assert.match(html, /Connect pedal/);
  assert.match(html, /Compatibility is checked before anything is sent/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/);
});
