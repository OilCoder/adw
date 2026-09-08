const SOURCE_TYPES = new Set(["official", "independent", "vendor", "community"])
const SOURCE_STATUSES = new Set(["verified", "unverifiable", "missing", "mismatched", "skipped"])
const FINDING_STATUSES = new Set(["verified", "unverified", "skipped"])
const MAX_QUOTE_LENGTH = 300

function text(value) {
  return typeof value === "string" && value.trim().length > 0
}

const CONFIDENCE = new Set(["low", "medium", "high"])

function stringList(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return
  }
  if (value.some((item) => !text(item))) errors.push(`${label} contains empty text`)
}

function validateVerification(verification, report, errors) {
  if (!["fetch", "offline"].includes(verification?.mode)) errors.push("verification.mode must be fetch or offline")
  if (!text(verification?.verified_at) || Number.isNaN(new Date(verification.verified_at).getTime())) {
    errors.push("verification.verified_at must be an ISO date-time")
  }
  const sourceIds = new Set((report?.sources ?? []).map((source) => source?.id))
  const findingIds = new Set((report?.findings ?? []).map((finding) => finding?.id))
  for (const [label, items, ids, statuses] of [
    ["sources", verification?.sources, sourceIds, SOURCE_STATUSES],
    ["findings", verification?.findings, findingIds, FINDING_STATUSES],
  ]) {
    if (!Array.isArray(items)) {
      errors.push(`verification.${label} must be an array`)
      continue
    }
    for (const item of items) {
      if (!ids.has(item?.id)) errors.push(`verification.${label}: unknown id ${item?.id}`)
      if (!statuses.has(item?.status)) errors.push(`verification.${label}: invalid status for ${item?.id}`)
    }
  }
}

