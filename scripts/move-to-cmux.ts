/**
 * Move Fondant from iTerm2 walnut → a new cmux pane.
 * Uses CmuxBackend against the live crew db.
 */
process.env.CREW_TERMINAL = "cmux";
if (!process.env.CMUX_SOCKET_PASSWORD) {
  const { readFileSync } = await import("fs");
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf-8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

import { Orchestrator } from "../src/orchestrator.ts";
import { CmuxBackend } from "../src/cmux.ts";

const LIVE_DB = process.env.CREW_DB ?? `${process.env.HOME}/.wire/crews.db`;
const terminal = new CmuxBackend();
const orch = new Orchestrator(terminal, LIVE_DB);

async function main() {
  process.stderr.write("[move] creating cmux tab 'fondant-cmux' with theme trees\n");
  const tab = await orch.createTab("fondant-cmux", "trees");
  const paneName = tab.pane?.name;
  if (!paneName) throw new Error("no auto-created pane on tab");
  process.stderr.write(`[move] tab created: ${tab.name}, pane=${paneName}, surface=${tab.pane?.iterm_id}\n`);

  // Small beat so the cmux surface is fully ready to receive input
  await new Promise((r) => setTimeout(r, 500));

  process.stderr.write(`[move] attaching fondant → ${paneName} (will detach from iTerm2 walnut, then screen -x fondant on cmux)\n`);
  await orch.attachAgent("fondant", paneName);
  process.stderr.write("[move] attach complete — fondant should now be visible in cmux\n");
}

main().catch((e) => {
  process.stderr.write(`[move] FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
});
