import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  renderResearchMarkdown,
  validateResearchReport,
} from "../.opencode/codegen/lib/research-report.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

async function fixture(name) {
  return JSON.parse(await readFile(path.join(here, `fixtures/goal-research/${name}.json`), "utf8"))
}

test("fixture report validates alone and against its Goal question", async () => {
  const report = await fixture("report")
  const goal = await fixture("goal")
  assert.deepEqual(validateResearchReport(report), { valid: true, errors: [] })
  assert.deepEqual(validateResearchReport(report, goal.research_questions[0]), {
    valid: true,
    errors: [],
  })
  const markdown = renderResearchMarkdown(report)
  assert.ok(markdown.includes("`F-1` [high]: Unique constraints raise IntegrityError (S-1)"))
  assert.ok(markdown.includes("[ORM constraints reference](https://example.org/docs/constraints)"))
  assert.ok(markdown.includes("## Unanswered Questions\n\n- None"))
  assert.ok(!markdown.includes("undefined"))
})

test("validator rejects unsupported evidence", async () => {
  const report = await fixture("report")
  const source = report.sources[0]
  const cases = [
    [{ ...report, sources: [{ ...source, url: "http://example.org" }] }, "S-1: source URL must use https"],
    [{ ...report, sources: [{ ...source, source_type: "blog" }] }, "S-1: invalid source_type"],
    [{ ...report, sources: [{ ...source, retrieved_at: "yesterday" }] }, "S-1: retrieved_at must be an ISO date-time"],
    [{ ...report, sources: [{ ...source, retrieved_at: "2999-01-01T00:00:00Z" }] }, "S-1: retrieved_at cannot be in the future"],
    [{ ...report, sources: [source, source], budget: { ...report.budget, sources_used: 2 } }, "duplicate source id: S-1"],
    [{ ...report, findings: [{ ...report.findings[0], source_ids: ["S-9"] }] }, "F-1: unknown source S-9"],
    [{ ...report, findings: [{ ...report.findings[0], source_ids: [] }] }, "F-1: finding must cite at least one source"],
    [{ ...report, findings: [{ ...report.findings[0], confidence: "certain" }] }, "F-1: confidence is invalid"],
    [{ ...report, findings: [] }, "COMPLETE report must contain findings"],
    [{ ...report, recommendation: "" }, "COMPLETE report must contain a recommendation"],
    [{ ...report, risks: [""] }, "risks contains empty text"],
    [{ ...report, budget: { ...report.budget, sources_used: 2 } }, "budget.sources_used must equal the number of sources"],
    [
      { ...report, budget: { max_sources: 1, max_minutes: 10, sources_used: 2 }, sources: [source, { ...source, id: "S-2" }] },
      "source count exceeds research budget",
    ],
  ]
  for (const [candidate, expected] of cases) {
    const result = validateResearchReport(candidate)
    assert.equal(result.valid, false)
    assert.ok(result.errors.includes(expected), `expected "${expected}" in ${result.errors}`)
  }
})

test("BLOCKED report needs unanswered questions and renders without a recommendation", async () => {
  const report = await fixture("report")
  const blocked = { ...report, status: "BLOCKED", findings: [], recommendation: "", sources: [], budget: { ...report.budget, sources_used: 0 } }
  assert.ok(validateResearchReport(blocked).errors.includes("BLOCKED report must explain unanswered questions"))
  const explained = { ...blocked, unanswered_questions: ["Vendor docs are behind a login"] }
  assert.deepEqual(validateResearchReport(explained), { valid: true, errors: [] })
  assert.ok(renderResearchMarkdown(explained).includes("No recommendation because research is blocked."))
})

test("report is bound to the Goal question it answers", async () => {
  const report = await fixture("report")
  const goal = await fixture("goal")
  const question = goal.research_questions[0]
  const cases = [
    [{ ...report, question_id: "RQ-2" }, "question_id does not match Goal"],
    [{ ...report, question: "Something else" }, "question text does not match Goal"],
    [{ ...report, budget: { ...report.budget, max_sources: 5 } }, "max_sources does not match Goal budget"],
    [{ ...report, budget: { ...report.budget, max_minutes: 1 } }, "max_minutes does not match Goal budget"],
    [{ ...report, sources: [{ ...report.sources[0], source_type: "vendor" }] }, "S-1: source type is not allowed by Goal"],
  ]
  for (const [candidate, expected] of cases) {
    const result = validateResearchReport(candidate, question)
    assert.equal(result.valid, false)
    assert.ok(result.errors.includes(expected), `expected "${expected}" in ${result.errors}`)
  }
})

test("every finding needs a verbatim quote; verification verdicts written by the runner are validated and rendered", async () => {
  const report = await fixture("report")
  const noQuote = { ...report, findings: [{ ...report.findings[0], quote: "" }] }
  assert.ok(validateResearchReport(noQuote).errors.includes("F-1: quote is required (a verbatim excerpt from a cited source)"))
  const longQuote = { ...report, findings: [{ ...report.findings[0], quote: "x".repeat(301) }] }
  assert.ok(validateResearchReport(longQuote).errors.includes("F-1: quote exceeds 300 characters"))

  const { reportAnswers, unverifiedFindings } = await import("../.opencode/codegen/lib/research-report.mjs")
  const verified = {
    ...report,
    verification: {
      mode: "fetch",
      verified_at: "2026-09-08T00:00:00Z",
      sources: [{ id: "S-1", status: "verified", http_status: 200, title_matched: true, detail: null }],
      findings: [{ id: "F-1", status: "verified", source_id: "S-1", detail: "quote found in S-1" }],
    },
  }
  assert.deepEqual(validateResearchReport(verified), { valid: true, errors: [] })
  assert.equal(reportAnswers(verified), true)
  assert.deepEqual(unverifiedFindings(verified), [])
  assert.ok(renderResearchMarkdown(verified).includes("(1/1 sources verified, 1/1 findings verified)"))

  const unverified = {
    ...verified,
    findings: [{ ...report.findings[0], confidence: "low" }],
    verification: {
      ...verified.verification,
      sources: [{ id: "S-1", status: "unverifiable", http_status: 403, title_matched: null, detail: "HTTP 403" }],
      findings: [{ id: "F-1", status: "unverified", source_id: null, detail: "no cited source could be verified", confidence_forced_low: true }],
    },
  }
  assert.equal(reportAnswers(unverified), false, "a COMPLETE report with nothing verified answers nothing")
  assert.deepEqual(unverifiedFindings(unverified), ["F-1"])
  const markdown = renderResearchMarkdown(unverified)
  assert.ok(markdown.includes("[UNVERIFIED (por confirmar): no cited source could be verified]"), markdown)
  assert.ok(markdown.includes("[UNVERIFIABLE: HTTP 403]"))

  const bad = { ...verified, verification: { ...verified.verification, mode: "guess", sources: [{ id: "S-9", status: "verified" }] } }
  const errors = validateResearchReport(bad).errors
  assert.ok(errors.includes("verification.mode must be fetch or offline"))
  assert.ok(errors.includes("verification.sources: unknown id S-9"))
  assert.equal(reportAnswers({ ...report, status: "BLOCKED" }), false)
  assert.equal(reportAnswers(report), true, "a report without verification (offline or legacy) is taken at face value")
})
