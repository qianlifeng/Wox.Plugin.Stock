const MARKETS = ["a", "hk", "us"]
const MAX_SEARCH_RESULTS = 8
const MAX_WATCHLIST = 50

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""))
  return Number.isFinite(number) ? number : NaN
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") return Object.values(value)
  return []
}

function instrumentKey(instrument) {
  if (!instrument) return ""
  if (instrument.quoteId) return instrument.quoteId
  return `${instrument.market}:${instrument.code}`
}

function sameInstrument(left, right) {
  if (!left || !right) return false
  if (left.quoteId && right.quoteId && left.quoteId === right.quoteId) return true
  return left.market === right.market && String(left.code).toUpperCase() === String(right.code).toUpperCase()
}

// normalizeInstrument turns a search row or watchlist row into provider-neutral identity.
function normalizeInstrument(raw) {
  if (!raw || !MARKETS.includes(raw.market)) return null
  let code = String(raw.code || "").trim()
  if (!code) return null
  if (raw.market === "us") code = code.toUpperCase()
  if (raw.market === "hk") code = code.replace(/\D/g, "").padStart(5, "0")
  if (raw.market === "a") code = code.replace(/\D/g, "")
  if (!code) return null
  return {
    market: raw.market,
    code,
    name: String(raw.name || code).trim() || code,
    quoteId: String(raw.quoteId || "").trim()
  }
}

function normalizeWatchlist(raw) {
  let rows = raw
  if (typeof raw === "string") {
    try {
      rows = JSON.parse(raw || "[]")
    } catch {
      rows = []
    }
  }
  if (!Array.isArray(rows)) return []
  const seen = new Set()
  const items = []
  for (const row of rows) {
    const item = normalizeInstrument(row)
    if (!item) continue
    const key = instrumentKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
    if (items.length >= MAX_WATCHLIST) break
  }
  return items
}

function addWatchItem(list, raw) {
  const item = normalizeInstrument(raw)
  const next = normalizeWatchlist(list)
  if (!item) return { list: next, item: null, added: false, reason: "invalid" }
  if (next.some((row) => sameInstrument(row, item))) {
    return { list: next, item, added: false, reason: "exists" }
  }
  if (next.length >= MAX_WATCHLIST) {
    return { list: next, item, added: false, reason: "full" }
  }
  next.push(item)
  return { list: next, item, added: true, reason: "added" }
}

function removeWatchItem(list, raw) {
  const next = normalizeWatchlist(list)
  const target = {
    market: raw && raw.market,
    code: raw && raw.code,
    quoteId: raw && raw.quoteId ? String(raw.quoteId) : ""
  }
  const filtered = next.filter((row) => !sameInstrument(row, target))
  return { list: filtered, removed: filtered.length !== next.length }
}

// inferInstrument builds an identity from a bare code when name search is down.
function inferInstrument(text) {
  const raw = String(text || "").trim()
  if (/^\d{6}$/.test(raw)) {
    let quoteId = ""
    if (/^[69]/.test(raw)) quoteId = `1.${raw}`
    else if (/^[03]/.test(raw)) quoteId = `0.${raw}`
    if (!quoteId) return null
    return normalizeInstrument({ market: "a", code: raw, name: raw, quoteId })
  }
  if (/^\d{1,5}$/.test(raw)) {
    const code = raw.padStart(5, "0")
    return normalizeInstrument({ market: "hk", code, name: code, quoteId: `116.${code}` })
  }
  if (/^[A-Za-z]{1,5}([.-][A-Za-z])?$/.test(raw)) {
    return normalizeInstrument({ market: "us", code: raw.toUpperCase(), name: raw.toUpperCase(), quoteId: "" })
  }
  return null
}

function blockedSecurity(row) {
  const blob = `${row.Name || ""} ${row.SecurityTypeName || ""}`
  if (/债|指数|基金|窝轮|牛熊|权证|界内证/.test(blob)) return true
  if (/notes|bond|warrant|preferred|\betf\b/i.test(blob)) return true
  if (/-R$/.test(row.Name || "")) return true
  return false
}

function marketOfClassify(classify) {
  if (classify === "AStock") return "a"
  if (classify === "HK") return "hk"
  if (classify === "UsStock") return "us"
  return ""
}

function rankHit(query, code, name, pinyin, market) {
  const needle = String(query || "").trim().toLowerCase()
  const values = [code, name, pinyin].map((value) => String(value || "").toLowerCase())
  if (values.some((value) => value === needle)) return 0
  // Hong Kong codes are often typed without leading zeros. Do not apply that
  // to A-shares, or 00700 would also match 000700.
  if (market === "hk") {
    const bareCode = String(code || "").replace(/^0+/, "")
    const bareNeedle = needle.replace(/^0+/, "")
    if (bareCode && bareCode === bareNeedle) return 0
  }
  // Anything else stays in the search engine's order. A later English name
  // such as "Google DeepMind..." must not hide 谷歌, whose name does not contain "google".
  return 1
}

// selectSearchHits keeps A-share, Hong Kong, and US equities from an East Money suggest payload.
function selectSearchHits(rows, query, markets, limit = MAX_SEARCH_RESULTS) {
  const allowed = new Set(markets)
  const picked = []
  asArray(rows).forEach((row, index) => {
    const market = marketOfClassify(row.Classify)
    const quoteId = String(row.QuoteID || "").trim()
    const codeFromId = quoteId.includes(".") ? quoteId.split(".").slice(1).join(".") : ""
    if (!market || !allowed.has(market) || blockedSecurity(row)) return
    const item = normalizeInstrument({
      market,
      code: codeFromId || row.Code,
      name: row.Name || row.Code,
      quoteId
    })
    if (!item) return
    // AAPL.TO is Toronto, not a US listing. Share classes such as BRK.B stay.
    if (item.market === "us" && !/^[A-Z]{1,5}([.-][A-Z])?$/.test(item.code)) return
    picked.push({
      ...item,
      rank: rankHit(query, item.code, item.name, row.PinYin, item.market),
      index
    })
  })
  picked.sort((left, right) => left.rank - right.rank || left.index - right.index)
  const exact = picked.filter((item) => item.rank === 0)
  const chosen = exact.length ? exact : picked
  return chosen.slice(0, limit).map(({ market, code, name, quoteId }) => ({ market, code, name, quoteId }))
}


module.exports = { MARKETS, MAX_SEARCH_RESULTS, finiteNumber, asArray, instrumentKey, sameInstrument, normalizeInstrument, normalizeWatchlist, addWatchItem, removeWatchItem, inferInstrument, selectSearchHits }
