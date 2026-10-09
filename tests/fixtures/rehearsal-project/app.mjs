import { createServer } from "node:http";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("Rehearsal fixture app\n");
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
process.on("SIGHUP", close);
process.on("SIGTSTP", close);
server.listen(5275, "127.0.0.1");
