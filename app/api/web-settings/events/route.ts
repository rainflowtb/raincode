/**
 * Settings revision push stream — see lib/settings-revision.ts. Every write to
 * raincode.json or the permission policy (any client, any process) fans one
 * `changed` event out here so connected renderers revalidate their caches.
 */
import { NextRequest } from "next/server";
import { getSettingsRevision, subscribeSettingsRevision } from "@/lib/settings-revision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // closed
        }
      };

      send("snapshot", { revision: getSettingsRevision() });
      unsubscribe = subscribeSettingsRevision(() => {
        send("changed", { revision: getSettingsRevision() });
      });

      heartbeat = setInterval(() => send("ping", { t: Date.now() }), 15_000);
      heartbeat.unref?.();

      const onAbort = () => {
        cleanup();
        try { controller.close(); } catch { /* ignore */ }
      };
      request.signal.addEventListener("abort", onAbort);

      function cleanup() {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", onAbort);
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe?.();
        unsubscribe = null;
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
