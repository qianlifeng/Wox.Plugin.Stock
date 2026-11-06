const { logoIcon } = require("./presentation")
const { createHash } = require("crypto")
const fs = require("fs/promises")
const path = require("path")

const MAX_LOGO_BYTES = 512 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function logoPath(folder, instrument) {
  const key = `${instrument.market}:${instrument.code}`
  return path.join(folder, `logo-${createHash("sha256").update(key).digest("hex")}.png`)
}

function validLogo(bytes) {
  return bytes.length >= PNG_SIGNATURE.length && bytes.length <= MAX_LOGO_BYTES && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

async function readLogo(folder, instrument) {
  if (!folder) return null
  try {
    const file = logoPath(folder, instrument)
    const stat = await fs.stat(file)
    if (stat.size > MAX_LOGO_BYTES) return null
    const bytes = await fs.readFile(file)
    return validLogo(bytes) ? { imageType: "base64", imageData: `data:image/png;base64,${bytes.toString("base64")}` } : null
  } catch { return null }
}

async function saveLogo(folder, instrument, logo) {
  if (!folder || logo?.imageType !== "base64" || !logo.imageData?.startsWith("data:image/png;base64,")) return
  const bytes = Buffer.from(logo.imageData.slice("data:image/png;base64,".length), "base64")
  if (!validLogo(bytes)) return
  try { await fs.writeFile(logoPath(folder, instrument), bytes) } catch { /* Cache failure must not prevent display. */ }
}

// WoxView image nodes accept inline images, so fetch the same logo used by result rows.
async function fetchLogo(instrument) {
  const icon = logoIcon(instrument)
  if (!icon) return null
  const response = await fetch(icon.ImageData, { signal: AbortSignal.timeout(4000) })
  if (!response.ok || !/^image\/png\b/i.test(response.headers.get("content-type") || "")) return null
  const length = Number(response.headers.get("content-length"))
  if (length > MAX_LOGO_BYTES) return null
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return null
  return { imageType: "base64", imageData: `data:image/png;base64,${bytes.toString("base64")}` }
}

module.exports = { fetchLogo, readLogo, saveLogo }
