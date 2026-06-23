import { Network } from "lucide-react";
import { IdentityPill } from "@/components/IdentityPill.tsx";

// Unified group-address identity: an amber pill with the group-address icon (the
// same one used in the navigation), its name and its address. A deliberate mirror
// of DeviceLabel kept in its own file so the two can evolve independently.
// `placeholder={false}` drops the filler and shows just the icon and address for
// unnamed group addresses.
export function GaLabel({ name, address, className, placeholder = true, fallback }: { name?: string; address: string; className?: string; placeholder?: boolean; fallback?: string }) {
  return <IdentityPill icon={Network} variant="ga" name={name} value={address} placeholder={placeholder} fallback={fallback} className={className} />;
}
