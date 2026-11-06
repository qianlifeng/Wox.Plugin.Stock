import type { Plugin } from "@wox-launcher/wox-plugin"
import { plugin as stockPlugin } from "./stock"

export const plugin = stockPlugin as unknown as Plugin
