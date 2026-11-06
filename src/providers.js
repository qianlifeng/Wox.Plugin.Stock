const https = require("https")
const http = require("http")
const zlib = require("zlib")
const { MAX_SEARCH_RESULTS, finiteNumber, asArray, instrumentKey, normalizeInstrument, inferInstrument, selectSearchHits } = require("./instruments")

const QUOTE_TTL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 8000
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

// First id is preferred. The rest are fallbacks for that market only.
const MARKET_PROVIDER_ORDER = {
  a: ["eastmoney", "tencent"],
  hk: ["eastmoney", "tencent"],
  us: ["eastmoney", "yahoo", "tencent"]
}

// A later search source runs only when an earlier one throws, not when it
// returns no matches.
const SEARCH_PROVIDER_ORDER = ["eastmoney", "yahoo"]

// parseExchangeTime reads a provider clock. Compact values are China exchange time.
// US strings without a zone are left unset so a wrong offset is not shown.
function parseExchangeTime(text, symbol) {
  const compact = String(text || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact
    const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`)
    return Number.isFinite(parsed) ? parsed / 1000 : 0
  }
  const dashed = String(text || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (!dashed || String(symbol || "").toLowerCase().startsWith("us")) return 0
  const [, year, month, day, hour, minute, second] = dashed
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`)
  return Number.isFinite(parsed) ? parsed / 1000 : 0
}

class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs
    this.values = new Map()
  }

  get(key, now) {
    const hit = this.values.get(key)
    if (!hit || hit.expires <= now) {
      this.values.delete(key)
      return null
    }
    return hit.value
  }

  set(key, value, now) {
    this.values.set(key, { value, expires: now + this.ttlMs })
  }
}

function quoteCacheKey(providerId, symbol) {
  return `quote:${providerId}:${symbol}`
}

// httpGet decodes GBK quote pages and follows a few redirects. Callers inject
// a fake fetch in tests.
function httpGet(url, headers = {}, redirects = 0, attempt = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("http://") ? http : https
    const req = lib.get(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        httpGet(next, headers, redirects + 1).then(resolve, reject)
        return
      }
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        try {
          if (status >= 400) {
            reject(new Error(`HTTP ${status} for ${url}`))
            return
          }
          let buf = Buffer.concat(chunks)
          if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
          const contentType = String(res.headers["content-type"] || "")
          const encoding = /gbk|gb2312/i.test(contentType) || /gtimg\.cn/i.test(url) ? "gbk" : "utf8"
          resolve(new TextDecoder(encoding).decode(buf))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy(new Error(`timeout for ${url}`))
    })
  }).catch((err) => {
    const message = `${err && err.code ? err.code : ""} ${err && err.message ? err.message : err}`
    if (attempt < 1 && redirects === 0 && /socket hang up|ECONNRESET|ETIMEDOUT|timeout/i.test(message)) {
      return httpGet(url, headers, 0, attempt + 1)
    }
    throw err
  })
}

function currencyForMarket(market) {
  if (market === "hk") return "HKD"
  if (market === "us") return "USD"
  return "CNY"
}

function currencyForEastMoneyMarket(marketCode) {
  const code = Number(marketCode)
  if (code === 116) return "HKD"
  if (code === 105 || code === 106 || code === 107) return "USD"
  return "CNY"
}

function parseEastMoneyListRow(row) {
  return {
    symbol: `${row.f13}.${row.f12}`,
    code: String(row.f12 || ""),
    name: row.f14 || "",
    price: finiteNumber(row.f2),
    changePercent: finiteNumber(row.f3),
    change: finiteNumber(row.f4),
    volume: finiteNumber(row.f5),
    amount: finiteNumber(row.f6),
    turnover: finiteNumber(row.f8),
    pe: finiteNumber(row.f9),
    high: finiteNumber(row.f15),
    low: finiteNumber(row.f16),
    open: finiteNumber(row.f17),
    prevClose: finiteNumber(row.f18),
    time: finiteNumber(row.f124) || 0,
    timeText: "",
    currency: currencyForEastMoneyMarket(row.f13)
  }
}

