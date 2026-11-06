const { randomUUID } = require("crypto")
const { I18n: I18N } = require("../plugin.json")
const { MARKETS, instrumentKey, sameInstrument, normalizeInstrument, normalizeWatchlist, addWatchItem, removeWatchItem } = require("./instruments")
const { QUOTE_TTL_MS, MARKET_PROVIDER_ORDER, SEARCH_PROVIDER_ORDER, PROVIDERS, TtlCache, quoteCacheKey, httpGet, mapPool, quotesWithFallback, searchWithFallback, extendedSession } = require("./providers")
const { ACTION_COPY_ICON, ACTION_OPEN_ICON, ACTION_ADD_ICON, ACTION_DELETE_ICON, SORT_DEFAULT, SORT_CHANGE_DESC, SORT_CHANGE_ASC, primaryHotkey, selectedSort, orderQuoteRows, queryText, formatRelativeTime, badgeSVG, quoteBadgeTexts, quoteBadgeWidths, formatFixed, logoIcon, quoteIcon, openExternal, contextData } = require("./presentation")
const { registerTools } = require("./tools")
const { createDetail } = require("./detail")
const { fetchLogo, readLogo } = require("./logo")

const SETTING_WATCHLIST = "watchlist"

class StockPlugin {
  constructor(options = {}) {
    this.api = null
    this.watchlist = []
    this.fetchImpl = options.fetchImpl || httpGet
    this.fetchLogo = options.fetchLogo || fetchLogo
    this.logoCache = new Map()
    this.cacheFolder = ""
    this.now = options.now || (() => Date.now())
    this.cache = options.cache || new TtlCache(QUOTE_TTL_MS)
    this.providers = options.providers || PROVIDERS
    this.order = options.order || MARKET_PROVIDER_ORDER
    this.searchOrder = options.searchOrder || SEARCH_PROVIDER_ORDER
    this.openExternal = options.openExternal || openExternal
    this.failures = []
    this.watchlistQuotes = new Map()
    this.refreshTimer = null
    this.refreshing = false
    this.hostCtx = null
    this.queryCtx = null
    this.visibleResults = []
    this.queryRaw = ""
    this.tailColor = "#E5E7EB"
    this.init = this.init.bind(this)
    this.query = this.query.bind(this)
  }

  async init(ctx, params) {
    this.api = params && params.API
    this.hostCtx = ctx
    if (this.api && typeof this.api.GetCacheFolder === "function") {
      try { this.cacheFolder = await this.api.GetCacheFolder(ctx) || "" } catch { this.cacheFolder = "" }
    }
    await this.loadSettings(ctx)
    if (this.api && typeof this.api.OnSettingChanged === "function") {
      await this.api.OnSettingChanged(ctx, async (_ctx, key, value) => {
        if (key !== SETTING_WATCHLIST) return
        this.watchlist = normalizeWatchlist(value)
        await this.refreshWatchlist()
      })
    }
    if (this.api && typeof this.api.OnMRURestore === "function") {
      await this.api.OnMRURestore(ctx, async (restoreCtx, mruData) => this.restoreResult(restoreCtx, mruData))
    }
    if (this.api && typeof this.api.OnUnload === "function") {
      await this.api.OnUnload(ctx, async () => {
        this.stopWatchlistRefresh()
      })
    }
    await registerTools(this, ctx)
    // Translated labels are remembered for MRU restore, which cannot wait on GetTranslation.
    void this.labels(ctx)
    this.startWatchlistRefresh()
  }

  async loadSettings(ctx) {
    if (!this.api || typeof this.api.GetSetting !== "function") return
    this.watchlist = normalizeWatchlist(await this.api.GetSetting(ctx, SETTING_WATCHLIST))
  }

  async translate(ctx, key) {
    if (this.api && typeof this.api.GetTranslation === "function") {
      try {
        const value = await this.api.GetTranslation(ctx, key)
        if (value && value !== key && !String(value).startsWith("i18n:")) return value
      } catch {
        // Older hosts or unit tests fall through to the header dictionary.
      }
    }
    return (I18N.en_US && I18N.en_US[key]) || key
  }

