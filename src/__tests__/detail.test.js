const { getHistory } = require("../history")
const { createDetail } = require("../detail")
const { StockPlugin } = require("../stock")
const fs = require("fs/promises")
const os = require("os")
const path = require("path")

const instrument = { market: "hk", code: "00700", name: "Tencent", quoteId: "116.00700" }
const ctx = {}
function response() { return JSON.stringify({ chart: { result: [{ meta: { exchangeTimezoneName: "Asia/Hong_Kong" }, timestamp: [1, 2, 3, 4], indicators: { quote: [{ close: [10, null, 11, 12] }] } }] } }) }

test("history converts market symbols and ignores missing samples", async () => {
  const fetch = jest.fn().mockResolvedValue(response())
  const history = await getHistory(instrument, "intraday", fetch)
  expect(fetch.mock.calls[0][0]).toContain("0700.HK?range=1d&interval=5m")
  expect(history.points.map(point => point.price)).toEqual([10, 11, 12])
  await expect(getHistory(instrument, "invalid", fetch)).rejects.toThrow()
  await expect(getHistory(instrument, "day", async () => "{}")).rejects.toThrow()
})

test("period choices request their matching history ranges", async () => {
  const fetch = jest.fn().mockResolvedValue(response())
  for (const [period, query] of [["intraday", "range=1d&interval=5m"], ["week", "range=5d&interval=30m"], ["month", "range=1mo&interval=1d"], ["year", "range=1y&interval=1d"]]) {
    await getHistory(instrument, period, fetch)
    expect(fetch.mock.calls.at(-1)[0]).toContain(query)
  }
})

test("chart follows quote direction and displays currency", async () => {
  const stock = { fetchImpl: jest.fn().mockResolvedValue(response()), api: { UpdateResult: jest.fn().mockResolvedValue(true) } }
  for (const [change, color] of [[1, "$success"], [-1, "$error"], [0, "$text"]]) {
    const quote = { price: 12, change, changePercent: change, currency: "HKD" }
    const detail = createDetail(stock, instrument, quote, "stock", "en_US")
    await detail.Preview.OnWoxViewEvent(ctx, { Type: "show" })
    const content = JSON.parse(stock.api.UpdateResult.mock.calls.at(-1)[1].Preview.PreviewData).root.children[0]
    const chart = content.children[2].children[1]
    expect(chart.props.style.color).toBe(color)
    expect(chart.props.chart.valueSuffix).toBe(" HKD")
    expect(content.children[0].children[2].children[1].props.text).toBe(`${change > 0 ? "+" : ""}${change.toFixed(2)} (${change > 0 ? "+" : ""}${change.toFixed(2)}%)`)
  }
})

