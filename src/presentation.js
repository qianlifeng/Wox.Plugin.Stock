const { spawn } = require("child_process")
const { PROVIDERS } = require("./providers")

const PLUGIN_ICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='14' fill='#1a4a5c'/><path d='M15 14v22M24 11v26M33 8v24' fill='none' stroke='#cbd5e1' stroke-width='2' stroke-linecap='round'/><rect x='11.5' y='21' width='7' height='9' rx='1.5' fill='#fb7185'/><rect x='20.5' y='17' width='7' height='11' rx='1.5' fill='#34d399'/><rect x='29.5' y='13' width='7' height='13' rx='1.5' fill='#6ee7b7'/></svg>"
const DOWN_ICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='14' fill='#1a4a5c'/><path d='M15 10v24M24 12v26M33 16v20' fill='none' stroke='#cbd5e1' stroke-width='2' stroke-linecap='round'/><rect x='11.5' y='14' width='7' height='13' rx='1.5' fill='#fda4af'/><rect x='20.5' y='18' width='7' height='11' rx='1.5' fill='#fb7185'/><rect x='29.5' y='22' width='7' height='9' rx='1.5' fill='#e11d48'/></svg>"
const FLAT_ICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='14' fill='#1a4a5c'/><path d='M15 14v22M24 12v24M33 14v22' fill='none' stroke='#cbd5e1' stroke-width='2' stroke-linecap='round'/><rect x='11.5' y='18' width='7' height='11' rx='1.5' fill='#94a3b8'/><rect x='20.5' y='16' width='7' height='12' rx='1.5' fill='#cbd5e1'/><rect x='29.5' y='18' width='7' height='11' rx='1.5' fill='#94a3b8'/></svg>"
const PRE_ICON_PATH = "M6 2 4 4h4zm-.5 3.5V7h1V5.5zM2.818 6.611l-.707.707 1.06 1.061.708-.707zm6.364 0-1.06 1.061.706.707 1.06-1.06zM6 8.001a2.51 2.51 0 0 0-2.45 2H1v1h10v-1H8.45A2.51 2.51 0 0 0 6 8"
const POST_ICON_PATH = "M8.2 1.8a4.8 4.8 0 1 0 3.6 8.1A3.8 3.8 0 0 1 8.2 1.8z"

const ACTION_COPY_ICON = { ImageType: "svg", ImageData: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--wox-theme-icon-color)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"8\" y=\"8\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2\"/></svg>" }
const ACTION_OPEN_ICON = { ImageType: "svg", ImageData: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--wox-theme-icon-color)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 5h5v5M19 5l-9 9\"/><path d=\"M13 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-7\"/></svg>" }
const ACTION_ADD_ICON = { ImageType: "svg", ImageData: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--wox-theme-icon-color)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 5v14M5 12h14\"/></svg>" }
const ACTION_DELETE_ICON = { ImageType: "svg", ImageData: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--wox-theme-icon-color)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3\"/></svg>" }

function primaryHotkey(key) {
  return `${process.platform === "darwin" ? "cmd" : "ctrl"}+${key}`
}

const SORT_DEFAULT = "default"
const SORT_CHANGE_DESC = "desc"
const SORT_CHANGE_ASC = "asc"

function selectedSort(query) {
  const refinements = (query && (query.Refinements || query.refinements)) || {}
  const value = refinements.sort
  return value === SORT_CHANGE_DESC || value === SORT_CHANGE_ASC ? value : SORT_DEFAULT
}

// orderQuoteRows keeps search or watchlist order unless the sort is by change percent.
// Quotes without a percent stay at the end.
function orderQuoteRows(instruments, quotes, sort) {
  const rows = instruments.map((instrument, index) => ({ instrument, quote: quotes[index] || null, index }))
  if (sort !== SORT_CHANGE_DESC && sort !== SORT_CHANGE_ASC) return rows
  const direction = sort === SORT_CHANGE_ASC ? 1 : -1
  rows.sort((left, right) => {
    const leftPercent = left.quote && Number.isFinite(left.quote.changePercent) ? left.quote.changePercent : null
    const rightPercent = right.quote && Number.isFinite(right.quote.changePercent) ? right.quote.changePercent : null
    if (leftPercent === null && rightPercent === null) return left.index - right.index
    if (leftPercent === null) return 1
    if (rightPercent === null) return -1
    if (leftPercent === rightPercent) return left.index - right.index
    return (leftPercent - rightPercent) * direction
  })
  return rows
}

function queryText(query) {
  return String((query && (query.Search || query.search)) || "").trim().slice(0, 40)
}

