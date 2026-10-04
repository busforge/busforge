import type { KnxTransport } from "@busforge/knx";

// Keeps the bridge's KNX interface open across a USB re-enumeration. When the stick goes away the
// server is told at once (it disconnects its tunnels and refuses new ones with the reason), and the
// interface is reopened by vendor, product and serial until it is back, as the same interface. A
// stick that comes back with another address is not this bridge's interface: it is released, and
// the server keeps refusing.

export interface SupervisedServer {
  interfaceLost(reason: string): void;
  interfaceRestored(transport: KnxTransport): void;
}

export interface InterfaceSupervisor {
  // The open interface, or null while it is gone.
  current(): KnxTransport | null;
  stop(): void;
}

const RETRY_MS = 2_000;

export function superviseInterface(opts: {
  initial: KnxTransport;
  server: SupervisedServer;
  open: () => Promise<KnxTransport>;
  log: (msg: string) => void;
  schedule?: (fn: () => void) => void;
}): InterfaceSupervisor {
  const schedule = opts.schedule ?? ((fn) => { setTimeout(fn, RETRY_MS); });
  let current: KnxTransport | null = opts.initial;
  let stopped = false;
  let lastFailure = "";

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // A stick that stays away fails the same way every two seconds; that is said once, not per try.
  const note = (msg: string) => {
    if (msg !== lastFailure) opts.log(`the KNX interface is not back yet: ${msg}`);
    lastFailure = msg;
  };
  const release = (t: KnxTransport) => {
    t.onClosed = null;
    t.disconnect().catch((e: unknown) => opts.log(`releasing the old interface handle failed: ${errText(e)}`));
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    let t: KnxTransport;
    try {
      t = await opts.open();
    } catch (e) {
      note(errText(e));
      schedule(() => void attempt());
      return;
    }
    if (stopped) { release(t); return; }
    try {
      opts.server.interfaceRestored(t);
    } catch (e) {
      release(t);
      // The stick answered under another address. Reopening it every 2 s would only take it from
      // whoever else wants it, so the bridge stops here and says why.
      if ((e as { code?: string }).code === "BRIDGE_INTERFACE_CHANGED") {
        opts.log(`giving up on the KNX interface: ${errText(e)}`);
        return;
      }
      note(errText(e));
      schedule(() => void attempt());
      return;
    }
    current = t;
    lastFailure = "";
    watch(t);
  };

  const watch = (t: KnxTransport) => {
    t.onClosed = (reason) => {
      if (stopped || current !== t) return;
      current = null;
      opts.server.interfaceLost(reason);
      release(t);
      opts.log("reopening the KNX interface by its vendor, product and serial");
      schedule(() => void attempt());
    };
  };

  watch(opts.initial);
  return {
    current: () => current,
    stop: () => { stopped = true; },
  };
}