test("detail returns a loading preview before fetching, then renders history and logo on show", async () => {
  let finishHistory, finishLogo
  const stock = new StockPlugin({
    fetchImpl: jest.fn().mockImplementationOnce(() => new Promise(resolve => { finishHistory = resolve })).mockResolvedValue(response()),
    fetchLogo: jest.fn().mockImplementation(() => new Promise(resolve => { finishLogo = resolve }))
  })
  stock.api = { ChangeQuery: jest.fn(), UpdateResult: jest.fn().mockResolvedValue(true) }
  stock.queryRaw = "stock 700"
  const quote = { providerId: "tencent", price: 12, change: 1, changePercent: 2, currency: "HKD" }
  const result = stock.quoteResult(instrument, quote, {}, 100, "stock 700")
  await result.Actions.find(item => item.IsDefault).Action(ctx)
  const change = stock.api.ChangeQuery.mock.calls[0][1]
  stock.cachedQuote = () => quote
  const details = await stock.query(ctx, { RawQuery: change.QueryText, TriggerKeyword: "stock", Command: "detail", Search: "00700", ContextData: change.ContextData })
  expect(details.Layout.ResultPreviewWidthRatio).toBe(0)
  const preview = details.Results[0].Preview
  expect(preview.PreviewType).toBe("woxview")
  const loadingTree = JSON.parse(preview.PreviewData).root
  expect(loadingTree.props.style.alignItems).toBe("stretch")
  const loadingArea = loadingTree.children[0].children[2]
  expect(loadingArea.props.style).toMatchObject({ height: 260, alignItems: "stretch", justifyContent: "center" })
  expect(loadingArea.children[0].props.style.justifyContent).toBe("center")
  expect(loadingArea.children[0].children[0]).toEqual({ type: "loading", props: { style: { width: 32, height: 32 } } })
  expect(preview.PreviewData).not.toContain("Loading history")
  expect(stock.fetchImpl).not.toHaveBeenCalled()
  expect(stock.fetchLogo).not.toHaveBeenCalled()
  const pending = preview.OnWoxViewEvent(ctx, { Type: "show" })
  expect(stock.fetchImpl).toHaveBeenCalledTimes(1)
  expect(stock.fetchLogo).toHaveBeenCalledTimes(1)
  finishHistory(response())
  finishLogo({ imageType: "base64", imageData: "data:image/png;base64,dGVzdA==" })
  await pending
  const rendered = stock.api.UpdateResult.mock.calls.at(-1)[1].Preview
  expect(rendered.WoxViewID).toBe(preview.WoxViewID)
  expect(rendered.PreviewData).toContain('"type":"line-chart"')
  expect(rendered.PreviewData).toContain('"values":[10,11,12]')
  expect(rendered.PreviewData).toContain('"pointLabels":')
  expect(rendered.PreviewData).toContain('data:image/png;base64,dGVzdA==')
  stock.api.UpdateResult.mockClear()
  await preview.OnWoxViewEvent(ctx, { Handler: "period", Args: ["week"] })
  expect(stock.fetchImpl.mock.calls[1][0]).toContain("range=5d&interval=30m")
  expect(stock.api.UpdateResult.mock.calls[0][1].Preview.PreviewData).toContain('"type":"loading"')
  expect(stock.api.UpdateResult.mock.calls[1][1].Preview.PreviewData).toContain('"value":"week"')
  await details.Results[0].Actions[0].Action(ctx)
  expect(stock.api.ChangeQuery.mock.calls[1][1]).toEqual({ QueryType: "input", QueryText: "stock 700" })
})

test("missing quote loads after show and failures leave an actionable chart error", async () => {
  const stock = { fetchImpl: jest.fn().mockRejectedValue(new Error("offline")), quotes: jest.fn().mockResolvedValue([{ name: "Tencent", price: 12, change: 1, changePercent: 2, currency: "HKD" }]), api: { UpdateResult: jest.fn().mockResolvedValue(true) } }
  const detail = createDetail(stock, instrument, null, "stock", "en_US")
  expect(stock.quotes).not.toHaveBeenCalled()
  expect(detail.Preview.PreviewData).toContain('"type":"loading"')
  await detail.Preview.OnWoxViewEvent(ctx, { Type: "show" })
  expect(stock.quotes).toHaveBeenCalledTimes(1)
  let rendered = stock.api.UpdateResult.mock.calls.at(-1)[1].Preview.PreviewData
  expect(rendered).toContain("History unavailable")
  expect(rendered).toContain("12.00 HKD")
  expect(rendered).not.toContain('"type":"line-chart"')
  await detail.Preview.OnWoxViewEvent(ctx, { Handler: "period", Args: ["month"] })
  rendered = stock.api.UpdateResult.mock.calls.at(-1)[1].Preview.PreviewData
  expect(rendered).toContain("History unavailable")
})

