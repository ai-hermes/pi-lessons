import { choice, noul } from "@typesafe-ai/sdk";
import { getClient } from "./shared/jev.ts";
const client = getClient();
const response = await client.systemOne({
	model: "jev-1.13.0",
	state: {
		message: "我被重复扣费了，请马上退款",
		accountTier: "pro",
	},
	questions: {
		department: choice("哪个团队应该处理？", {
			billing: "扣费、退款或订阅问题",
			technical: "故障或集成问题",
			other: "其他问题",
		}),
		urgent: noul("是否需要立即处理？"),
	},
});

console.log(response.answers.department.choice);
console.log(response.answers.department.probabilities);
console.log(response.answers.urgent.noul);
