import assert from "node:assert/strict"
import test from "node:test"

import { applyVerification, htmlToText, normalizeText, offlineVerification, quoteFound, titleMatches, verifySources } from "../.opencode/codegen/lib/source-verification.mjs"

// A fake fetch: each URL maps to a response, an HTTP error, or a thrown error.
function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url]
    if (!route) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })
    if (route.throw) throw route.throw
    return {
      status: route.status ?? 200,
      headers: { get: (name) => (name === "content-type" ? route.type ?? "text/html; charset=utf-8" : null) },
      text: async () => route.body ?? "",
    }
  }
}

const page = (title, body) => `<html><head><title>${title}</title><script>ignored()</script></head><body><h1>${title}</h1><p>${body}</p></body></html>`

function report(overrides = {}) {
  return {
    sources: [
      { id: "S-1", title: "Node.js release schedule", url: "https://example.test/releases" },
      { id: "S-2", title: "Unrelated page", url: "https://example.test/other" },
    ],
    findings: [
      { id: "F-1", claim: "Node 22 reaches end of life in April 2027", quote: "Node.js 22 reaches End-of-Life on 2027-04-30", source_ids: ["S-1"], confidence: "high" },
      { id: "F-2", claim: "Something the page does not say", quote: "this sentence is nowhere", source_ids: ["S-1"], confidence: "medium" },
    ],
    ...overrides,
  }
}

test("text normalization strips tags, scripts, entities, and whitespace", () => {
  assert.equal(htmlToText(page("A &amp; B", "Hello,\n   <b>world</b>&nbsp;!")), "a & b a & b hello, world !")
  assert.equal(normalizeText("  “Smart”  quotes—dash "), '"smart" quotes-dash')
  assert.equal(quoteFound("HELLO, world", "a & b hello, world !"), true)
  assert.equal(quoteFound("", "anything"), false)
  assert.equal(titleMatches("Node.js release schedule", { title: "Releases | Node.js", text: "" }), true)
  assert.equal(titleMatches("Node.js release schedule", { title: "Welcome", text: "nothing about that here" }), false)
  assert.equal(titleMatches("Docs", { title: "x", text: "" }), true, "a title with no significant word cannot mismatch")
})

test("verified sources and found quotes; missing quotes and unverifiable sources are marked, never rejected", async () => {
  const fetch = fakeFetch({
    "https://example.test/releases": { body: page("Releases | Node.js", "Node.js 22 reaches End-of-Life on 2027-04-30.") },
    "https://example.test/other": { status: 403, body: "forbidden" },
  })
  const verification = await verifySources(report(), { fetch, now: new Date("2026-09-08T00:00:00Z") })
  assert.equal(verification.mode, "fetch")
  assert.deepEqual(verification.sources.map((item) => [item.id, item.status, item.http_status]), [["S-1", "verified", 200], ["S-2", "unverifiable", 403]])
  assert.deepEqual(verification.findings.map((item) => [item.id, item.status, item.source_id]), [["F-1", "verified", "S-1"], ["F-2", "unverified", null]])
  assert.match(verification.findings[1].detail, /quote not found in S-1/)
  assert.deepEqual(verification.fabricated, [])
  assert.equal(verification.all_unverified, false)

  const applied = applyVerification(report(), verification)
  assert.equal(applied.findings[0].confidence, "high")
  assert.equal(applied.findings[1].confidence, "low", "an unverified finding cannot keep a confident claim")
  assert.equal(applied.verification.findings[1].confidence_forced_low, true)
  assert.equal(applied.verification.sources[1].detail, "HTTP 403")
})

test("a source that does not exist or is about something else is fabricated; a report with nothing verified answers nothing", async () => {
  const missing = await verifySources(report(), {
    fetch: fakeFetch({ "https://example.test/releases": { status: 404 }, "https://example.test/other": { body: page("Unrelated things", "x") } }),
  })
  assert.equal(missing.sources[0].status, "missing")
  assert.deepEqual(missing.fabricated, ["S-1: HTTP 404"])

  const unknownHost = await verifySources(report(), { fetch: fakeFetch({}) })
  assert.ok(unknownHost.sources.every((item) => item.status === "missing"))
  assert.match(unknownHost.sources[0].detail, /host not found/)

  const mismatched = await verifySources(report(), {
    fetch: fakeFetch({ "https://example.test/releases": { body: page("Cooking recipes", "Boil the pasta.") }, "https://example.test/other": { status: 500 } }),
  })
  assert.equal(mismatched.sources[0].status, "mismatched")
  assert.match(mismatched.fabricated[0], /shares no significant word/)

  const nothing = await verifySources(report(), {
    fetch: fakeFetch({ "https://example.test/releases": { throw: Object.assign(new Error("aborted"), { name: "TimeoutError" }) }, "https://example.test/other": { type: "application/pdf", body: "%PDF" } }),
  })
  assert.deepEqual(nothing.sources.map((item) => item.status), ["unverifiable", "unverifiable"])
  assert.match(nothing.sources[0].detail, /timeout/)
  assert.match(nothing.sources[1].detail, /not text/)
  assert.equal(nothing.all_unverified, true)
  assert.deepEqual(nothing.fabricated, [])
})

test("offline verification records that nothing was fetched", () => {
  const offline = offlineVerification(report())
  assert.equal(offline.mode, "offline")
  assert.ok(offline.sources.every((item) => item.status === "skipped"))
  assert.equal(offline.all_unverified, false)
  const applied = applyVerification(report(), offline)
  assert.equal(applied.findings[1].confidence, "medium", "offline mode forces nothing")
})