function parseEastMoneySingleRow(row) {
  return {
    symbol: "",
    code: String(row.f57 || ""),
    name: row.f58 || "",
    price: finiteNumber(row.f43),
    change: finiteNumber(row.f169),
    changePercent: finiteNumber(row.f170),
    open: finiteNumber(row.f46),
    high: finiteNumber(row.f44),
    low: finiteNumber(row.f45),
    prevClose: finiteNumber(row.f60),
    volume: finiteNumber(row.f47),
    amount: finiteNumber(row.f48),
    turnover: finiteNumber(row.f168),
    pe: finiteNumber(row.f162),
    time: finiteNumber(row.f86) || 0,
    timeText: "",
    currency: ""
  }
}

// parseEastMoneyQuotes accepts either the batch ulist payload or one stock/get payload.
function parseEastMoneyQuotes(payload) {
  const body = typeof payload === "string" ? JSON.parse(payload) : payload
  if (!body || body.rc !== 0 || !body.data) {
    throw new Error("eastmoney quote failed")
  }
  if (body.data.diff) {
    return asArray(body.data.diff).map(parseEastMoneyListRow).filter((quote) => quote.symbol && quote.price > 0)
  }
  const quote = parseEastMoneySingleRow(body.data)
  return quote.price > 0 ? [quote] : []
}

// Tencent packs one tilde-separated record per line. Field 35 carries the
// raw turnover for A-shares; field 37 is 万元 there and raw currency for US.
function parseTencentQuotes(text) {
  const quotes = []
  const pattern = /v_([A-Za-z0-9_]+)="([^"]*)"/g
  for (const match of String(text || "").matchAll(pattern)) {
    const symbol = match[1]
    const parts = match[2].split("~")
    const price = finiteNumber(parts[3])
    if (!(price > 0)) continue
    const slash = String(parts[35] || "").split("/")
    let amount = NaN
    if (slash.length >= 3 && finiteNumber(slash[2]) > 0) amount = finiteNumber(slash[2])
    else if (finiteNumber(parts[37]) > 0) {
      amount = symbol.toLowerCase().startsWith("us") ? finiteNumber(parts[37]) : finiteNumber(parts[37]) * 10000
    }
    const rawCode = String(parts[2] || "")
    quotes.push({
      symbol,
      code: rawCode.split(".")[0] || rawCode,
      name: parts[1] || "",
      price,
      prevClose: finiteNumber(parts[4]),
      open: finiteNumber(parts[5]),
      volume: finiteNumber(parts[6]),
      timeText: parts[30] || "",
      time: parseExchangeTime(parts[30], symbol),
      change: finiteNumber(parts[31]),
      changePercent: finiteNumber(parts[32]),
      high: finiteNumber(parts[33]),
      low: finiteNumber(parts[34]),
      amount,
      turnover: finiteNumber(parts[38]),
      pe: finiteNumber(parts[39]),
      currency: symbol.toLowerCase().startsWith("hk") ? "HKD" : symbol.toLowerCase().startsWith("us") ? "USD" : "CNY"
    })
  }
  return quotes
}

function parseYahooChart(payload, requestedSymbol, nowSeconds = Date.now() / 1000) {
  const body = typeof payload === "string" ? JSON.parse(payload) : payload
  const result = body && body.chart && Array.isArray(body.chart.result) ? body.chart.result[0] : null
  if (!result || !result.meta) {
    throw new Error(body && body.chart && body.chart.error ? "yahoo quote failed" : "yahoo quote missing")
  }
  const meta = result.meta
  const price = finiteNumber(meta.regularMarketPrice)
  const prevClose = finiteNumber(meta.chartPreviousClose ?? meta.previousClose)
  const change = finiteNumber(meta.regularMarketChange) || (price > 0 && prevClose > 0 ? price - prevClose : NaN)
  return {
    symbol: requestedSymbol || meta.symbol || "",
    code: String(meta.symbol || requestedSymbol || "").split(".")[0],
    name: meta.shortName || meta.longName || meta.symbol || "",
    price,
    change,
    changePercent: finiteNumber(meta.regularMarketChangePercent),
    open: finiteNumber(meta.regularMarketOpen),
    high: finiteNumber(meta.regularMarketDayHigh),
    low: finiteNumber(meta.regularMarketDayLow),
    prevClose,
    volume: finiteNumber(meta.regularMarketVolume),
    amount: NaN,
    turnover: NaN,
    pe: NaN,
    currency: meta.currency || "",
    time: finiteNumber(meta.regularMarketTime) || 0,
    timeText: "",
    extended: extendedSession(meta, nowSeconds)
  }
}

