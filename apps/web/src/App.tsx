import { useEffect, useState } from "react";
import { Activity, Cpu, Flame, Network, SlidersHorizontal, Upload } from "lucide-react";
import { api, type BusStatus, type ProjectData } from "./api.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { StatusBadge } from "@/components/StatusBadge.tsx";
import { ImportView } from "./views/Import.tsx";
import { DevicesView } from "./views/Devices.tsx";
import { GroupAddressesView } from "./views/GroupAddresses.tsx";
import { MonitorView } from "./views/Monitor.tsx";
import { SettingsView } from "./views/Settings.tsx";

const TABS = [
  { id: "import", label: "Import", icon: Upload },
  { id: "devices", label: "Devices", icon: Cpu },
  { id: "groups", label: "Group addresses", icon: Network },
  { id: "monitor", label: "Bus monitor", icon: Activity },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
] as const;

export function App() {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [status, setStatus] = useState<BusStatus>("disconnected");

  // Reflect any project/connection the server already holds (survives reloads).
  useEffect(() => {
    api.getProject().then(setProject).catch(() => {});
    api.busStatus().then((s) => setStatus(s.status)).catch(() => {});
  }, []);

  return (
    <Tabs defaultValue="import" className="mx-auto flex min-h-full max-w-6xl flex-col gap-0">
      <header className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_20px_-4px] shadow-primary/50">
            <Flame className="size-5" strokeWidth={2.5} />
          </div>
          <div className="leading-none">
            <div className="font-extrabold tracking-[0.2em] text-sm">BUSFORGE</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">KNX bus tool</div>
          </div>
        </div>
        <StatusBadge status={status} />
      </header>

      <TabsList className="sticky top-0 z-10 h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-y border-border bg-background/85 p-0 px-2 backdrop-blur sm:px-4">
        {TABS.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            className="shrink-0 gap-2 rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 py-3 text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent dark:data-[state=active]:border-primary"
          >
            <t.icon className="size-4" />
            <span className="hidden sm:inline">{t.label}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      <main className="flex-1 px-4 py-6 sm:px-6">
        <TabsContent value="import"><ImportView project={project} onImported={setProject} /></TabsContent>
        <TabsContent value="devices"><DevicesView project={project} /></TabsContent>
        <TabsContent value="groups"><GroupAddressesView project={project} /></TabsContent>
        <TabsContent value="monitor"><MonitorView status={status} /></TabsContent>
        <TabsContent value="settings"><SettingsView status={status} onStatus={setStatus} /></TabsContent>
      </main>

      <Toaster position="bottom-right" />
    </Tabs>
  );
}
