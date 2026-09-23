/* Stack registry and auto-detection. Order breaks ties between equal detection scores. */
import { Stack } from "../core/report";
import { angularStack } from "./angular";
import { nodeStack } from "./node";
import { pythonStack } from "./python";
import { reactStack } from "./react";

export const STACKS: Stack[] = [angularStack, nodeStack, pythonStack, reactStack];

/** Every stack that recognises the repo, most confident first. */
export function detectStacks(repo: string): { st: Stack; d: { score: number; reason: string } }[] {
  return STACKS.flatMap((st) => {
    const d = st.detect(repo);
    return d ? [{ st, d }] : [];
  }).sort((a, b) => b.d.score - a.d.score);
}