// extendedSession is the US pre-market or after-hours print. During the regular
// session it stays empty so the row keeps the regular price only.
function extendedSession(meta, nowSeconds) {
  const regular = finiteNumber(meta && meta.regularMarketPrice)
  const price = finiteNumber(meta && meta.fulldayPrice)
  if (!(regular > 0) || !(price > 0)) return null
  if (Math.abs(price - regular) < Math.max(0.01, regular * 0.00005)) return null
  const period = meta.currentTradingPeriod || {}
  const pre = period.pre || {}
  const regularPeriod = period.regular || {}
  const now = Number(nowSeconds) || 0
  if (now >= regularPeriod.start && now < regularPeriod.end) return null
  const session = now >= pre.start && now < pre.end ? "pre" : "post"
  return {
    session,
    price,
    change: finiteNumber(meta.fulldayChange),
    changePercent: finiteNumber(meta.fulldayChangePercent)
  }
}

function yahooSearchHit(hit) {
  const quoteType = String(hit.quoteType || "")
  if (quoteType && quoteType !== "EQUITY") return null
  const symbol = String(hit.symbol || "").toUpperCase()
  const name = hit.shortname || hit.longname || hit.shortName || symbol
  if (symbol.endsWith(".SS")) {
    const code = symbol.slice(0, -3)
    return { market: "a", code, name, quoteId: `1.${code}` }
  }
  if (symbol.endsWith(".SZ")) {
    const code = symbol.slice(0, -3)
    return { market: "a", code, name, quoteId: `0.${code}` }
  }
  if (symbol.endsWith(".HK")) {
    const code = symbol.slice(0, -3).replace(/\D/g, "").padStart(5, "0")
    return { market: "hk", code, name, quoteId: `116.${code}` }
  }
  if (/^[A-Z]{1,5}([.-][A-Z])?$/.test(symbol)) {
    return { market: "us", code: symbol, name, quoteId: "" }
  }
  return null
}

