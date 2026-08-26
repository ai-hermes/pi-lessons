import { ARKClient, ListEndpointsCommand } from '@volcengine/ark';
import type { ListEndpointsCommandOutput } from '@volcengine/ark';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

function findEnvPath(startDir = process.cwd()): string | undefined {
  let dir = startDir;
  while (true) {
    const p = path.join(dir, '.env');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}


dotenv.config({
    path: findEnvPath(),
});
import { Command, CommandOutput, buildRequestConfigFromMetaPath } from '@volcengine/sdk-core';

export type ListEndpointsRequest = ConstructorParameters<typeof ListEndpointsCommand>[0];
export type ListEndpointsResponse =
    ListEndpointsCommandOutput extends CommandOutput<infer Response> ? Response : never;

export type InnerDescribeModelEndpointsRequest = ListEndpointsRequest;
export type InnerDescribeModelEndpointsResponse = ListEndpointsResponse;


export class InnerDescribeModelEndpointsCommand extends Command<
    InnerDescribeModelEndpointsRequest,
    InnerDescribeModelEndpointsCommandOutput,
    'InnerDescribeModelEndpointsCommand'
> {
    static readonly metaPath = '/InnerDescribeModelEndpoints/2024-01-01/ark/post/application_json/';

    constructor(input: InnerDescribeModelEndpointsRequest) {
        super(input);
        this.requestConfig = buildRequestConfigFromMetaPath(InnerDescribeModelEndpointsCommand.metaPath);
    }
}


export type InnerDescribeModelEndpointsCommandOutput = CommandOutput<InnerDescribeModelEndpointsResponse>;


const arkClient = new ARKClient({
    accessKeyId: process.env.VOLCENGINE_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.VOLCENGINE_SECRET_ACCESS_KEY ?? "",
});



const PAGE_SIZE = 100;
const buildInEndpoints: InnerDescribeModelEndpointsResponse['Items'] = [];
let fetchedCount = 0;
for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const command = new InnerDescribeModelEndpointsCommand({
        PageSize: PAGE_SIZE,
        PageNumber: pageNumber,
    });
    const response = await arkClient.send(command);
    const items = response.Result?.Items ?? [];
    fetchedCount += items.length;
    // console.log(`Fetched ${items.length} endpoints on page ${pageNumber}, total fetched: ${fetchedCount}`);
    buildInEndpoints.push(...items);

    if (fetchedCount >= (response.Result?.TotalCount ?? 0) || items.length === 0) break;
}
// console.log(`Total endpoints fetched: ${buildInEndpoints.length}`);


const customEndpoints: ListEndpointsResponse['Items'] = [];
fetchedCount = 0;
for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const command = new ListEndpointsCommand({
        PageSize: PAGE_SIZE,
        PageNumber: pageNumber,
    });
    const response = await arkClient.send(command);
    const items = response.Result?.Items ?? [];
    fetchedCount += items.length;
    // console.log(`Fetched ${items.length} endpoints on page ${pageNumber}, total fetched: ${fetchedCount}`);
    customEndpoints.push(...items);

    if (fetchedCount >= (response.Result?.TotalCount ?? 0) || items.length === 0) break;
}
// console.log(`Total endpoints fetched: ${customEndpoints.length}`);


// console.log("InnerDescribeModelEndpointsCommand response:", JSON.stringify(response, null, 2));
