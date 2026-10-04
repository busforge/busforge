// Errors the full download answers. The server sends the first set only where the application can
// take a full download. The second set comes from the device and leaves one whose application cannot
// be downloaded in full where it is: only ETS can complete its load.
const DOWNLOAD_CODES = new Set(["COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", "NEVER_PROGRAMMED_USE_DOWNLOAD"]);
const UNLOADED_CODES = new Set(["DEVICE_NOT_PROGRAMMED", "FLASH_INTERRUPTED_UNLOADED", "DEVICE_LOAD_INCOMPLETE", "GA_FLASH_BROKE_APPLICATION"]);

// Whether a flash or preview error is answered by offering the full download.
export function offersFullDownload(code: string | undefined, canFullDownload: boolean): boolean {
  if (!code) return false;
  return DOWNLOAD_CODES.has(code) || (canFullDownload && UNLOADED_CODES.has(code));
}

// Write errors after which the device no longer runs a complete application: no further target
// may be written to it before a full download.
const WRITE_LEFT_UNLOADED_CODES = new Set(["FLASH_INTERRUPTED_UNLOADED", "GA_FLASH_BROKE_APPLICATION"]);

export function leftDeviceUnloaded(code: string | undefined): boolean {
  return !!code && WRITE_LEFT_UNLOADED_CODES.has(code);
}
