import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port))
  throw new Error("Fixture application port missing.");

const server = createServer((_request, response) => {
  response.end("rehearsal fixture ready");
});

server.listen(port, "127.0.0.1");
