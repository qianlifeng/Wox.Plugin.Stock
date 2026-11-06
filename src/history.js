const { PROVIDERS } = require("./providers")

const PERIODS = {
  intraday: { range: "1d", interval: "5m" },
  week: { range: "5d", interval: "30m" },
  month: { range: "1mo", interval: "1d" },
  year: { range: "1y", interval: "1d" }
}

async function getHistory(instrument, period, fetchImpl) {
  const options = PERIODS[period]
  const symbol = PROVIDERS.yahoo.symbolFor(instrument)
  if (!options || !symbol) throw new Error("Unsupported chart request")
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${options.range}&interval=${options.interval}`
  const body = JSON.parse(await fetchImpl(url))
  const result = body?.chart?.result?.[0]
  const close = result?.indicators?.quote?.[0]?.close
  if (!Array.isArray(result?.timestamp) || !Array.isArray(close)) throw new Error("Historical prices unavailable")
  const points = result.timestamp.flatMap((time, index) => {
    const price = close[index]
    return Number.isFinite(time) && typeof price === "number" && Number.isFinite(price) && price > 0 ? [{ time, price }] : []
  })
  if (!points.length) throw new Error("Historical prices unavailable")
  return { points, timezone: result.meta?.exchangeTimezoneName || "UTC" }
}

module.exports = { PERIODS, getHistory }
