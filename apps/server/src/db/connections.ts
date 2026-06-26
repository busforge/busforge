import { Database } from "bun:sqlite";

export type ConnectionType = "ip" | "usb";

// A reusable, saved bus connection (IP gateway or USB interface) the user can
// apply to any project. Environment-specific, so not part of project export.
export interface Connection {
  id: string;
  name: string;
  type: ConnectionType;
  host: string;
  port: number;
  usbVendorId: number | null;
  usbProductId: number | null;
  usbSerial: string | null;
  createdAt: number;
}

export type ConnectionInput = Omit<Connection, "id" | "createdAt">;

const COLS = `id, name, type, host, port,
  usb_vendor_id AS usbVendorId, usb_product_id AS usbProductId, usb_serial AS usbSerial,
  created_at AS createdAt`;

export function listConnections(db: Database): Connection[] {
  return db.query(`SELECT ${COLS} FROM connections ORDER BY created_at`).all() as Connection[];
}

export function getConnection(db: Database, id: string): Connection | null {
  return (db.query(`SELECT ${COLS} FROM connections WHERE id = ?`).get(id) as Connection | null) ?? null;
}

export function createConnection(db: Database, id: string, c: ConnectionInput, now: number): Connection {
  db.prepare(
    `INSERT INTO connections (id, name, type, host, port, usb_vendor_id, usb_product_id, usb_serial, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, c.name, c.type, c.host, c.port, c.usbVendorId, c.usbProductId, c.usbSerial, now);
  return getConnection(db, id)!;
}

export function updateConnection(db: Database, id: string, c: ConnectionInput): Connection | null {
  const changed = db.prepare(
    `UPDATE connections SET name = ?, type = ?, host = ?, port = ?,
       usb_vendor_id = ?, usb_product_id = ?, usb_serial = ? WHERE id = ?`,
  ).run(c.name, c.type, c.host, c.port, c.usbVendorId, c.usbProductId, c.usbSerial, id).changes > 0;
  return changed ? getConnection(db, id) : null;
}

export function deleteConnection(db: Database, id: string): boolean {
  return db.prepare("DELETE FROM connections WHERE id = ?").run(id).changes > 0;
}
