import { startServer } from "../src/mcp-server.ts";
process.stderr.write("wrap: calling startServer\n");
startServer().then(() => process.stderr.write("wrap: resolved\n")).catch((e) => {
  process.stderr.write("wrap: rejected: " + (e?.stack ?? e) + "\n");
  process.exit(1);
});
