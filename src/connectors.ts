import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorCatalog, ConnectorStats } from "./analysis/connectors.js";

export const CONNECTOR_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "connectors.json");

let cached: ConnectorCatalog | undefined;
export function loadConnectors(file = CONNECTOR_FILE): ConnectorCatalog {
  if (!cached) {
    if (!fs.existsSync(file)) throw new Error(`Connector data not found at ${file}. Run "sbp templates" first.`);
    cached = JSON.parse(fs.readFileSync(file, "utf8")) as ConnectorCatalog;
  }
  return cached;
}

/** Connectors of a building type (full typePath or class suffix such as "Build_ConstructorMk1_C"). */
export function connectorsOf(type: string): ConnectorStats[] {
  const catalog = loadConnectors();
  const key = Object.keys(catalog).find((t) => t === type || t.endsWith(`.${type}`));
  if (!key) throw new Error(`No connector data for "${type}".`);
  return catalog[key];
}

export function connector(type: string, name: string): ConnectorStats {
  const found = connectorsOf(type).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`"${type}" has no connector named "${name}".`);
  return found;
}
