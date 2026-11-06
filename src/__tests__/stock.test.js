const { StockPlugin } = require("../stock")
const { normalizeWatchlist, addWatchItem } = require("../instruments")
const { quotesWithFallback, TtlCache } = require("../providers")

const ctx = {}
const instrument = { market: "hk", code: "00700", name: "Tencent", quoteId: "116.00700" }

test("watchlist normalizes codes and avoids duplicates", () => {
  const list = normalizeWatchlist(JSON.stringify([{ market: "hk", code: "700", name: "Tencent" }]))
  expect(list[0].code).toBe("00700")
  expect(addWatchItem(list, instrument).reason).toBe("exists")
})

test("quotes fall back and cache by provider and symbol", async () => {
  const failing = { markets: ["hk"], symbolFor: () => "first", quotes: jest.fn().mockRejectedValue(new Error("offline")) }
  const fallback = { markets: ["hk"], symbolFor: () => "second", pageUrl: () => "https://example.com", quotes: jest.fn().mockResolvedValue([{ symbol: "second", price: 100 }]) }
  const options = { providers: { failing, fallback }, order: { hk: ["failing", "fallback"] }, cache: new TtlCache(60000), now: 1000 }
  expect((await quotesWithFallback([instrument], options))[0]).toMatchObject({ price: 100, providerId: "fallback" })
  expect((await quotesWithFallback([instrument], options))[0].price).toBe(100)
  expect(fallback.quotes).toHaveBeenCalledTimes(1)
})

test("SDK query, watchlist actions, and MRU restore preserve identity", async () => {
  const stock = new StockPlugin()
  const api = {
    GetSetting: jest.fn().mockResolvedValue("[]"),
    SaveSetting: jest.fn().mockResolvedValue(undefined),
    OnMRURestore: jest.fn().mockResolvedValue(undefined),
    RegisterPluginTool: jest.fn().mockResolvedValue({}),
    Notify: jest.fn().mockResolvedValue(undefined)
  }
  await stock.init(ctx, { API: api })
  expect(api.RegisterPluginTool).toHaveBeenCalledTimes(5)
  expect((await stock.query(ctx, { Search: "" })).Results[0].Title).toBe("i18n:empty_watchlist_title")
  stock.search = jest.fn().mockResolvedValue({ instruments: [instrument] })
  stock.quotes = jest.fn().mockResolvedValue([{ providerId: "tencent", price: 100, change: 2, changePercent: 2, time: 0 }])
  const result = (await stock.query(ctx, { Search: "700" })).Results[0]
  expect(result.IdentityKey).toBe("stock:hk:00700")
  expect(result.Tails[0].Tooltip).toBe("100.00")
  const add = result.Actions.find((action) => action.Name === "i18n:action_add")
  await add.Action(ctx)
  expect(JSON.parse(api.SaveSetting.mock.calls[0][2])[0].code).toBe("00700")
  const restored = await stock.restoreResult(ctx, { ContextData: add.ContextData })
  expect(restored.IdentityKey).toBe(result.IdentityKey)
  expect(restored.Actions.find(action => action.Name === "i18n:action_remove")).toBeDefined()
  expect(restored.Actions[0].Id).not.toBe(add.Id)
  stock.stopWatchlistRefresh()
})