  async labels(ctx) {
    const keys = [
      "sort", "sort_default", "sort_desc", "sort_asc", "market_a", "market_hk", "market_us",
      "empty_watchlist_title", "empty_watchlist_sub", "empty_title", "empty_sub",
      "error_title", "quote_unavailable",
      "source_eastmoney", "source_tencent", "source_yahoo",
      "relative_now", "relative_minute", "relative_minutes", "relative_hour", "relative_hours", "relative_day", "relative_days",
      "session_pre", "session_post",
      "notify_copied", "notify_added", "notify_removed", "notify_exists", "notify_full",
      "notify_copy_failed", "notify_open_failed", "notify_save_failed"
    ]
    const entries = await Promise.all(keys.map(async (key) => [key, await this.translate(ctx, key)]))
    this.labelsCache = Object.fromEntries(entries)
    return this.labelsCache
  }

  async notify(ctx, key) {
    if (!this.api || typeof this.api.Notify !== "function") return
    await this.api.Notify(ctx, await this.translate(ctx, key))
  }

  async log(ctx, level, message) {
    if (this.api && typeof this.api.Log === "function") {
      await this.api.Log(ctx, level, message)
    }
  }

  quoteOptions() {
    return {
      providers: this.providers,
      order: this.order,
      cache: this.cache,
      now: this.now(),
      fetchImpl: this.fetchImpl,
      onError: (providerId, market, err) => {
        this.failures.push({ providerId, market, message: err && err.message ? err.message : String(err) })
      }
    }
  }

  async search(text, markets) {
    return searchWithFallback(text, markets, {
      ...this.quoteOptions(),
      searchOrder: this.searchOrder
    })
  }

  async quotes(instruments) {
    const quotes = await quotesWithFallback(instruments, this.quoteOptions())
    await this.attachExtendedHours(instruments, quotes)
    return quotes
  }

