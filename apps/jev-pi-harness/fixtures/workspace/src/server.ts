import { createServer } from "node:http";
import { config } from "./config.ts";

const port = Number(config.port);

createServer((_req, res) => {
	res.end(`${config.serviceName} ok`);
}).listen(port, () => {
	console.log(`listening on ${port}`);
});
