const { randomUUID } = require("crypto")
const { PERIODS, getHistory } = require("./history")
const { quoteIcon } = require("./presentation")
const { saveLogo } = require("./logo")

const labels = {
  en_US: { price: "Price", error: "History unavailable. Select a period to retry.", missing: "Quote unavailable" },
  zh_CN: { price: "价格", error: "走势暂不可用，请选择周期重试。", missing: "暂无报价" }
}
const periodLabels = { intraday: "1D", week: "1W", month: "1M", year: "1Y" }

function text(value, style = {}) { return { type: "text", props: { text: String(value), style } } }
function row(children, style = {}) { return { type: "row", props: { style }, children } }
function column(children, style = {}) { return { type: "column", props: { style }, children } }
function number(value, signed = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}`
}
function dateLabel(time, timezone, period) {
  const options = period === "intraday" ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : period === "week" ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { year: "numeric", month: "2-digit", day: "2-digit" }
  try { return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: timezone }).format(new Date(time * 1000)) }
  catch { return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(new Date(time * 1000)) }
}

function tree(instrument, quote, state, t) {
  const color = quote?.change > 0 ? "$success" : quote?.change < 0 ? "$error" : "$text"
  const icon = quoteIcon(quote?.change || 0)
  const image = state.logo || { imageType: icon.ImageType, imageData: icon.ImageData }
  const header = row([
    { type: "image", props: { source: image, style: { width: 42, height: 42 } } },
    column([text(quote?.name || instrument.name, { fontSize: 20, fontWeight: "semibold", maxLines: 2 }), text(`${instrument.code} · ${instrument.market.toUpperCase()}`, { color: "$textSecondary", fontSize: 12 })], { flex: 1, gap: 5 }),
    column([text(quote ? `${number(quote.price)} ${quote.currency || ""}` : t.missing, { fontSize: 22, fontWeight: "semibold" }), text(quote ? `${number(quote.change, true)} (${number(quote.changePercent, true)}%)` : "", { color, fontSize: 13 })], { gap: 4, alignItems: "end" })
  ], { gap: 12, alignItems: "center" })
  const tabs = { type: "tabs", key: "period", props: { value: state.period, items: Object.keys(PERIODS).map(value => ({ value, label: periodLabels[value] })), style: { flex: 1 }, onChange: { $handler: "period" } } }
  let chart
  if (state.loading || state.error || !state.history) {
    chart = column([row([state.loading ? { type: "loading", props: { style: { width: 32, height: 32 } } } : text(t.error, { color: "$textSecondary" })], { justifyContent: "center" })], { height: 260, justifyContent: "center", alignItems: "stretch" })
  } else {
    const { points, timezone } = state.history
    chart = column([
      row([text(t.price, { color: "$textSecondary", fontSize: 12 })], { justifyContent: "end" }),
      { type: "line-chart", key: "chart", props: {
        label: t.price,
        values: points.map(point => point.price),
        pointLabels: points.map(point => dateLabel(point.time, timezone, state.period)),
        style: { height: 260, color },
        chart: { showGrid: true, gridLines: 8, showXAxis: true, xTicks: 10, yAxis: "right", yAxisWidth: 100, fill: true, tooltipPosition: "floating", valueSuffix: quote?.currency ? ` ${quote.currency}` : "" }
      } }
    ], { gap: 6, alignItems: "stretch" })
  }
  const periodControl = row([tabs], { width: 220, alignSelf: "start", padding: 2, borderColor: "$border", borderWidth: 1, borderRadius: 9 })
  const content = column([header, periodControl, chart], { padding: 20, gap: 18, alignItems: "stretch", borderColor: "$border", borderWidth: 1, borderRadius: 14 })
  return { version: 1, root: { type: "scroll", props: { style: { alignItems: "stretch" } }, children: [content] } }
}

function createDetail(plugin, instrument, quote, rawQuery, language) {
  const t = labels[language] || labels.en_US
  const id = `detail:${instrument.market}:${instrument.code}`
  const document = randomUUID()
  const key = `${instrument.market}:${instrument.code}`
  const state = { period: "intraday", history: null, loading: true, error: false, generation: 0, logo: plugin.logoCache?.get(key) }
  const cache = new Map()
  const preview = () => ({ PreviewType: "woxview", PreviewData: JSON.stringify(tree(instrument, quote, state, t)), WoxViewID: document, OnWoxViewEvent: onEvent })
  async function publish(eventCtx) { await plugin.api.UpdateResult(eventCtx, { Id: id, Preview: preview() }) }
  async function load(period) {
    if (cache.has(period)) return cache.get(period)
    const value = await getHistory(instrument, period, plugin.fetchImpl)
    cache.set(period, value)
    return value
  }
  let visible = false, visibility = 0
  async function loadChart(eventCtx, period, showLoading) {
    const generation = ++state.generation
    state.period = period
    state.loading = true
    state.error = false
    state.history = null
    if (showLoading) await publish(eventCtx)
    if (!visible || generation !== state.generation) return
    try {
      const history = await load(period)
      if (!visible || generation !== state.generation) return
      state.history = history
    } catch {
      if (!visible || generation !== state.generation) return
      state.error = true
    }
    state.loading = false
    await publish(eventCtx)
  }
  async function loadHeader(eventCtx, currentVisibility) {
    const logo = async () => {
      if (!plugin.fetchLogo) return null
      if (plugin.logoCache?.has(key)) return plugin.logoCache.get(key)
      try {
        const value = await plugin.fetchLogo(instrument)
        if (value) {
          plugin.logoCache?.set(key, value)
          await saveLogo(plugin.cacheFolder, instrument, value)
        }
        return value
      } catch { return null }
    }
    const getQuote = async () => {
      if (quote || !plugin.quotes) return quote
      try { return (await plugin.quotes([instrument]))[0] || null } catch { return null }
    }
    const [newLogo, newQuote] = await Promise.all([logo(), getQuote()])
    if (!visible || currentVisibility !== visibility) return
    state.logo = newLogo
    quote = newQuote
    await publish(eventCtx)
  }
  async function onEvent(eventCtx, event) {
    if (event.Type === "hide") {
      visible = false
      visibility++
      state.generation++
      return
    }
    if (event.Type === "show") {
      if (visible) return
      visible = true
      const currentVisibility = ++visibility
      await Promise.all([
        loadHeader(eventCtx, currentVisibility),
        state.loading ? loadChart(eventCtx, state.period, false) : Promise.resolve()
      ])
      return
    }
    if (event.Type || event.Handler !== "period" || !PERIODS[event.Args?.[0]]) return
    await loadChart(eventCtx, event.Args[0], true)
  }
  return { Id: id, Title: quote?.name || instrument.name, Icon: quoteIcon(quote?.change || 0), Preview: preview(), Actions: [{
    Name: `i18n:action_back`, IsDefault: true, PreventHideAfterAction: true,
    Action: async (eventCtx) => {
      visible = false
      visibility++
      state.generation++
      await plugin.api.ChangeQuery(eventCtx, { QueryType: "input", QueryText: rawQuery })
    }
  }] }
}

module.exports = { createDetail, tree }
