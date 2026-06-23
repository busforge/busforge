import { Cpu } from "lucide-react";
import { IdentityPill } from "@/components/IdentityPill.tsx";

// Unified device identity: a blue pill with the device icon, its name and its KNX
// individual address. Used wherever a device is referenced so the format stays
// consistent. `placeholder={false}` drops the "(unnamed)" filler in tight spots,
// showing just the icon and address for nameless devices.
export function DeviceLabel({ name, ia, className, placeholder = true, fallback }: { name?: string; ia: string; className?: string; placeholder?: boolean; fallback?: string }) {
  return <IdentityPill icon={Cpu} variant="device" name={name} value={ia} placeholder={placeholder} fallback={fallback} className={className} />;
}