test("hiding prevents late updates and showing again retries interrupted loading", async () => {
  let finish
  const fetch = jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(response())
  const stock = { fetchImpl: fetch, api: { UpdateResult: jest.fn().mockResolvedValue(true) } }
  const detail = createDetail(stock, instrument, null, "stock", "en_US")
  const pending = detail.Preview.OnWoxViewEvent(ctx, { Type: "show" })
  await Promise.resolve()
  await detail.Preview.OnWoxViewEvent(ctx, { Type: "hide" })
  stock.api.UpdateResult.mockClear()
  finish(response())
  await pending
  expect(stock.api.UpdateResult).not.toHaveBeenCalled()
  await detail.Preview.OnWoxViewEvent(ctx, { Type: "show" })
  expect(stock.api.UpdateResult.mock.calls.at(-1)[1].Preview.PreviewData).toContain('"type":"line-chart"')
})

test("switching periods ignores a late response from the previous period", async () => {
  let finish
  const stock = { fetchImpl: jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(response()), api: { UpdateResult: jest.fn().mockResolvedValue(true) } }
  const detail = createDetail(stock, instrument, null, "stock", "en_US")
  const initial = detail.Preview.OnWoxViewEvent(ctx, { Type: "show" })
  await detail.Preview.OnWoxViewEvent(ctx, { Handler: "period", Args: ["week"] })
  stock.api.UpdateResult.mockClear()
  finish(response())
  await initial
  expect(stock.api.UpdateResult).not.toHaveBeenCalled()
})

test("detail shows a company logo and time ticks, and caches the logo", async () => {
  const stock = { fetchImpl: jest.fn().mockResolvedValue(response()), fetchLogo: jest.fn().mockResolvedValue({ imageType: "base64", imageData: "data:image/png;base64,dGVzdA==" }), logoCache: new Map(), api: { UpdateResult: jest.fn().mockResolvedValue(true) } }
  const first = createDetail(stock, instrument, null, "stock", "en_US")
  await first.Preview.OnWoxViewEvent(ctx, { Type: "show" })
  const root = JSON.parse(stock.api.UpdateResult.mock.calls.at(-1)[1].Preview.PreviewData).root.children[0]
  expect(root.children).toHaveLength(3)
  expect(root.children[0].children[0].props.source.imageType).toBe("base64")
  const chart = root.children[2].children.find(node => node.type === "line-chart")
  expect(chart.props.pointLabels).toEqual(["08:00", "08:00", "08:00"])
  expect(root.children[1].props.style).toMatchObject({ width: 220, alignSelf: "start", borderColor: "$border", borderWidth: 1 })
  expect(root.children[1].children[0].props.items.map(item => item.label)).toEqual(["1D", "1W", "1M", "1Y"])
  expect(chart.props.chart).toMatchObject({ showGrid: true, showXAxis: true, yAxis: "right", fill: true, tooltipPosition: "floating" })
  expect(root.children[2].children).toHaveLength(2)
  const second = createDetail(stock, instrument, null, "stock", "en_US")
  expect(second.Preview.PreviewData).toContain("data:image/png;base64,dGVzdA==")
  await second.Preview.OnWoxViewEvent(ctx, { Type: "show" })
  expect(stock.fetchLogo).toHaveBeenCalledTimes(1)
  expect(stock.api.UpdateResult.mock.calls.at(-1)[1].Preview.PreviewData).toContain("data:image/png;base64,dGVzdA==")
})