export function validateResearchReport(report, question = null, { now = new Date() } = {}) {
  const errors = []
  if (report?.schema_version !== 1) errors.push("schema_version must be 1")
  for (const field of ["report_id", "question_id", "question", "summary"]) {
    if (!text(report?.[field])) errors.push(`${field} must be a non-empty string`)
  }
  if (!new Set(["COMPLETE", "BLOCKED"]).has(report?.status)) errors.push("status is invalid")
  for (const field of ["findings", "sources"]) {
    if (!Array.isArray(report?.[field])) errors.push(`${field} must be an array`)
  }
  for (const field of ["alternatives", "risks", "limitations", "unanswered_questions"]) {
    stringList(report?.[field], field, errors)
  }

  const sourceIds = new Set()
  for (const source of report?.sources ?? []) {
    if (!text(source?.id)) errors.push("source id is required")
    else if (sourceIds.has(source.id)) errors.push(`duplicate source id: ${source.id}`)
    else sourceIds.add(source.id)
    if (!text(source?.url) || !source.url.startsWith("https://")) {
      errors.push(`${source?.id}: source URL must use https`)
    }
    if (!SOURCE_TYPES.has(source?.source_type)) errors.push(`${source?.id}: invalid source_type`)
    if (!text(source?.title) || !text(source?.publisher) || !text(source?.retrieved_at)) {
      errors.push(`${source?.id}: source metadata is incomplete`)
    } else {
      const retrieved = new Date(source.retrieved_at)
      if (Number.isNaN(retrieved.getTime())) {
        errors.push(`${source.id}: retrieved_at must be an ISO date-time`)
      } else if (retrieved.getTime() > now.getTime()) {
        errors.push(`${source.id}: retrieved_at cannot be in the future`)
      }
    }
  }
  const findingIds = new Set()
  for (const finding of report?.findings ?? []) {
    if (!text(finding?.id)) errors.push("finding id is required")
    else if (findingIds.has(finding.id)) errors.push(`duplicate finding id: ${finding.id}`)
    else findingIds.add(finding.id)
    if (!text(finding?.claim)) errors.push(`${finding?.id}: claim is required`)
    // The quote is what the runner searches for in the fetched source; a
    // finding without one cannot be verified and is not accepted.
    if (!text(finding?.quote)) errors.push(`${finding?.id}: quote is required (a verbatim excerpt from a cited source)`)
    else if (finding.quote.length > MAX_QUOTE_LENGTH) errors.push(`${finding?.id}: quote exceeds ${MAX_QUOTE_LENGTH} characters`)
    if (!CONFIDENCE.has(finding?.confidence)) errors.push(`${finding?.id}: confidence is invalid`)
    if (!Array.isArray(finding?.source_ids) || finding.source_ids.length === 0) {
      errors.push(`${finding?.id}: finding must cite at least one source`)
    }
    for (const sourceId of finding?.source_ids ?? []) {
      if (!sourceIds.has(sourceId)) errors.push(`${finding?.id}: unknown source ${sourceId}`)
    }
  }
  if (report?.status === "COMPLETE" && (report.findings?.length ?? 0) === 0) {
    errors.push("COMPLETE report must contain findings")
  }
  if (report?.status === "COMPLETE" && !text(report?.recommendation)) {
    errors.push("COMPLETE report must contain a recommendation")
  }
  if (report?.status === "BLOCKED" && (report.unanswered_questions?.length ?? 0) === 0) {
    errors.push("BLOCKED report must explain unanswered questions")
  }
  if (!Number.isInteger(report?.budget?.sources_used) || report.budget.sources_used < 0) {
    errors.push("budget.sources_used must be a non-negative integer")
  }
  if (report?.budget?.sources_used !== (report?.sources?.length ?? 0)) {
    errors.push("budget.sources_used must equal the number of sources")
  }
  if (report?.budget?.sources_used > report?.budget?.max_sources) {
    errors.push("source count exceeds research budget")
  }
  if (report?.verification !== undefined) validateVerification(report.verification, report, errors)
  if (question) {
    if (report?.question_id !== question.id) errors.push("question_id does not match Goal")
    if (report?.question !== question.question) errors.push("question text does not match Goal")
    if (report?.budget?.max_sources !== question.budget.max_sources) {
      errors.push("max_sources does not match Goal budget")
    }
    if (report?.budget?.max_minutes !== question.budget.max_minutes) {
      errors.push("max_minutes does not match Goal budget")
    }
    for (const source of report?.sources ?? []) {
      if (!question.allowed_source_types.includes(source.source_type)) {
        errors.push(`${source.id}: source type is not allowed by Goal`)
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

// Which findings the runner could not verify by retrieval.
export function unverifiedFindings(report) {
  if (report?.verification?.mode !== "fetch") return []
  return (report.verification.findings ?? []).filter((item) => item.status === "unverified").map((item) => item.id)
}

// A report answers its question only when it is COMPLETE and at least one
// finding was verified by retrieval. A COMPLETE report with every finding
// unverified is evidence nobody could check: it is treated like BLOCKED.
export function reportAnswers(report) {
  if (report?.status !== "COMPLETE") return false
  const findings = report.findings ?? []
  if (findings.length === 0) return false
  const unverified = unverifiedFindings(report)
  return unverified.length < findings.length
}

function bullets(items, format = (item) => item) {
  return items.length > 0 ? items.map((item) => `- ${format(item)}`).join("\n") : "- None"
}

function sourceLabel(report, sourceId) {
  const entry = report.verification?.sources?.find((item) => item.id === sourceId)
  if (!entry) return ""
  if (entry.status === "verified") return " [verified]"
  if (entry.status === "skipped") return " [verification skipped]"
  return ` [${entry.status.toUpperCase()}: ${entry.detail ?? ""}]`
}

function findingLabel(report, findingId) {
  const entry = report.verification?.findings?.find((item) => item.id === findingId)
  if (!entry) return ""
  if (entry.status === "verified") return " [verified]"
  if (entry.status === "skipped") return " [verification skipped]"
  return ` [UNVERIFIED (por confirmar): ${entry.detail ?? ""}]`
}

export function renderResearchMarkdown(report) {
  const validation = validateResearchReport(report)
  if (!validation.valid) {
    throw new Error(`Cannot render invalid research report: ${validation.errors.join("; ")}`)
  }
  const verificationLine = report.verification
    ? `<br>\n**Source verification:** \`${report.verification.mode}\`${report.verification.mode === "fetch" ? ` (${report.verification.sources.filter((item) => item.status === "verified").length}/${report.verification.sources.length} sources verified, ${report.verification.findings.filter((item) => item.status === "verified").length}/${report.verification.findings.length} findings verified)` : " (maintenance only, nothing fetched)"}`
    : ""
  return `# Research: ${report.question}

**Report ID:** \`${report.report_id}\`<br>
**Question ID:** \`${report.question_id}\`<br>
**Status:** \`${report.status}\`${verificationLine}

## Summary

${report.summary}

## Findings

${bullets(report.findings, (finding) => `\`${finding.id}\` [${finding.confidence}]: ${finding.claim} (${finding.source_ids.join(", ")})${findingLabel(report, finding.id)}\n  > ${finding.quote}`)}

## Alternatives

${bullets(report.alternatives)}

## Recommendation

${report.recommendation || "No recommendation because research is blocked."}

## Risks

${bullets(report.risks)}

## Sources

${bullets(report.sources, (source) => `\`${source.id}\` [${source.title}](${source.url}) - ${source.publisher}, ${source.retrieved_at}${sourceLabel(report, source.id)}`)}

## Limitations

${bullets(report.limitations)}

## Unanswered Questions

${bullets(report.unanswered_questions)}
`
}
