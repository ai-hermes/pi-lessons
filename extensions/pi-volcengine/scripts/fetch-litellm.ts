// Downloads LiteLLM's model_prices_and_context_window.json (the source of truth
// for pricing / context-window data) to litellm-models.json.
//
// Source: https://github.com/BerriAI/litellm/blob/litellm_internal_staging/model_prices_and_context_window.json
//
// GitHub raw can be flaky (esp. ECONNRESET from China); we try a list of
// mirrors in order and use the first one that returns valid JSON. Override
// the mirror list with the LITELLM_MIRRORS env var (comma-separated, first
// wins; empty entry "" means the direct URL).
//
// Run:  bun run scripts/fetch-litellm.ts
import { writeFileSync } from "node:fs";

const RAW_URL =
    "https://raw.githubusercontent.com/BerriAI/litellm/litellm_internal_staging/model_prices_and_context_window.json";

// Mirror order: empty string = direct; ghfast.top / ghproxy prefixes are
// applied by concatenation (`<mirror><raw-url>`).
const DEFAULT_MIRRORS = ["", "https://ghfast.top/", "https://ghproxy.com/"];
const mirrors = (process.env["LITELLM_MIRRORS"] ?? DEFAULT_MIRRORS.join(","))
    .split(",")
    .map((s) => s.trim());

let text: string | undefined;
for (const mirror of mirrors) {
    const url = `${mirror}${RAW_URL}`;
    const label = mirror || "direct";
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) {
            console.error(`  ✗ ${label}: HTTP ${res.status} ${res.statusText}`);
            continue;
        }
        const candidate = await res.text();
        // Sanity check: must be a JSON object, not an HTML error page.
        JSON.parse(candidate) as unknown;
        console.error(`  ✓ ${label}: ${candidate.length} bytes`);
        text = candidate;
        break;
    } catch (err) {
        console.error(`  ✗ ${label}: ${(err as Error).message}`);
    }
}

if (text === undefined) {
    console.error(`\nAll mirrors failed. Tried:\n${mirrors.map((m) => `  - ${m || "direct"}`).join("\n")}`);
    process.exit(1);
}

const data = JSON.parse(text) as Record<string, { litellm_provider?: string }>;
const out = "litellm-models.json";
writeFileSync(out, text);
const volcCount = Object.values(data).filter((v) => v?.litellm_provider === "volcengine").length;
console.log(`wrote ${out} — ${text.length} bytes, ${volcCount} volcengine entries`);