const PROVIDERS = {
  eastmoney: {
    id: "eastmoney",
    labelKey: "source_eastmoney",
    markets: ["a", "hk", "us"],
    symbolFor(instrument) {
      if (instrument.quoteId) return instrument.quoteId
      if (instrument.market === "a") {
        if (/^[69]/.test(instrument.code)) return `1.${instrument.code}`
        if (/^[03]/.test(instrument.code)) return `0.${instrument.code}`
      }
      if (instrument.market === "hk") return `116.${instrument.code}`
      return ""
    },
    pageUrl(instrument) {
      if (instrument.market === "hk") return `https://quote.eastmoney.com/hk/${instrument.code}.html`
      if (instrument.market === "us") return `https://quote.eastmoney.com/us/${instrument.code}.html`
      const prefix = this.symbolFor(instrument).startsWith("0.") ? "sz" : "sh"
      return `https://quote.eastmoney.com/${prefix}${instrument.code}.html`
    },
    async search(text, markets, fetchImpl) {
      const url = `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(text)}&type=14&count=30`
      const payload = JSON.parse(await fetchImpl(url))
      const rows = payload && payload.QuotationCodeTable ? payload.QuotationCodeTable.Data : []
      return selectSearchHits(rows, text, markets, MAX_SEARCH_RESULTS)
    },
    // stock/get is one symbol per call. The batch ulist endpoint was resetting
    // the connection, so a failed call can still fall through to the next source.
    async quotes(items, fetchImpl) {
      const results = await mapPool(items, 4, async (item) => {
        const url = `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(item.symbol)}&invt=2&fltt=2&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f162,f168,f169,f170`
        try {
          const parsed = parseEastMoneyQuotes(await fetchImpl(url))
          const quote = parsed[0]
          if (!quote || !(quote.price > 0)) return null
          return {
            ...quote,
            symbol: item.symbol,
            currency: quote.currency || currencyForMarket(item.market)
          }
        } catch (err) {
          return { error: err }
        }
      })
      const quotes = results.filter((quote) => quote && quote.price > 0)
      if (quotes.length) return quotes
      const failure = results.find((quote) => quote && quote.error)
      throw (failure && failure.error) || new Error("eastmoney quote failed")
    }
  },
  tencent: {
    id: "tencent",
    labelKey: "source_tencent",
    markets: ["a", "hk", "us"],
    symbolFor(instrument) {
      if (instrument.market === "a") {
        const prefix = instrument.quoteId.startsWith("0.") || /^[03]/.test(instrument.code) ? "sz" : "sh"
        return `${prefix}${instrument.code}`
      }
      if (instrument.market === "hk") return `hk${instrument.code}`
      if (instrument.market === "us") return `us${instrument.code}`
      return ""
    },
    pageUrl(instrument) {
      return `https://gu.qq.com/${this.symbolFor(instrument)}`
    },
    async quotes(items, fetchImpl) {
      const url = `https://qt.gtimg.cn/q=${items.map((item) => item.symbol).join(",")}`
      const parsed = parseTencentQuotes(await fetchImpl(url))
      const bySymbol = new Map(parsed.map((quote) => [quote.symbol.toLowerCase(), quote]))
      return items.map((item) => bySymbol.get(item.symbol.toLowerCase())).filter(Boolean)
    }
  },
  yahoo: {
    id: "yahoo",
    labelKey: "source_yahoo",
    markets: ["us", "hk", "a"],
    symbolFor(instrument) {
      if (instrument.market === "us") return instrument.code
      if (instrument.market === "hk") return `${String(Number(instrument.code)).padStart(4, "0")}.HK`
      if (instrument.market === "a") return `${instrument.code}.${instrument.quoteId.startsWith("0.") || /^[03]/.test(instrument.code) ? "SZ" : "SS"}`
      return ""
    },
    pageUrl(instrument) {
      return `https://finance.yahoo.com/quote/${encodeURIComponent(this.symbolFor(instrument))}`
    },
    async search(text, markets, fetchImpl) {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(text)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false`
      const payload = JSON.parse(await fetchImpl(url))
      const hits = asArray(payload && payload.quotes).map(yahooSearchHit).map(normalizeInstrument).filter(Boolean)
      const allowed = new Set(markets)
      return hits.filter((hit) => allowed.has(hit.market)).slice(0, MAX_SEARCH_RESULTS)
    },
    async quotes(items, fetchImpl) {
      const results = await mapPool(items, 4, async (item) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?interval=1d&range=1d&includePrePost=true`
        try {
          const quote = parseYahooChart(await fetchImpl(url), item.symbol)
          return quote.price > 0 ? quote : null
        } catch (err) {
          return { error: err }
        }
      })
      const quotes = results.filter((quote) => quote && quote.price > 0)
      if (quotes.length) return quotes
      const failure = results.find((quote) => quote && quote.error)
      throw (failure && failure.error) || new Error("yahoo quote failed")
    }
  }
}

async function mapPool(items, limit, worker) {
  const output = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return output
}

// quotesWithFallback prices each instrument with that market's source list.
// A source is skipped when it has no symbol, throws, or omits the symbol.
function quotesWithFallback(instruments, options) {
  const resolved = new Map()
  const groups = new Map()
  for (const instrument of instruments) {
    const list = groups.get(instrument.market) || []
    list.push(instrument)
    groups.set(instrument.market, list)
  }
  const jobs = []
  for (const [market, items] of groups) {
    jobs.push(fillMarketQuotes(market, items, resolved, options))
  }
  return Promise.all(jobs).then(() => instruments.map((instrument) => resolved.get(instrumentKey(instrument)) || null))
}