function formatCount(template, count) {
  return String(template || "").replaceAll("{n}", String(count))
}

// formatRelativeTime turns a quote timestamp into a short age such as "3 分钟前".
function formatRelativeTime(unixSeconds, nowMs, labels) {
  if (!(unixSeconds > 0) || !(nowMs > 0)) return ""
  const delta = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds))
  if (delta < 60) return labels.relative_now || ""
  const minutes = Math.floor(delta / 60)
  if (minutes < 60) return formatCount(minutes === 1 ? labels.relative_minute : labels.relative_minutes, minutes)
  const hours = Math.floor(delta / 3600)
  if (hours < 24) return formatCount(hours === 1 ? labels.relative_hour : labels.relative_hours, hours)
  const days = Math.floor(delta / 86400)
  return formatCount(days === 1 ? labels.relative_day : labels.relative_days, days)
}

// Wox renders one centered SVG text element with its native text renderer.
function badgeSVG(text, change, width, theme, session) {
  const up = change > 0
  const down = change < 0
  const label = up || down ? "#FFFFFF" : theme
  const fill = up ? "#027A48" : down ? "#B42318" : theme
  const background = text ? `<rect width="${width}" height="22" rx="4" fill="${fill}"${up || down ? "" : ' fill-opacity="0.05"'}/>` : ""
  const iconPath = session === "pre" ? PRE_ICON_PATH : POST_ICON_PATH
  const icon = session ? `<path fill="#FFC043" transform="translate(5 5) scale(0.92)" d="${iconPath}"/>` : ""
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  // Wox centers text over the whole image and trims whitespace. The zero-width
  // character preserves this inset so the visible label sits beside the icon.
  const inset = session ? "&#8203;     " : ""
  const labelElement = text ? `<text x="${width / 2}" y="15" text-anchor="middle" font-size="11" fill="${label}">${inset}${escaped}</text>` : ""
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22" viewBox="0 0 ${width} 22">${background}${icon}${labelElement}</svg>`
  return { markup, width, height: 22 }
}

function formatFixed(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : ""
}

function signedFixed(value, digits) {
  const text = formatFixed(value, digits)
  if (!text) return ""
  return value > 0 ? `+${text}` : text
}

function quoteBadgeTexts(quote, labels) {
  if (!quote) return ["", "", ""]
  const percent = signedFixed(quote.changePercent, 2)
  const extended = quote.extended && signedFixed(quote.extended.changePercent, 2)
  const session = quote.extended && (quote.extended.session === "pre" ? labels.session_pre : labels.session_post)
  return [formatFixed(quote.price, 2), percent ? `${percent}%` : "", extended ? `${session} ${extended}%` : ""]
}

function quoteBadgeWidths(quotes, labels) {
  const widths = [0, 0, 0]
  for (const quote of quotes) {
    quoteBadgeTexts(quote, labels).forEach((text, index) => {
      if (!text) return
      // Wox does not expose text measurement to plugins; reserve conservative glyph advances.
      const textWidth = Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) > 127 ? 12 : char === "." || char === " " ? 4 : char === "%" ? 10 : 7), 0)
      widths[index] = Math.max(widths[index], Math.ceil(textWidth + (index === 2 ? 22 : 14)))
    })
  }
  return widths
}

// logoIcon uses the public ticker image. Unknown symbols 404 and the row falls back.
function logoIcon(instrument) {
  const symbol = PROVIDERS.yahoo.symbolFor(instrument)
  if (!symbol) return null
  return {
    ImageType: "url",
    ImageData: `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`
  }
}

function quoteIcon(change) {
  const svg = change > 0 ? PLUGIN_ICON_SVG : change < 0 ? DOWN_ICON_SVG : FLAT_ICON_SVG
  return { ImageType: "svg", ImageData: svg }
}

function openExternal(target) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore", windowsHide: true }).unref()
    return
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open"
  spawn(command, [target], { detached: true, stdio: "ignore" }).unref()
}

function contextData(instrument) {
  return {
    quoteId: instrument.quoteId || "",
    code: instrument.code || "",
    name: instrument.name || "",
    market: instrument.market || ""
  }
}


module.exports = { ACTION_COPY_ICON, ACTION_OPEN_ICON, ACTION_ADD_ICON, ACTION_DELETE_ICON, SORT_DEFAULT, SORT_CHANGE_DESC, SORT_CHANGE_ASC, primaryHotkey, selectedSort, orderQuoteRows, queryText, formatRelativeTime, badgeSVG, quoteBadgeTexts, quoteBadgeWidths, formatFixed, signedFixed, logoIcon, quoteIcon, openExternal, contextData }
