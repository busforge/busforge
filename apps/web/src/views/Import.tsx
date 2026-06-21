import { useRef, useState } from "react";
import { FileUp, FolderUp, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, type ImportResult, type ProjectData } from "../api.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function ImportView({ project, onImported }: { project: ProjectData | null; onImported: (p: ProjectData) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function pick(f: File | null) { setFile(f); setResult(null); setError(null); }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importProject(file, password);
      setResult(res);
      onImported(await api.getProject());
      toast.success(`Imported ${res.name}`, { description: `${res.deviceCount} devices, ${res.gaCount} group addresses` });
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast.error("Import failed", { description: msg });
    } finally {
      setBusy(false);
    }
  }

  const loaded = result ?? (project ? { name: project.name, deviceCount: project.devices.length, gaCount: project.gaCount } : null);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileUp className="size-4 text-primary" /> Import project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label>.knxproj file</Label>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0] ?? null); }}
              className={cn(
                "flex h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm transition-colors",
                drag ? "border-primary bg-primary/5" : "border-border bg-secondary/30 hover:border-primary/60 hover:bg-secondary/50",
              )}
            >
              <FolderUp className={cn("size-6", file ? "text-primary" : "text-muted-foreground")} />
              {file
                ? <span className="font-mono text-foreground">{file.name}</span>
                : <span className="text-muted-foreground">Drop a <span className="font-mono">.knxproj</span> file or click to browse</span>}
            </button>
            <input ref={inputRef} type="file" accept=".knxproj" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> Password</Label>
            <Input type="password" value={password} placeholder="if the project is protected" onChange={(e) => setPassword(e.target.value)} />
          </div>

          {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <Button onClick={submit} disabled={!file || busy} data-testid="import-submit" className="w-full">
            {busy ? <><Loader2 className="size-4 animate-spin" /> Importing…</> : "Import"}
          </Button>
        </CardContent>
      </Card>

      {loaded && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Loaded project</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <span className="text-xl font-bold">{loaded.name}</span>
            <Badge variant="secondary" className="font-mono">{loaded.deviceCount} devices</Badge>
            <Badge variant="secondary" className="font-mono">{loaded.gaCount} group addresses</Badge>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