test("quote badge widths follow the longest value in each result column", async () => {
  const stock = new StockPlugin()
  stock.tailColor = "#123456"
  const secondInstrument = { ...instrument, code: "00001", quoteId: "116.00001" }
  const firstQuote = { providerId: "tencent", price: 100, change: 2, changePercent: 2, time: 0 }
  const secondQuote = { ...firstQuote, price: 12345.67, change: -1, changePercent: -17.26, extended: { session: "pre", change: 1, changePercent: 7.15 } }
  stock.search = jest.fn().mockResolvedValue({ instruments: [instrument, secondInstrument] })
  stock.quotes = jest.fn().mockResolvedValue([firstQuote, secondQuote])
  stock.api = { UpdateResult: jest.fn().mockResolvedValue(true) }
  const rows = (await stock.query(ctx, { Search: "test" })).Results
  const widths = rows[0].Tails.map(tail => tail.ImageWidth)
  expect(rows[1].Tails.map(tail => tail.ImageWidth)).toEqual(widths)
  expect(widths[0]).toBeGreaterThan(50)
  expect(widths[1]).toBeGreaterThan(40)
  expect(widths[2]).toBe(89)
  expect(rows[0].Tails.map(tail => tail.Tooltip)).toEqual(["100.00", "+2.00%", ""])
  expect(rows[1].Tails.map(tail => tail.Tooltip)).toEqual(["12345.67", "-17.26%", "Pre +7.15%"])
  expect(rows[0].Tails[0].Image.ImageData).toContain('#123456')
  expect(rows[0].Tails[0].Image.ImageData).toContain('>100.00</text>')
  expect(rows[0].Tails[2].Image.ImageData).not.toContain('<rect')
  expect(rows[1].Tails[2].Image.ImageData).toContain('translate(5 5)')
  expect(rows[1].Tails[2].Image.ImageData).toContain('&#8203;     Pre +7.15%</text>')

  stock.watchlist = [instrument]
  stock.watchlistQuotes.set(instrument.quoteId, { ...firstQuote, price: 123456789.12 })
  await stock.publishVisibleQuotes()
  const updates = stock.api.UpdateResult.mock.calls.map(call => call[1])
  expect(updates).toHaveLength(2)
  expect(updates[0].Tails[0].ImageWidth).toBeGreaterThan(widths[0])
  expect(updates[1].Tails[0].ImageWidth).toBe(updates[0].Tails[0].ImageWidth)
})

test("unused badge columns take no space and labels remain unscaled", async () => {
  const stock = new StockPlugin()
  stock.search = jest.fn().mockResolvedValue({ instruments: [instrument] })
  stock.quotes = jest.fn().mockResolvedValue([{ providerId: "tencent", price: 2, change: 0, changePercent: null }])
  const result = (await stock.query(ctx, { Search: "test" })).Results[0]
  expect(result.Tails).toHaveLength(1)
  expect(result.Tails[0].ImageWidth).toBeLessThan(50)
  expect(result.Tails[0].Image.ImageData).toContain('font-size="11"')
})

test("failed setting writes leave the watchlist unchanged", async () => {
  const stock = new StockPlugin()
  stock.api = { SaveSetting: jest.fn().mockRejectedValue(new Error("failed")) }
  expect(await stock.persistWatchlist(ctx, [instrument])).toBe(false)
  expect(stock.watchlist).toEqual([])
})
test("original plugin identity and saved watchlist are retained", async () => {
  const manifest = require("../../plugin.json")
  expect(manifest.Id).toBe("074ff6c9-50d1-4c26-9583-c6e48b3c48f2")
  expect(manifest.SettingDefinitions[0].Value.Key).toBe("watchlist")
  const stock = new StockPlugin()
  stock.refreshWatchlist = jest.fn().mockResolvedValue(undefined)
  const api = { GetSetting: jest.fn().mockResolvedValue(JSON.stringify([instrument])) }
  await stock.init(ctx, { API: api })
  expect(api.GetSetting).toHaveBeenCalledWith(ctx, "watchlist")
  expect((await stock.query(ctx, { Search: "" })).Results[0].IdentityKey).toBe("stock:hk:00700")
  stock.stopWatchlistRefresh()
})

test("registered stock tools invoke shared search and watchlist operations", async () => {
  const stock = new StockPlugin()
  const registered = new Map()
  const api = {
    GetSetting: jest.fn().mockResolvedValue("[]"),
    SaveSetting: jest.fn().mockResolvedValue(undefined),
    RegisterPluginTool: jest.fn(async (_ctx, registration) => { registered.set(registration.Tool.Name, registration.Handler); return {} })
  }
  await stock.init(ctx, { API: api })
  stock.search = jest.fn().mockResolvedValue({ providerId: "eastmoney", instruments: [instrument] })
  expect((await registered.get("search_stocks")(ctx, { Arguments: { text: "700", market: "hk" } })).Output.instruments).toEqual([instrument])
  expect((await registered.get("add_watchlist")(ctx, { Arguments: instrument })).Output.added).toBe(true)
  expect((await registered.get("list_watchlist")(ctx, { Arguments: {} })).Output.instruments).toHaveLength(1)
  expect((await registered.get("remove_watchlist")(ctx, { Arguments: instrument })).Output.removed).toBe(true)
  stock.stopWatchlistRefresh()
})
