export const dynamic = "force-dynamic";

/* Reports the uid/gid the Next.js server process really runs as, so the
   integration suite can prove non-root from outside the container. */
export function GET() {
  return Response.json({
    status: "ok",
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    greeting: process.env.GREETING ?? "default-greeting",
    nodeEnv: process.env.NODE_ENV ?? null,
  });
}
