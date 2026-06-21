import { useState } from "react";
import { Loader2, Network, Plug, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { api, type BusStatus, type Project } from "../api.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge.tsx";

export function InterfaceView({ project, status, onStatus }: { project: Project; status: BusStatus; onStatus: (s: BusStatus) => void }) {
  const [ip, setIp] = useState(project.interface.interfaceIp);
  const [port, setPort] = useState(String(project.interface.port));
  const [busy, setBusy] = useState(false);

  async function save() {
    const s = await api.saveInterface(project.id, { interfaceIp: ip, port: Number(port) });
    setIp(s.interfaceIp); setPort(String(s.port));
    return s;
  }

  async function saveOnly() {
    try { await save(); toast.success("Interface saved"); }
    catch (e) { toast.error("Save failed", { description: (e as Error).message }); }
  }

  async function toggleConnection() {
    setBusy(true);
    try {
      if (status === "connected") {
        const res = await api.busDisconnect(project.id);
        onStatus(res.status);
        toast.message("Disconnected from the bus");
      } else {
        await save();
        onStatus("connecting");
        const res = await api.busConnect(project.id);
        onStatus(res.status);
        toast.success("Connected to the bus");
      }
    } catch (e) {
      toast.error("Connection failed", { description: (e as Error).message });
      onStatus((await api.busStatus(project.id).catch(() => ({ status: "disconnected" as BusStatus }))).status);
    } finally {
      setBusy(false);
    }
  }

  const connected = status === "connected";

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Network className="size-4 text-primary" /> Bus interface</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>Interface IP (KNXnet/IP)</Label>
              <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="198.51.100.10" className="font-mono" data-testid="ip" />
            </div>
            <div className="space-y-1.5">
              <Label>Port</Label>
              <Input value={port} onChange={(e) => setPort(e.target.value)} className="font-mono" />
            </div>
          </div>
          <Button variant="outline" onClick={saveOnly}>Save</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Plug className="size-4 text-primary" /> Connection</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <StatusBadge status={status} />
          <Button onClick={toggleConnection} disabled={busy} variant={connected ? "destructive" : "default"} data-testid="connect">
            {busy ? <Loader2 className="size-4 animate-spin" /> : connected ? <Plug className="size-4" /> : <PlugZap className="size-4" />}
            {busy ? "…" : connected ? "Disconnect" : "Connect"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
