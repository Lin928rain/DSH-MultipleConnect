import type { Context } from "@deepseek-ai/cordis";
import type { ProactivePanelService } from "./service.js";

const BASE = "/api/dsh-proactive";
const ACTION_BODY_MAX_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;

type FetchRoutes = {
  register(route: {
    path: string;
    methods: readonly ("GET" | "POST")[];
    requestBody: "buffered";
    fetch(request: Request): Response | Promise<Response>;
  }): () => void;
};

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function events(request: Request, subscribe: (listener: () => void) => () => void): Response {
  const encoder = new TextEncoder();
  let dispose = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      const unsubscribe = subscribe(() => write('event: changed\ndata: {}\n\n'));
      const heartbeat = setInterval(() => write(": keepalive\n\n"), HEARTBEAT_MS);
      heartbeat.unref();
      dispose = () => {
        unsubscribe();
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", abort);
      };
      const abort = () => { dispose(); controller.close(); };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      else write(": connected\n\n");
    },
    cancel() { dispose(); },
  });
  return new Response(stream, { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
  } });
}

export function installPanelRoutes(
  ctx: Context,
  service: ProactivePanelService,
  subscribe: (listener: () => void) => () => void,
): (() => void) | undefined {
  // Connection applies the same owner authentication and request trust as
  // other DSH management surfaces before dispatching exact Fetch routes.
  const connection = ctx.get("connection", false) as { fetch?: FetchRoutes } | undefined;
  const routes = connection?.fetch;
  if (!routes) return undefined;
  const session = (request: Request) => new URL(request.url).searchParams.get("session") || undefined;
  const disposers = [
    routes.register({
      path: BASE + "/state", methods: ["GET"], requestBody: "buffered",
      fetch: async (request) => response(await service.snapshot(session(request))),
    }),
    routes.register({
      path: BASE + "/action", methods: ["POST"], requestBody: "buffered",
      async fetch(request) {
        try {
          if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
            return response({ code: "bad_action", message: "Expected JSON body" }, 415);
          }
          const bytes = await request.arrayBuffer();
          if (bytes.byteLength > ACTION_BODY_MAX_BYTES) return response({ code: "bad_action", message: "Request too large" }, 413);
          const action = JSON.parse(new TextDecoder().decode(bytes));
          const result = await service.action(action, session(request));
          return result.ok ? response(result.snapshot) : response(result.error, 400);
        } catch {
          return response({ code: "bad_action", message: "Invalid action request" }, 400);
        }
      },
    }),
    routes.register({ path: BASE + "/events", methods: ["GET"], requestBody: "buffered", fetch: async (request) => events(request, subscribe) }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
