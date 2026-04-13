/**
 * iTerm2 regression test for rebased crew-tools.
 * Uses isolated test db at /tmp/.wire-test/crews.db.
 */
import { Orchestrator } from "../src/orchestrator.ts";
import { ItermBackend } from "../src/iterm-backend.ts";
import { mkdirSync } from "fs";

const TEST_DB = "/tmp/.wire-test/crews.db";
mkdirSync("/tmp/.wire-test", { recursive: true });
// Start fresh each run
try { (await import("fs")).unlinkSync(TEST_DB); } catch {}

const terminal = new ItermBackend();
const orch = new Orchestrator(terminal, TEST_DB);

function step(n: number, label: string) {
  process.stderr.write(`\n[${n}] ${label}\n`);
}

async function pause(ms: number) { await new Promise(r => setTimeout(r, ms)); }

try {
  step(1, "createTab with theme 'trees' (themed iterm tab + auto pane)");
  const tab = await orch.createTab("regress-test", "trees");
  console.log("   tab:", JSON.stringify({ name: tab.name, theme: tab.theme, pane: tab.pane?.name, iterm_id: tab.iterm_id?.slice(0,20) }));
  if (!tab.pane) throw new Error("expected auto-created themed pane in tab");
  const firstPane = tab.pane.name;

  await pause(800);

  step(2, `pane_badge set on '${firstPane}'`);
  await orch.setBadge(firstPane, "REGRESS ✓");
  await pause(500);

  step(3, `createPane on tab 'regress-test' (second pane, below)`);
  const p2 = await orch.createPane("regress-test", undefined, "below");
  console.log("   pane:", JSON.stringify({ name: p2.name, theme: p2.theme, position: p2.position, iterm_id: p2.iterm_id?.slice(0,20) }));

  await pause(800);

  step(4, `pane_badge set on '${p2.name}'`);
  await orch.setBadge(p2.name, "P2 ✓");
  await pause(500);

  step(5, `sendToPane: echo from orchestrator`);
  await orch.sendToPane(p2.name, "echo 'regression test: pane send works'");
  await pause(500);

  step(6, `notifyPane on '${firstPane}' (iTerm2: flash noop + notify→setBadge fallback)`);
  await orch.notifyPane(firstPane, "TEST NOTIFY", "body text");
  await pause(500);

  step(7, `closePane '${p2.name}'`);
  await orch.closePane(p2.name);
  await pause(500);

  step(8, `deleteTab 'regress-test' (cleanup)`);
  orch.deleteTab("regress-test");

  console.error("\n✅ ALL STEPS PASSED");
  process.exit(0);
} catch (e: any) {
  console.error("\n❌ FAILED:", e?.stack ?? e);
  process.exit(1);
}