  // attachExtendedHours adds a US pre-market or after-hours print when the
  // quote itself did not include one. Regular hours stay unchanged.
  async attachExtendedHours(instruments, quotes) {
    const pending = []
    instruments.forEach((instrument, index) => {
      const quote = quotes[index]
      if (instrument.market === "us" && quote && quote.providerId !== "yahoo" && !quote.extended) pending.push({ instrument, index })
    })
    await mapPool(pending, 4, async (row) => {
      const symbol = PROVIDERS.yahoo.symbolFor(row.instrument)
      if (!symbol) return
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=true`
        const extended = extendedSession(JSON.parse(await this.fetchImpl(url)).chart.result[0].meta, this.now() / 1000)
        if (extended) quotes[row.index].extended = extended
      } catch {
        // The regular quote still stands when the extended session is unavailable.
      }
    })
  }

  // startWatchlistRefresh prices the watchlist on a timer. Opening the watchlist
  // only reads this snapshot, so a query does not wait on the network.
  startWatchlistRefresh() {
    this.stopWatchlistRefresh()
    const tick = () => {
      this.refreshWatchlist().catch(() => {})
    }
    tick()
    this.refreshTimer = setInterval(tick, QUOTE_TTL_MS)
    if (typeof this.refreshTimer.unref === "function") this.refreshTimer.unref()
  }

  stopWatchlistRefresh() {
    if (!this.refreshTimer) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  cachedWatchlistQuote(instrument) {
    return this.watchlistQuotes.get(instrumentKey(instrument)) || null
  }

  // cachedQuote is the newest price already in memory. MRU restore must not
  // call quotes(): a live fetch blocks the whole start page, and Wox discards
  // a restore that takes longer than 300ms.
  cachedQuote(instrument) {
    const watched = this.cachedWatchlistQuote(instrument)
    const priced = this.cachedProviderQuote(instrument)
    if (watched && priced) return (priced.time || 0) >= (watched.time || 0) ? priced : watched
    return priced || watched || null
  }

  // cachedProviderQuote reads the 60s quote cache filled by search. It does not fetch.
  cachedProviderQuote(instrument) {
    if (!instrument || !this.cache) return null
    const order = (this.order && this.order[instrument.market]) || []
    let found = null
    for (const providerId of order) {
      const provider = this.providers && this.providers[providerId]
      if (!provider || typeof provider.symbolFor !== "function" || !provider.markets.includes(instrument.market)) continue
      const symbol = provider.symbolFor(instrument)
      if (!symbol) continue
      const cached = this.cache.get(quoteCacheKey(providerId, symbol), this.now())
      if (!cached) continue
      if (!found || (cached.time || 0) > (found.time || 0)) found = cached
    }
    return found
  }

  async refreshWatchlist() {
    if (this.refreshing) return
    const items = this.watchlist.slice()
    const live = new Set(items.map((item) => instrumentKey(item)))
    if (!items.length) {
      this.watchlistQuotes = new Map()
      return
    }
    this.refreshing = true
    try {
      const quotes = await quotesWithFallback(items, {
        ...this.quoteOptions(),
        cache: new TtlCache(QUOTE_TTL_MS)
      })
      await this.attachExtendedHours(items, quotes)
      const next = new Map()
      for (const [key, quote] of this.watchlistQuotes) {
        if (live.has(key)) next.set(key, quote)
      }
      items.forEach((item, index) => {
        if (quotes[index]) next.set(instrumentKey(item), quotes[index])
      })
      this.watchlistQuotes = next
      await this.log(this.hostCtx, "Info", `watchlist refresh count=${items.length} priced=${quotes.filter(Boolean).length}`)
      await this.publishVisibleQuotes()
    } catch (err) {
      await this.log(this.hostCtx, "Warning", `watchlist refresh failed: ${err && err.message ? err.message : err}`)
    } finally {
      this.refreshing = false
    }
  }

  async persistWatchlist(ctx, next) {
    const previous = this.watchlist
    this.watchlist = next
    if (!this.api || typeof this.api.SaveSetting !== "function") return true
    try {
      await this.api.SaveSetting(ctx, SETTING_WATCHLIST, JSON.stringify(next), false)
      return true
    } catch (err) {
      this.watchlist = previous
      await this.log(ctx, "Error", `watchlist save failed: ${err && err.message ? err.message : err}`)
      await this.notify(ctx, "notify_save_failed")
      return false
    }
  }

  rememberVisibleResults(rows) {
    this.visibleResults = rows.map((row) => ({
      instrument: row.instrument,
      quote: row.quote,
      result: row.result
    }))
  }

  async updateVisibleResult(ctx, instrument) {
    const row = this.visibleResults.find((item) => sameInstrument(item.instrument, instrument))
    if (!row) return
    const labels = await this.labels(ctx)
    row.quote = this.cachedWatchlistQuote(instrument) || row.quote
    await this.renderVisibleResults(ctx, labels)
  }

  async publishVisibleQuotes() {
    const labels = await this.labels(this.queryCtx || this.hostCtx)
    for (const row of this.visibleResults) {
      if (!this.watchlist.some((item) => sameInstrument(item, row.instrument))) continue
      const quote = this.cachedWatchlistQuote(row.instrument)
      if (!quote) continue
      row.quote = quote
    }
    await this.renderVisibleResults(this.queryCtx || this.hostCtx, labels)
  }

  async renderVisibleResults(ctx, labels) {
    const widths = quoteBadgeWidths(this.visibleResults.map(row => row.quote), labels)
    for (const row of this.visibleResults) {
      const updated = this.quoteResult(row.instrument, row.quote, labels, row.result.Score, this.queryRaw, widths)
      updated.Id = row.result.Id
      row.result = updated
      await this.pushVisibleResult(ctx, updated)
    }
  }

  async pushVisibleResult(ctx, result) {
    if (!this.api || typeof this.api.UpdateResult !== "function") return
    await this.api.UpdateResult(ctx, {
      Id: result.Id,
      Title: result.Title,
      SubTitle: result.SubTitle,
      Icon: result.Icon,
      Tails: result.Tails,
      Actions: result.Actions
    })
  }

  async query(ctx, query) {
    this.queryCtx = ctx
    this.queryRaw = query.RawQuery || `${query.TriggerKeyword || "stock"}${query.Search ? ` ${query.Search}` : ""}`
    const labels = await this.labels(ctx)
    if (this.api && typeof this.api.GetThemeColors === "function") {
      try {
        const colors = await this.api.GetThemeColors(ctx, {})
        if (/^#[0-9a-f]{6}$/i.test(colors.Text)) this.tailColor = colors.Text
      } catch { /* Keep the last known theme color. */ }
    }
    const sort = selectedSort(query)
    const text = queryText(query)
    const refinement = this.sortRefinement(labels)
    const detailText = query.Command === "detail" ? text : (text.match(/^detail(?:\s+|$)(.*)$/i) || [])[1]
    try {
      if (detailText !== undefined) {
        this.visibleResults = []
        if (!detailText.trim()) {
          return { Results: [{ Title: "i18n:detail_prompt_title", SubTitle: "i18n:detail_prompt_sub", Icon: quoteIcon(0), Actions: [] }] }
        }
        const detailData = query.ContextData || {}
        let instrument = null
        if (detailData.stockDetail && detailData.stockQuery === this.queryRaw) {
          try {
            const candidate = normalizeInstrument(JSON.parse(detailData.stockDetail))
            if (candidate && candidate.code.toUpperCase() === detailText.toUpperCase()) instrument = candidate
          } catch { /* Resolve the public command normally. */ }
        }
        if (!instrument) instrument = (await this.search(detailText, MARKETS)).instruments[0]
        if (!instrument) return { Results: [this.emptyResult(labels)] }
        const quote = this.cachedWatchlistQuote(instrument) || this.cachedQuote(instrument)
        const trigger = query.TriggerKeyword || "stock"
        const returnQuery = detailData.stockQuery === this.queryRaw && detailData.stockReturnQuery !== undefined
          ? detailData.stockReturnQuery
          : `${trigger} ${detailText}`
        const language = await this.translate(ctx, "detail_language")
        const logoKey = `${instrument.market}:${instrument.code}`
        if (!this.logoCache.has(logoKey)) {
          const logo = await readLogo(this.cacheFolder, instrument)
          if (logo) this.logoCache.set(logoKey, logo)
        }
        const result = createDetail(this, instrument, quote, returnQuery, language)
        return { Results: [result], Layout: { ResultPreviewWidthRatio: 0 } }
      }
      const instruments = text
        ? (await this.search(text, MARKETS)).instruments
        : this.watchlist.slice()
      if (!instruments.length) {
        this.visibleResults = []
        return {
          Results: [text ? this.emptyResult(labels) : this.emptyWatchlistResult(labels)],
          Refinements: [refinement]
        }
      }
      const quotes = text
        ? await this.quotes(instruments)
        : instruments.map((item) => this.cachedWatchlistQuote(item))
      const ordered = orderQuoteRows(instruments, quotes, sort)
      const widths = quoteBadgeWidths(quotes, labels)
      const results = ordered.map((row, index) => this.quoteResult(row.instrument, row.quote, labels, 1000 - index, this.queryRaw, widths))
      this.rememberVisibleResults(ordered.map((row, index) => ({
        instrument: row.instrument,
        quote: row.quote,
        result: results[index]
      })))
      const providers = [...new Set(quotes.filter(Boolean).map((quote) => quote.providerId))]
      await this.log(ctx, "Info", `stock query text=${text || "-"} sort=${sort} results=${results.length} providers=${providers.join(",") || "-"} fallbacks=${this.failures.length}`)
      this.failures = []
      return { Results: results, Refinements: [refinement] }
    } catch (err) {
      this.visibleResults = []
      await this.log(ctx, "Error", `stock query failed: ${err && err.message ? err.message : err}`)
      return {
        Results: [{
          Title: "i18n:error_title",
          SubTitle: err && err.message ? String(err.message).slice(0, 180) : "i18n:quote_unavailable",
          Icon: quoteIcon(0),
          Score: 1,
          Actions: []
        }],
        Refinements: [refinement]
      }
    }
  }

  sortRefinement(labels) {
    return {
      Id: "sort",
      Title: labels.sort,
      Type: "sort",
      Hotkey: primaryHotkey("s"),
      DefaultValue: [SORT_DEFAULT],
      Persist: false,
      Options: [
        { Value: SORT_DEFAULT, Title: labels.sort_default },
        { Value: SORT_CHANGE_DESC, Title: labels.sort_desc },
        { Value: SORT_CHANGE_ASC, Title: labels.sort_asc }
      ]
    }
  }

  emptyWatchlistResult(labels) {
    return {
      Title: "i18n:empty_watchlist_title",
      SubTitle: labels.empty_watchlist_sub,
      Icon: quoteIcon(0),
      Score: 1,
      Actions: []
    }
  }

  emptyResult(labels) {
    return {
      Title: "i18n:empty_title",
      SubTitle: labels.empty_sub,
      Icon: quoteIcon(0),
      Score: 1,
      Actions: []
    }
  }

  quoteResult(instrument, quote, labels, score, rawQuery = `stock ${instrument.code}`, widths = quoteBadgeWidths([quote], labels)) {
    const context = contextData(instrument)
    const key = instrumentKey(instrument).replace(/[^\w.-]+/g, "-")
    const watched = this.watchlist.some((row) => sameInstrument(row, instrument))
    const market = labels[`market_${instrument.market}`] || instrument.market
    const source = quote ? (labels[PROVIDERS[quote.providerId].labelKey] || quote.providerId) : ""
    const actions = [{
      Id: randomUUID(), Name: "i18n:action_detail", IsDefault: true, PreventHideAfterAction: true,
      ContextData: context,
      Action: async (ctx) => {
        const trigger = /^gp(?:\s|$)/i.test(rawQuery) ? "gp" : "stock"
        const detailQuery = `${trigger} detail ${instrument.code}`
        await this.api.ChangeQuery(ctx, {
          QueryType: "input", QueryText: detailQuery,
          ContextData: { stockDetail: JSON.stringify(instrument), stockQuery: detailQuery, stockReturnQuery: rawQuery }
        })
      }
    },
      watched
        ? this.removeAction({ id: `watch-${key}`, instrument, context })
        : this.addAction({ id: `watch-${key}`, instrument, context })
    ]
    if (quote) {
      actions.push(this.copyAction({
        id: `copy-price-${key}`,
        name: "i18n:action_copy_price",
        text: formatFixed(quote.price, 2),
        context,
        hotkey: primaryHotkey("enter")
      }))
    }
    actions.push(this.copyAction({
      id: `copy-code-${key}`,
      name: "i18n:action_copy_code",
      text: instrument.code,
      context
    }))
    const pageUrl = (quote && quote.pageUrl) || this.providers.eastmoney.pageUrl(instrument)
    if (pageUrl) {
      actions.push(this.openAction({ id: `open-${key}`, url: pageUrl, context }))
    }
    const updated = quote ? formatRelativeTime(quote.time, this.now(), labels) : ""
    const tails = []
    if (quote) {
      const addBadge = (text, change, width, session) => {
        const badge = badgeSVG(text, change, width, this.tailColor, session)
        tails.push({ Type: "image", Image: { ImageType: "svg", ImageData: badge.markup }, ImageWidth: badge.width, ImageHeight: badge.height, Tooltip: text })
      }
      const texts = quoteBadgeTexts(quote, labels)
      if (widths[0]) addBadge(texts[0], 0, widths[0])
      if (widths[1]) addBadge(texts[1], quote.change, widths[1])
      if (widths[2]) addBadge(texts[2], quote.extended?.change || 0, widths[2], texts[2] ? quote.extended.session : undefined)
    }
    return {
      Id: `stock-${key}`,
      Title: (quote && quote.name) || instrument.name || instrument.code,
      SubTitle: [instrument.code, market, source || (quote ? "" : labels.quote_unavailable), updated].filter(Boolean).join(" · "),
      Icon: logoIcon(instrument) || quoteIcon(quote ? quote.change : 0),
      Score: score,
      IdentityKey: `stock:${instrument.market}:${instrument.code}`,
      Tails: tails,
      Actions: actions
    }
  }

  copyAction(item) {
    return {
      Id: randomUUID(),
      Name: item.name,
      Icon: ACTION_COPY_ICON,
      IsDefault: false,
      Hotkey: item.hotkey || "",
      ContextData: item.context,
      Action: async (ctx) => {
        try {
          await this.api.Copy(ctx, { type: "text", text: item.text })
          await this.notify(ctx, "notify_copied")
        } catch (err) {
          await this.log(ctx, "Error", `copy failed: ${err && err.message ? err.message : err}`)
          await this.notify(ctx, "notify_copy_failed")
        }
      }
    }
  }

  openAction(item) {
    return {
      Id: randomUUID(),
      Name: "i18n:action_open",
      Icon: ACTION_OPEN_ICON,
      IsDefault: false,
      ContextData: item.context,
      Action: async (ctx) => {
        try {
          this.openExternal(item.url)
        } catch (err) {
          await this.log(ctx, "Error", `open failed: ${err && err.message ? err.message : err}`)
          await this.notify(ctx, "notify_open_failed")
        }
      }
    }
  }

  addAction(item) {
    return {
      Id: randomUUID(),
      Name: "i18n:action_add",
      Icon: ACTION_ADD_ICON,
      IsDefault: false,
      PreventHideAfterAction: true,
      ContextData: item.context,
      Action: async (ctx) => {
        await this.addToWatchlist(ctx, item.instrument, true)
      }
    }
  }

  removeAction(item) {
    return {
      Id: randomUUID(),
      Name: "i18n:action_remove",
      Icon: ACTION_DELETE_ICON,
      IsDefault: false,
      PreventHideAfterAction: true,
      ContextData: item.context,
      Action: async (ctx) => {
        const result = removeWatchItem(this.watchlist, item.instrument)
        if (!result.removed) return
        const saved = await this.persistWatchlist(ctx, result.list)
        if (!saved) return
        await this.notify(ctx, "notify_removed")
        await this.updateVisibleResult(ctx, item.instrument)
      }
    }
  }

  async addToWatchlist(ctx, raw, refresh) {
    const result = addWatchItem(this.watchlist, raw)
    if (!result.added) {
      await this.notify(ctx, result.reason === "full" ? "notify_full" : "notify_exists")
      return { added: false, reason: result.reason, instrument: result.item }
    }
    const saved = await this.persistWatchlist(ctx, result.list)
    if (!saved) return { added: false, reason: "save", instrument: result.item }
    await this.notify(ctx, "notify_added")
    if (refresh) await this.updateVisibleResult(ctx, result.item)
    return { added: true, reason: "added", instrument: result.item }
  }

  async restoreResult(_ctx, mruData) {
    const data = (mruData && mruData.ContextData) || {}
    const instrument = normalizeInstrument(data)
    if (!instrument) return null
    const quote = this.cachedQuote(instrument)
    const labels = this.labelsCache || I18N.en_US || {}
    return this.quoteResult({ ...instrument, name: (quote && quote.name) || instrument.name }, quote, labels, 100)
  }

}

const plugin = new StockPlugin()
module.exports = { plugin, StockPlugin }
