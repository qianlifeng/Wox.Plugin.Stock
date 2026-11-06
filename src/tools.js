const { MARKETS, normalizeInstrument, removeWatchItem } = require("./instruments")

function marketsFor(selection) {
  return selection === "all" ? MARKETS.slice() : [selection]
}

async function registerTools(plugin, ctx) {
  if (!plugin.api || typeof plugin.api.RegisterPluginTool !== "function") return
  const tools = [
    {
      Name: "search_stocks",
      Description: "i18n:tool_search",
      InputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          market: { type: "string", enum: ["all", "a", "hk", "us"] }
        },
        required: ["text"],
        additionalProperties: false
      },
      OutputSchema: {
        type: "object",
        properties: {
          providerId: { type: "string" },
          instruments: { type: "array" }
        },
        required: ["providerId", "instruments"]
      },
      Annotations: { ReadOnly: true, Destructive: false, Idempotent: true, RequiresUI: false },
      Handler: async (_ctx, option) => searchTool(plugin, option.Arguments || {})
    },
    {
      Name: "get_quotes",
      Description: "i18n:tool_quotes",
      InputSchema: {
        type: "object",
        properties: {
          instruments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: { type: "string" },
                name: { type: "string" },
                market: { type: "string", enum: ["a", "hk", "us"] },
                quoteId: { type: "string" }
              },
              required: ["code", "market"]
            }
          }
        },
        required: ["instruments"],
        additionalProperties: false
      },
      OutputSchema: {
        type: "object",
        properties: { quotes: { type: "array" } },
        required: ["quotes"]
      },
      Annotations: { ReadOnly: true, Destructive: false, Idempotent: true, RequiresUI: false },
      Handler: async (_ctx, option) => quotesTool(plugin, option.Arguments || {})
    },
    {
      Name: "list_watchlist",
      Description: "i18n:tool_list",
      InputSchema: { type: "object", properties: {}, additionalProperties: false },
      OutputSchema: {
        type: "object",
        properties: { instruments: { type: "array" } },
        required: ["instruments"]
      },
      Annotations: { ReadOnly: true, Destructive: false, Idempotent: true, RequiresUI: false },
      Handler: async () => ({ Output: { instruments: plugin.watchlist } })
    },
    {
      Name: "add_watchlist",
      Description: "i18n:tool_add",
      InputSchema: {
        type: "object",
        properties: {
          code: { type: "string" },
          name: { type: "string" },
          market: { type: "string", enum: ["a", "hk", "us"] },
          quoteId: { type: "string" }
        },
        required: ["code", "market"],
        additionalProperties: false
      },
      OutputSchema: {
        type: "object",
        properties: {
          added: { type: "boolean" },
          reason: { type: "string" }
        },
        required: ["added", "reason"]
      },
      Annotations: { ReadOnly: false, Destructive: false, Idempotent: true, RequiresUI: false },
      Handler: async (toolCtx, option) => {
        const result = await plugin.addToWatchlist(toolCtx, option.Arguments || {}, false)
        return { Output: { added: result.added, reason: result.reason } }
      }
    },
    {
      Name: "remove_watchlist",
      Description: "i18n:tool_remove",
      InputSchema: {
        type: "object",
        properties: {
          code: { type: "string" },
          market: { type: "string" },
          quoteId: { type: "string" }
        },
        additionalProperties: false
      },
      OutputSchema: {
        type: "object",
        properties: { removed: { type: "boolean" } },
        required: ["removed"]
      },
      Annotations: { ReadOnly: false, Destructive: true, Idempotent: true, RequiresUI: false },
      Handler: async (toolCtx, option) => {
        const result = removeWatchItem(plugin.watchlist, option.Arguments || {})
        if (result.removed) {
          const saved = await plugin.persistWatchlist(toolCtx, result.list)
          if (!saved) return { Error: { Code: "EXECUTION_FAILED", Message: "Could not save the watchlist" } }
        }
        return { Output: { removed: result.removed } }
      }
    }
  ]
  for (const tool of tools) {
    try {
      const registered = await plugin.api.RegisterPluginTool(ctx, {
        Tool: {
          Name: tool.Name,
          Description: tool.Description,
          InputSchema: tool.InputSchema,
          OutputSchema: tool.OutputSchema,
          Annotations: tool.Annotations
        },
        Handler: tool.Handler
      })
      if (registered && registered.Error) {
        await plugin.log(ctx, "Warning", `plugin tool ${tool.Name} was not registered: ${registered.Error.Message || registered.Error.Code}`)
      }
    } catch (err) {
      await plugin.log(ctx, "Warning", `plugin tool ${tool.Name} unavailable: ${err && err.message ? err.message : err}`)
    }
  }
}

async function searchTool(plugin, args) {
  const text = String(args.text || "").trim()
  if (!text) return { Error: { Code: "INVALID_ARGUMENTS", Message: "text is required" } }
  const market = args.market || "all"
  if (market !== "all" && !MARKETS.includes(market)) {
    return { Error: { Code: "INVALID_ARGUMENTS", Message: "market must be all, a, hk, or us" } }
  }
  try {
    const found = await plugin.search(text, marketsFor(market))
    return { Output: { providerId: found.providerId, instruments: found.instruments } }
  } catch (err) {
    return { Error: { Code: "EXECUTION_FAILED", Message: err && err.message ? err.message : String(err) } }
  }
}

async function quotesTool(plugin, args) {
  const instruments = (Array.isArray(args.instruments) ? args.instruments : []).map(normalizeInstrument).filter(Boolean).slice(0, 20)
  if (!instruments.length) return { Error: { Code: "INVALID_ARGUMENTS", Message: "instruments must include code and market" } }
  try {
    const quotes = await plugin.quotes(instruments)
    return {
      Output: {
        quotes: instruments.map((instrument, index) => {
          const quote = quotes[index]
          if (!quote) return { code: instrument.code, market: instrument.market, name: instrument.name, available: false }
          return {
            code: instrument.code,
            market: instrument.market,
            name: quote.name || instrument.name,
            price: quote.price,
            change: quote.change,
            changePercent: quote.changePercent,
            currency: quote.currency,
            providerId: quote.providerId,
            time: quote.time || 0,
            available: true
          }
        })
      }
    }
  } catch (err) {
    return { Error: { Code: "EXECUTION_FAILED", Message: err && err.message ? err.message : String(err) } }
  }
}
module.exports = { registerTools }
