import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Plus, RefreshCw, Trash2, Usb, Network, Pencil } from "lucide-react";
import type { Connection, ConnectionInput, ConnectionType, IpTransport, Gateway, UsbDevice } from "../api.ts";
import { api } from "../api.ts";
import { qk, useConnections } from "../queries.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { errMsg } from "../lib/apiError.ts";
import { Chip } from "@/components/ui/chip";

// USB identity carried around the UI (subset of a connection's usb_* fields).
export interface UsbValue { usbVendorId: number | null; usbProductId: number | null; usbSerial: string | null }

const sameDevice = (d: UsbDevice, v: UsbValue) => d.vendorId === v.usbVendorId && d.productId === v.usbProductId && (d.serial ?? null) === v.usbSerial;
const usbKey = (v: UsbValue) => `${v.usbVendorId}:${v.usbProductId}:${v.usbSerial ?? ""}`;

// Segmented IP/USB selector.
export function TypeToggle({ value, onChange, disabled }: { value: ConnectionType; onChange: (t: ConnectionType) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const opt = (type: ConnectionType, Icon: typeof Usb, label: string) => (
    <Chip active={value === type} disabled={disabled} onClick={() => onChange(type)} className="h-8 flex-1 justify-center">
      <Icon /> {label}
    </Chip>
  );
  return (
    <div className="flex gap-2">
      {opt("ip", Network, t("iface.typeIp"))}
      {opt("usb", Usb, t("iface.typeUsb"))}
    </div>
  );
}

// Segmented Auto/TCP/UDP selector for an IP connection's KNXnet/IP transport.
function TransportToggle({ value, onChange }: { value: IpTransport; onChange: (t: IpTransport) => void }) {
  const { t } = useTranslation();
  const opts: IpTransport[] = ["auto", "tcp", "udp"];
  return (
    <div className="flex gap-2" data-testid="conn-transport">
      {opts.map((o) => (
        <Chip key={o} active={value === o} onClick={() => onChange(o)} className="h-8 flex-1 justify-center">
          {t(`conn.transport_${o}`)}
        </Chip>
      ))}
    </div>
  );
}

// Scan + select a connected KNX-USB interface. Auto-scans on mount; a stored
// value that is not currently attached stays selectable so the choice persists.
export function UsbPicker({ value, onChange, disabled }: { value: UsbValue; onChange: (v: UsbValue) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<UsbDevice[]>([]);
  const [scanning, setScanning] = useState(false);

  const scan = async () => {
    setScanning(true);
    try {
      const found = await api.discoverUsb();
      setDevices(found);
      // Auto-pick when exactly one is present and nothing is selected yet.
      if (found.length === 1 && value.usbVendorId == null) {
        onChange({ usbVendorId: found[0].vendorId, usbProductId: found[0].productId, usbSerial: found[0].serial ?? null });
      }
    } catch (e) { toast.error(errMsg(t, e)); }
    finally { setScanning(false); }
  };
  useEffect(() => { void scan(); }, []);

  // Merge the stored value in case its device is not currently attached.
  const options = [...devices];
  if (value.usbVendorId != null && !devices.some((d) => sameDevice(d, value))) {
    options.push({ vendorId: value.usbVendorId, productId: value.usbProductId!, product: value.usbSerial ?? "KNX-USB", serial: value.usbSerial ?? undefined });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[11px] text-muted-foreground">{t("iface.usbLabel")}</Label>
        <button type="button" onClick={() => void scan()} disabled={scanning || disabled} className="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 text-[11px] text-muted-foreground hover:not-disabled:text-foreground disabled:opacity-50">
          {scanning ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} {scanning ? t("iface.usbScanning") : t("iface.usbScan")}
        </button>
      </div>
      <select
        disabled={disabled}
        value={value.usbVendorId != null ? usbKey(value) : ""}
        onChange={(e) => {
          const d = options.find((o) => usbKey({ usbVendorId: o.vendorId, usbProductId: o.productId, usbSerial: o.serial ?? null }) === e.target.value);
          onChange(d ? { usbVendorId: d.vendorId, usbProductId: d.productId, usbSerial: d.serial ?? null } : { usbVendorId: null, usbProductId: null, usbSerial: null });
        }}
        className="h-8 w-full rounded-md border border-input bg-input/30 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        data-testid="usb-picker"
      >
        <option value="">{options.length ? t("conn.pick") : t("iface.usbNone")}</option>
        {options.map((d) => (
          <option key={usbKey({ usbVendorId: d.vendorId, usbProductId: d.productId, usbSerial: d.serial ?? null })} value={usbKey({ usbVendorId: d.vendorId, usbProductId: d.productId, usbSerial: d.serial ?? null })}>
            {d.product}{d.serial ? ` · ${d.serial}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

// One-line summary of a connection's target (shared with the bus popover).
export const connDetail = (c: Connection) => c.type === "usb" ? (c.usbSerial ?? "KNX-USB") : `${c.host}:${c.port}`;

// The connection-manager dialog: a library of saved connections (CRUD) with
// network/USB discovery to populate them. Project-independent.
export function ConnectionManager() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: conns = [] } = useConnections();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);

  const del = useMutation({
    mutationFn: (cid: string) => api.deleteConnection(cid),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.connections }); toast.message(t("conn.deleted")); },
    onError: (e) => toast.error(t("conn.deleteFailed"), { description: errMsg(t, e) }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
      <DialogTrigger asChild>
        <button type="button" className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" data-testid="manage-connections">
          {t("iface.manage")}
        </button>
      </DialogTrigger>
      <DialogContent backdropClose={editing === null}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Usb className="size-4 text-primary" /> {t("conn.title")}</DialogTitle>
          <DialogDescription>{t("conn.description")}</DialogDescription>
        </DialogHeader>

        {editing ? (
          <ConnectionEditor conn={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        ) : (
          <div className="space-y-2">
            {conns.length === 0 ? (
              <p className="px-1 py-4 text-center text-sm text-muted-foreground">{t("conn.none")}</p>
            ) : (
              <div className="space-y-1.5">
                {conns.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2" data-testid="conn-row">
                    {c.type === "usb" ? <Usb className="size-4 shrink-0 text-muted-foreground" /> : <Network className="size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{c.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">{connDetail(c)}</div>
                    </div>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => setEditing(c)} title={t("conn.edit")}><Pencil className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:not-disabled:text-destructive" onClick={() => { if (confirm(t("conn.deleteConfirm"))) del.mutate(c.id); }} title={t("conn.delete")}><Trash2 className="size-3.5" /></Button>
                  </div>
                ))}
              </div>
            )}
            <Button variant="outline" className="w-full" onClick={() => setEditing("new")} data-testid="conn-add"><Plus className="size-4" /> {t("conn.add")}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// KNXnet/IP discovery inside the editor: scan the LAN, pick a found gateway to
// fill the IP fields. Returns nothing when no interface answers.
function GatewayScan({ onPick }: { onPick: (g: Gateway) => void }) {
  const { t } = useTranslation();
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const scan = async () => {
    setScanning(true);
    try { setGateways(await api.discoverIp()); setScanned(true); }
    catch (e) { toast.error(errMsg(t, e)); }
    finally { setScanning(false); }
  };
  return (
    <div className="space-y-1.5">
      <button type="button" onClick={() => void scan()} disabled={scanning} className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 text-[11px] text-muted-foreground hover:not-disabled:text-foreground disabled:opacity-50" data-testid="scan-ip">
        {scanning ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} {scanning ? t("conn.scanning") : t("conn.scanIp")}
      </button>
      {scanned && !scanning && gateways.length === 0 && <p className="text-[11px] text-muted-foreground">{t("conn.noGateways")}</p>}
      {gateways.length > 0 && (
        <div className="space-y-1">
          {gateways.map((g) => (
            <button key={g.ip} type="button" onClick={() => onPick(g)} className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-left text-xs outline-none hover:border-primary hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <Network className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{g.name || g.ia}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{g.ip}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionEditor({ conn, onDone }: { conn: Connection | null; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(conn?.name ?? "");
  const [type, setType] = useState<ConnectionType>(conn?.type ?? "ip");
  const [host, setHost] = useState(conn?.host ?? "");
  const [port, setPort] = useState(String(conn?.port ?? 3671));
  const [ipTransport, setIpTransport] = useState<IpTransport>(conn?.ipTransport ?? "auto");
  const [usb, setUsb] = useState<UsbValue>({ usbVendorId: conn?.usbVendorId ?? null, usbProductId: conn?.usbProductId ?? null, usbSerial: conn?.usbSerial ?? null });

  const save = useMutation({
    mutationFn: () => {
      const input: ConnectionInput = {
        name: name.trim(), type,
        host: type === "ip" ? host.trim() : "", port: Number(port) || 3671,
        ipTransport,
        usbVendorId: type === "usb" ? usb.usbVendorId : null,
        usbProductId: type === "usb" ? usb.usbProductId : null,
        usbSerial: type === "usb" ? usb.usbSerial : null,
      };
      return conn ? api.updateConnection(conn.id, input) : api.createConnection(input);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.connections }); toast.success(t("conn.created")); onDone(); },
    onError: (e) => toast.error(t("conn.saveFailed"), { description: errMsg(t, e) }),
  });

  const ready = type === "ip" ? host.trim().length > 0 : usb.usbVendorId != null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">{t("conn.name")}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("conn.namePlaceholder")} className="h-8" data-testid="conn-name" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">{t("conn.type")}</Label>
        <TypeToggle value={type} onChange={setType} />
      </div>
      {type === "ip" ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t("conn.ipAddress")}</Label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="198.51.100.10" className="h-8 font-mono text-sm" data-testid="conn-ip" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">{t("conn.port")}</Label>
              <Input value={port} onChange={(e) => setPort(e.target.value)} className="h-8 font-mono text-sm" />
            </div>
          </div>
          <GatewayScan onPick={(g) => { setHost(g.ip); setPort(String(g.port)); if (!name.trim()) setName(g.name || g.ia); }} />
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t("conn.transport")}</Label>
            <TransportToggle value={ipTransport} onChange={setIpTransport} />
            <p className="text-[11px] text-muted-foreground">{t("conn.transportHint")}</p>
          </div>
        </div>
      ) : (
        <UsbPicker value={usb} onChange={setUsb} />
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>{t("conn.back")}</Button>
        <Button onClick={() => save.mutate()} disabled={!ready || save.isPending} data-testid="conn-save">
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("conn.save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
