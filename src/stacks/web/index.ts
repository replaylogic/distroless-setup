/* Static web: Vite apps without React (vanilla, Vue, Svelte, ...) whose production build is a
   folder of static files. Node.js only builds them; the React stack's static-build path serves
   the output with the shared Go server on distroless/static. */
import * as path from "path";
import { exists, tryJson } from "../../core/files";
import { Stack } from "../../core/report";
import { deps, hasReact, otherFramework, viteStaticApp } from "../react/analysis";
import { runStaticBuild } from "../react";

export const webStack: Stack = {
  id: "web",
  title: "Static web (Vite)",
  detect(repo) {
    const pkg = tryJson(path.join(repo, "package.json"));
    if (!pkg || exists(path.join(repo, "angular.json"))) return null;
    const d = deps(pkg);
    // React apps, and frameworks with their own deployment, are the react and node stacks' to claim.
    if (hasReact(d) || otherFramework(d)) return null;
    const app = viteStaticApp(repo, pkg);
    if (!app) return null;
    // Possible server-side code: offer this stack, but never above the node stack.
    if (app.server) return { score: 0.2, reason: `package.json, Vite, but ${app.server}` };
    return { score: 0.95, reason: `package.json, Vite: ${app.evidence.join(", ")}` };
  },
  run: (ctx) => runStaticBuild(ctx, "web"),
};
