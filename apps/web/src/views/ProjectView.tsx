import { Activity, ChevronLeft, Cpu, Network, SlidersHorizontal } from "lucide-react";
import type { BusStatus, Project } from "../api.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge.tsx";
import { DevicesView } from "./Devices.tsx";
import { GroupAddressesView } from "./GroupAddresses.tsx";
import { MonitorView } from "./Monitor.tsx";
import { InterfaceView } from "./Interface.tsx";

const TABS = [
  { id: "devices", label: "Devices", icon: Cpu },
  { id: "groups", label: "Group addresses", icon: Network },
  { id: "monitor", label: "Bus monitor", icon: Activity },
  { id: "interface", label: "Interface", icon: SlidersHorizontal },
] as const;

export function ProjectView({ project, status, onStatus, onBack }: {
  project: Project;
  status: BusStatus;
  onStatus: (s: BusStatus) => void;
  onBack: () => void;
}) {
  return (
    <Tabs defaultValue="devices" className="mx-auto flex min-h-full max-w-6xl flex-col gap-0">
      <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="All projects" className="shrink-0 text-muted-foreground">
            <ChevronLeft className="size-5" />
          </Button>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-base font-bold">{project.name}</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{project.devices.length} devices · {project.gaCount} GAs</div>
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
        <TabsContent value="devices"><DevicesView project={project} /></TabsContent>
        <TabsContent value="groups"><GroupAddressesView project={project} /></TabsContent>
        <TabsContent value="monitor"><MonitorView projectId={project.id} status={status} /></TabsContent>
        <TabsContent value="interface"><InterfaceView project={project} status={status} onStatus={onStatus} /></TabsContent>
      </main>
    </Tabs>
  );
}
