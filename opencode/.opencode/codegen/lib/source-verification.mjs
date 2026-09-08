// Research citations are checked by retrieval, not trusted. Every source is
// fetched; every finding's quote is searched in the text of the sources it
// cites. Deterministic verdicts:
//   missing      DNS failure or 404/410: the source does not exist → fabricated
//   mismatched   fetched, but the page shares no significant title word with
//                the cited title → fabricated
//   unverifiable 403, 429, 5xx, timeout, or non-text content: cannot judge
//   verified     fetched as text
// A finding is verified when its quote appears in a verified source it cites.
// Anything else is unverified: reported, confidence forced to low, never
// rejected. A report whose findings are all unverified answers nothing.

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const STOP_WORDS = new Set(["about", "after", "docs", "documentation", "from", "guide", "into", "official", "over", "page", "reference", "that", "this", "with", "your"])

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " }

export function normalizeText(text) {
  return String(text ?? "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (match) => ENTITIES[match] ?? " ")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

// HTML to plain text: scripts and styles dropped, tags become spaces.
export function htmlToText(html) {
  return normalizeText(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
}

export function pageTitle(html) {
  const match = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]) : ""
}

function significantWords(text) {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
}

// The cited title must share at least one significant word with the page's
// title or its text; a page about something else is a fabricated citation.
export function titleMatches(citedTitle, { title, text }) {
  const words = significantWords(citedTitle)
  if (words.length === 0) return true
  const haystack = `${normalizeText(title)} ${text.slice(0, 20000)}`
  return words.some((word) => haystack.includes(word))
}

export function quoteFound(quote, text) {
  const needle = normalizeText(quote)
  return needle.length > 0 && text.includes(needle)
}

function isNetworkMissing(error) {
  const code = error?.cause?.code ?? error?.code ?? ""
  return ["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"].includes(code)
}

async function fetchSource(url, { fetch: fetchImpl, timeoutMs, maxBytes }) {
  let response
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "opencode-codegen-source-verification/1", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    })
  } catch (error) {
    if (isNetworkMissing(error)) return { status: "missing", detail: `host not found (${error?.cause?.code ?? error?.code})` }
    return { status: "unverifiable", detail: error?.name === "TimeoutError" || error?.name === "AbortError" ? `timeout after ${timeoutMs} ms` : `fetch failed: ${error?.cause?.message ?? error?.message ?? "unknown error"}` }
  }
  const httpStatus = response.status
  if (httpStatus === 404 || httpStatus === 410) return { status: "missing", http_status: httpStatus, detail: `HTTP ${httpStatus}` }
  if (httpStatus >= 400) return { status: "unverifiable", http_status: httpStatus, detail: `HTTP ${httpStatus}` }
  const contentType = String(response.headers?.get?.("content-type") ?? "")
  if (contentType && !/text\/|xml|json/i.test(contentType)) {
    return { status: "unverifiable", http_status: httpStatus, detail: `content-type ${contentType} is not text` }
  }
  let body
  try {
    body = await response.text()
  } catch (error) {
    return { status: "unverifiable", http_status: httpStatus, detail: `body could not be read: ${error?.message ?? "unknown error"}` }
  }
  if (body.length > maxBytes) body = body.slice(0, maxBytes)
  return { status: "verified", http_status: httpStatus, title: pageTitle(body), text: htmlToText(body) }
}

export async function verifySources(report, { fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, now = new Date() } = {}) {
  const verifiedAt = now.toISOString()
  const pages = new Map()
  const sources = []
  for (const source of report?.sources ?? []) {
    const fetched = await fetchSource(source.url, { fetch: fetchImpl, timeoutMs, maxBytes })
    let status = fetched.status
    let detail = fetched.detail ?? null
    let titleMatched = null
    if (status === "verified") {
      titleMatched = titleMatches(source.title, { title: fetched.title, text: fetched.text })
      if (!titleMatched) {
        status = "mismatched"
        detail = `page title "${fetched.title || "(none)"}" shares no significant word with the cited title`
      } else {
        pages.set(source.id, fetched.text)
      }
    }
    sources.push({ id: source.id, url: source.url, status, http_status: fetched.http_status ?? null, title_matched: titleMatched, detail, fetched_at: verifiedAt })
  }
  const findings = (report?.findings ?? []).map((finding) => {
    const cited = (finding.source_ids ?? []).filter((id) => pages.has(id))
    const match = cited.find((id) => quoteFound(finding.quote, pages.get(id)))
    if (match) return { id: finding.id, status: "verified", source_id: match, detail: `quote found in ${match}` }
    if (cited.length === 0) return { id: finding.id, status: "unverified", source_id: null, detail: "no cited source could be verified" }
    return { id: finding.id, status: "unverified", source_id: null, detail: `quote not found in ${cited.join(", ")}` }
  })
  const fabricated = sources.filter((item) => item.status === "missing" || item.status === "mismatched")
  return {
    mode: "fetch",
    verified_at: verifiedAt,
    sources,
    findings,
    fabricated: fabricated.map((item) => `${item.id}: ${item.detail}`),
    all_unverified: findings.length > 0 && findings.every((item) => item.status === "unverified"),
  }
}

// Writes the verdicts into the report and forces the confidence of every
// unverified finding to low. The model's other content is untouched.
export function applyVerification(report, verification) {
  const applied = structuredClone(report)
  const unverified = new Set(verification.findings.filter((item) => item.status === "unverified").map((item) => item.id))
  const forced = []
  for (const finding of applied.findings ?? []) {
    if (unverified.has(finding.id) && finding.confidence !== "low") {
      forced.push(finding.id)
      finding.confidence = "low"
    }
  }
  applied.verification = {
    mode: verification.mode,
    verified_at: verification.verified_at,
    sources: verification.sources.map(({ id, status, http_status, title_matched, detail }) => ({ id, status, http_status, title_matched, detail })),
    findings: verification.findings.map((item) => ({ ...item, confidence_forced_low: forced.includes(item.id) })),
  }
  return applied
}

// Maintenance-only record for runs that skipped the network.
export function offlineVerification(report, { now = new Date() } = {}) {
  return {
    mode: "offline",
    verified_at: now.toISOString(),
    sources: (report?.sources ?? []).map((source) => ({ id: source.id, status: "skipped", http_status: null, title_matched: null, detail: "verification skipped (maintenance only)" })),
    findings: (report?.findings ?? []).map((finding) => ({ id: finding.id, status: "skipped", source_id: null, detail: "verification skipped (maintenance only)" })),
    fabricated: [],
    all_unverified: false,
  }
}
