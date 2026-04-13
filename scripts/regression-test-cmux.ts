/**
 * cmux regression test — forces CmuxBackend and drives through
 * the same tool surface we just validated on iTerm2.
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
import { mkdirSync, unlinkSync } from "fs";

const TEST_DB = "/tmp/.wire-test-cmux/crews.db";
mkdirSync("/tmp/.wire-test-cmux", { recursive: true });
try { unlinkSync(TEST_DB); } catch {}

const terminal = new CmuxBackend();
const orch = new Orchestrator(terminal, TEST_DB);

function step(n: number, label: string) { process.stderr.write(`\n[${n}] ${label}\n`); }
async function pause(ms: number) { await new Promise(r => setTimeout(r, ms)); }

let tab: any, firstPaneName: string | undefined, p2: any;

try {
  step(1, "createTab with theme 'trees' (cmux new-workspace + themed no-op profile)");
  tab = await orch.createTab("regress-cmux", "trees");
  console.log("   tab:", JSON.stringify({ name: tab.name, theme: tab.theme, pane: tab.pane?.name, surface: tab.iterm_id }));
  if (!tab.pane) throw new Error("expected auto-created pane record");
  firstPaneName = tab.pane.name;

  await pause(500);

  step(2, `pane_badge set on '${firstPaneName}' (cmux: notify --title)`);
  await orch.setBadge(firstPaneName!, "REGRESS ✓");
  await pause(500);

  step(3, `createPane on 'regress-cmux' (new surface, below — cmux new-split down)`);
  p2 = await orch.createPane("regress-cmux", undefined, "below");
  console.log("   pane:", JSON.stringify({ name: p2.name, position: p2.position, surface: p2.iterm_id }));
  await pause(500);

  step(4, `pane_badge on '${p2.name}'`);
  await orch.setBadge(p2.name, "P2 ✓");
  await pause(500);

  step(5, `sendToPane on '${p2.name}' (cmux send --surface)`);
  await orch.sendToPane(p2.name, "echo 'cmux regression: pane send works'\n");
  await pause(500);

  step(6, `notifyPane on '${firstPaneName}' (cmux: flash + native notify)`);
  await orch.notifyPane(firstPaneName!, "CMUX TEST", "flash + notify should fire natively");
  await pause(500);

  step(7, `closePane '${p2.name}'`);
  await orch.closePane(p2.name);
  await pause(500);

  step(8, `closePane '${firstPaneName}' (cleanup first pane before deleteTab)`);
  try { await orch.closePane(firstPaneName!); } catch (e: any) { console.error("   close first pane:", e?.message ?? e); }

  step(9, `deleteTab 'regress-cmux' (db cleanup)`);
  orch.deleteTab("regress-cmux");

  console.error("\n✅ ALL STEPS PASSED");
  process.exit(0);
} catch (e: any) {
  console.error("\n❌ FAILED:", e?.stack ?? e);
  // Best-effort cleanup
  try { if (p2?.name) await orch.closePane(p2.name); } catch {}
  try { if (firstPaneName) await orch.closePane(firstPaneName); } catch {}
  try { if (tab) orch.deleteTab("regress-cmux"); } catch {}
  process.exit(1);
}
