import { useState } from "react";
import { api, type BusStatus, type Project } from "./api.ts";
import { Toaster } from "@/components/ui/sonner";
import { ProjectsScreen } from "./views/Projects.tsx";
import { ProjectView } from "./views/ProjectView.tsx";

export function App() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<BusStatus>("disconnected");

  async function openProject(id: string) {
    const p = await api.getProject(id);
    const s = await api.busStatus(id).catch(() => ({ status: "disconnected" as BusStatus }));
    setProject(p);
    setStatus(s.status);
    setActiveId(id);
  }

  function closeProject() {
    setActiveId(null);
    setProject(null);
    setStatus("disconnected");
  }

  return (
    <>
      {activeId && project ? (
        <ProjectView project={project} status={status} onStatus={setStatus} onBack={closeProject} />
      ) : (
        <ProjectsScreen onOpen={openProject} />
      )}
      <Toaster position="bottom-right" />
    </>
  );
}
