// Errors the full download answers. The server sends the first set only where the application can
// take a full download. The second set comes from a device without a running application: only a
// full download that loads the application brings it back (`fullDownloadLoads`, the device view's
// fullDownloadLoadsApplication); otherwise only ETS can complete its load.
const DOWNLOAD_CODES = new Set(["COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", "NEVER_PROGRAMMED_USE_DOWNLOAD"]);
const UNLOADED_CODES = new Set(["DEVICE_NOT_PROGRAMMED", "FLASH_INTERRUPTED_UNLOADED", "DEVICE_LOAD_INCOMPLETE", "GA_FLASH_BROKE_APPLICATION"]);

// Whether a flash or preview error is answered by offering the full download.
export function offersFullDownload(code: string | undefined, fullDownloadLoads: boolean): boolean {
  if (!code) return false;
  return DOWNLOAD_CODES.has(code) || (fullDownloadLoads && UNLOADED_CODES.has(code));
}

// Whether the device's load can only be completed by ETS: it was left unloaded, or found so, and
// Busforge's full download does not load this application.
export function etsCompletesLoad(code: string | undefined, fullDownloadLoads: boolean): boolean {
  return !!code && !fullDownloadLoads && UNLOADED_CODES.has(code);
}

// Write errors after which the device no longer runs a complete application: no further target
// may be written to it before a full download.
const WRITE_LEFT_UNLOADED_CODES = new Set(["FLASH_INTERRUPTED_UNLOADED", "GA_FLASH_BROKE_APPLICATION"]);

export function leftDeviceUnloaded(code: string | undefined): boolean {
  return !!code && WRITE_LEFT_UNLOADED_CODES.has(code);
}
