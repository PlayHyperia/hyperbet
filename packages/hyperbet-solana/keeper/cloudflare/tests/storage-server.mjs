import { readFileSync } from "node:fs";
import { createServer } from "node:https";
const directory = process.argv[2];
let writes = 0;
const server = createServer({
  key: readFileSync(`${directory}/key.pem`),
  cert: readFileSync(`${directory}/cert.pem`),
}, async (request, response) => {
  let body = "";
  for await (const part of request) body += part;
  const { requestId, operation } = JSON.parse(body);
  if (request.headers.authorization !== `Bearer ${"a".repeat(32)}`) {
    response.writeHead(401).end(); return;
  }
  if (operation === "redirect") {
    response.writeHead(307, { location: "/" }).end(); return;
  }
  if (operation === "write" || operation === "delayedWrite") writes++;
  if (operation === "delayedWrite") await new Promise(resolve => setTimeout(resolve, 400));
  if (operation === "reject") { response.writeHead(503).end(); return; }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ requestId: operation === "wrongId" ? "other" : requestId, ok: true, value: writes }));
});
server.listen(0, "127.0.0.1", () => console.log(`https://localhost:${server.address().port}/`));