async function fillMarketQuotes(market, items, resolved, options) {
  let rest = items.slice()
  for (const providerId of options.order[market] || []) {
    if (!rest.length) break
    const provider = options.providers[providerId]
    if (!provider || typeof provider.quotes !== "function" || !provider.markets.includes(market)) continue
    const fetchItems = []
    const skipped = []
    for (const instrument of rest) {
      const symbol = provider.symbolFor(instrument)
      if (!symbol) {
        skipped.push(instrument)
        continue
      }
      const cached = options.cache.get(quoteCacheKey(providerId, symbol), options.now)
      if (cached) {
        resolved.set(instrumentKey(instrument), cached)
        continue
      }
      fetchItems.push({ instrument, symbol })
    }
    rest = skipped
    if (!fetchItems.length) continue
    try {
      const quotes = await provider.quotes(fetchItems.map((row) => ({ ...row.instrument, symbol: row.symbol })), options.fetchImpl)
      const bySymbol = new Map()
      for (const quote of quotes) {
        if (quote && quote.symbol && quote.price > 0) bySymbol.set(quote.symbol, quote)
      }
      const missed = []
      for (const row of fetchItems) {
        const quote = bySymbol.get(row.symbol)
        if (!quote) {
          missed.push(row.instrument)
          continue
        }
        const stored = {
          ...quote,
          providerId,
          symbol: row.symbol,
          market: row.instrument.market,
          quoteId: row.instrument.quoteId || "",
          code: row.instrument.code,
          name: quote.name || row.instrument.name,
          pageUrl: provider.pageUrl(row.instrument)
        }
        options.cache.set(quoteCacheKey(providerId, row.symbol), stored, options.now)
        resolved.set(instrumentKey(row.instrument), stored)
      }
      rest = rest.concat(missed)
    } catch (err) {
      if (options.onError) options.onError(providerId, market, err)
      rest = rest.concat(fetchItems.map((row) => row.instrument))
    }
  }
}

// searchWithFallback returns the first source that finds an A-share, Hong Kong,
// or US equity. An empty list tries the next source, because one feed can miss
// an English company name that another feed has. A thrown source is skipped too.
async function searchWithFallback(text, markets, options) {
  const failures = []
  for (const providerId of options.searchOrder) {
    const provider = options.providers[providerId]
    if (!provider || typeof provider.search !== "function") continue
    const covered = markets.filter((market) => provider.markets.includes(market))
    if (!covered.length) continue
    const cacheKey = `search:${providerId}:${covered.join(",")}:${text.toLowerCase()}`
    const cached = options.cache.get(cacheKey, options.now)
    if (cached) return { providerId, instruments: cached.filter((item) => markets.includes(item.market)) }
    try {
      const instruments = (await provider.search(text, covered, options.fetchImpl) || []).map(normalizeInstrument).filter(Boolean)
      if (!instruments.length) continue
      options.cache.set(cacheKey, instruments, options.now)
      return { providerId, instruments }
    } catch (err) {
      failures.push(`${providerId}: ${err && err.message ? err.message : err}`)
      if (options.onError) options.onError(providerId, covered.join(","), err)
    }
  }
  const inferred = inferInstrument(text)
  if (inferred && markets.includes(inferred.market)) return { providerId: "symbol", instruments: [inferred] }
  if (failures.length) throw new Error(failures.join("; "))
  return { providerId: "", instruments: [] }
}


module.exports = { QUOTE_TTL_MS, MARKET_PROVIDER_ORDER, SEARCH_PROVIDER_ORDER, PROVIDERS, TtlCache, quoteCacheKey, httpGet, mapPool, quotesWithFallback, searchWithFallback, extendedSession, parseExchangeTime, parseEastMoneyQuotes, parseTencentQuotes, parseYahooChart, yahooSearchHit }
