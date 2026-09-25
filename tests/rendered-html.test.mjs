import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Hothouse capture editor", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Hothouse NAM Editor<\/title>/i);
  assert.match(html, /NAM captures/);
  assert.match(html, /A \/ B \/ C match the pedal/);
  assert.match(html, /Connect pedal/);
  assert.match(html, /Compatibility is checked before anything is sent/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/);
});
