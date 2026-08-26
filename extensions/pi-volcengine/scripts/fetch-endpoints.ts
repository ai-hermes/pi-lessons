// Fetches the Running builtin + custom endpoints from your Volcengine Ark
// account and writes them to volcengine.endpoints.json.
//
// Required env (loaded from .env):
//   VOLCENGINE_ACCESS_KEY_ID
//   VOLCENGINE_SECRET_ACCESS_KEY
//
// Run:  bun run scripts/fetch-endpoints.ts
import { writeFileSync } from "node:fs";
import { ARKClient } from "@volcengine/ark";
import "../extensions/env";
import { fetchVolcengineModels } from "../extensions/utils";
import type { ListEndpointsItem } from "../extensions/type";

const accessKeyId = process.env["VOLCENGINE_ACCESS_KEY_ID"];
const secretAccessKey = process.env["VOLCENGINE_SECRET_ACCESS_KEY"];
if (!accessKeyId || !secretAccessKey) {
    console.error("Missing VOLCENGINE_ACCESS_KEY_ID / VOLCENGINE_SECRET_ACCESS_KEY. Set them in .env");
    process.exit(1);
}

const arkClient = new ARKClient({ accessKeyId, secretAccessKey });

const all: ListEndpointsItem[] = await fetchVolcengineModels(arkClient);
const running = all
    .filter((ep) => ep.Status === "Running" && ep.Id && ep.Name)
    .map((ep) => ({
        endpointId: ep.Id,
        name: ep.Name,
        modelName: ep.ModelReference?.FoundationModel?.Name ?? ep.Name,
        modelVersion: ep.ModelReference?.FoundationModel?.ModelVersion,
        endpointModelType: ep.EndpointModelType,
    }));

const out = "volcengine.endpoints.json";
writeFileSync(out, JSON.stringify(running, null, 2));
console.log(`wrote ${out} — ${running.length} Running endpoints (of ${all.length} total)`);