test("a saved logo is present in the initial preview after plugin restart", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "wox-stock-logo-"))
  const logo = { imageType: "base64", imageData: `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("base64")}` }
  const api = { GetCacheFolder: jest.fn().mockResolvedValue(folder), UpdateResult: jest.fn().mockResolvedValue(true) }
  const makePlugin = async (fetchLogo) => {
    const stock = new StockPlugin({ fetchImpl: jest.fn().mockResolvedValue(response()), fetchLogo })
    await stock.init(ctx, { API: api })
    stock.search = jest.fn().mockResolvedValue({ instruments: [instrument] })
    stock.quotes = jest.fn().mockResolvedValue([])
    return stock
  }
  const query = { RawQuery: "stock detail 00700", TriggerKeyword: "stock", Command: "detail", Search: "00700" }
  let first, second, third
  try {
    first = await makePlugin(jest.fn().mockResolvedValue(logo))
    const initial = (await first.query(ctx, query)).Results[0].Preview
    expect(initial.PreviewData).not.toContain(logo.imageData)
    await initial.OnWoxViewEvent(ctx, { Type: "show" })

    const fetchAgain = jest.fn().mockRejectedValue(new Error("offline"))
    second = await makePlugin(fetchAgain)
    const restored = (await second.query(ctx, query)).Results[0].Preview
    expect(restored.PreviewData).toContain(logo.imageData)
    await restored.OnWoxViewEvent(ctx, { Type: "show" })
    expect(fetchAgain).not.toHaveBeenCalled()
    expect(api.GetCacheFolder).toHaveBeenCalledTimes(2)

    const [file] = await fs.readdir(folder)
    await fs.writeFile(path.join(folder, file), "corrupt")
    const retry = jest.fn().mockResolvedValue(logo)
    third = await makePlugin(retry)
    const fallback = (await third.query(ctx, query)).Results[0].Preview
    expect(fallback.PreviewData).not.toContain(logo.imageData)
    await fallback.OnWoxViewEvent(ctx, { Type: "show" })
    expect(retry).toHaveBeenCalledTimes(1)
  } finally {
    first?.stopWatchlistRefresh()
    second?.stopWatchlistRefresh()
    third?.stopWatchlistRefresh()
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test("logo failures fall back to the stock icon", async () => {
  const stock = { fetchImpl: jest.fn().mockResolvedValue(response()), fetchLogo: jest.fn().mockRejectedValue(new Error("offline")), logoCache: new Map(), api: { UpdateResult: jest.fn().mockResolvedValue(true) } }
  const detail = createDetail(stock, instrument, null, "stock", "en_US")
  await detail.Preview.OnWoxViewEvent(ctx, { Type: "show" })
  expect(JSON.parse(stock.api.UpdateResult.mock.calls.at(-1)[1].Preview.PreviewData).root.children[0].children[0].children[0].props.source.imageType).toBe("svg")
})

test("detail command resolves names and codes without hidden context", async () => {
  const stock = new StockPlugin({ fetchImpl: jest.fn().mockResolvedValue(response()), fetchLogo: jest.fn().mockResolvedValue(null) })
  stock.api = { ChangeQuery: jest.fn() }
  stock.search = jest.fn().mockResolvedValue({ instruments: [instrument] })
  stock.cachedQuote = () => ({ providerId: "tencent", price: 12, change: 1, changePercent: 2, currency: "HKD" })
  for (const term of ["Apple", "腾讯", "00700"]) {
    const detail = await stock.query(ctx, { RawQuery: `stock detail ${term}`, TriggerKeyword: "stock", Command: "detail", Search: term })
    expect(detail.Layout.ResultPreviewWidthRatio).toBe(0)
    expect(detail.Results[0].Preview.PreviewType).toBe("woxview")
    expect(stock.search).toHaveBeenLastCalledWith(term, ["a", "hk", "us"])
    await detail.Results[0].Actions[0].Action(ctx)
    expect(stock.api.ChangeQuery).toHaveBeenLastCalledWith(ctx, { QueryType: "input", QueryText: `stock ${term}` })
  }
})

test("detail command prompts for an argument and reports no matches", async () => {
  const stock = new StockPlugin({ fetchLogo: jest.fn() })
  stock.api = {}
  stock.search = jest.fn().mockResolvedValue({ instruments: [] })
  for (const query of [{ RawQuery: "stock detail ", Command: "detail", Search: "" }, { RawQuery: "stock detail", Command: "", Search: "detail" }]) {
    const result = await stock.query(ctx, query)
    expect(result.Results[0].Title).toBe("i18n:detail_prompt_title")
  }
  expect(stock.search).not.toHaveBeenCalled()
  const missing = await stock.query(ctx, { RawQuery: "stock detail unknown", Command: "detail", Search: "unknown" })
  expect(missing.Results[0].Title).toBe("i18n:empty_title")
})
