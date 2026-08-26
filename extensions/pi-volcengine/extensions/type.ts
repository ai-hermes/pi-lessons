import type { Model } from '@earendil-works/pi-ai';

export type VolcengineEndpointModel = Model<"openai-completions"> & {
  endpointId: string;
};


import { ListEndpointsCommand } from '@volcengine/ark';
import type { ListEndpointsCommandOutput } from '@volcengine/ark';
import { Command, CommandOutput, buildRequestConfigFromMetaPath } from '@volcengine/sdk-core';


export type ListEndpointsRequest = ConstructorParameters<typeof ListEndpointsCommand>[0];
export type ListEndpointsResponse =
  ListEndpointsCommandOutput extends CommandOutput<infer Response> ? Response : never;
export type ListEndpointsItem =
    NonNullable<ListEndpointsResponse["Items"]>[number];




export type InnerDescribeModelEndpointsRequest = ListEndpointsRequest;
export type InnerDescribeModelEndpointsResponse = ListEndpointsResponse;
export type InnerDescribeModelEndpointsItem = ListEndpointsItem;

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
