import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Icon IDs of the game's icon library (signs, blueprint icons, blueprint categories), by display
 * name: items ("Iron Plate" 195), buildings ("Manufacturer" 87, "Fuel-Powered Generator" 95) and
 * generic icons ("Power" 352, "Factory" 349).
 *
 * data/icon-ids.json comes from SyBozzDEV/Satisfactory-Icons (MIT License,
 * https://github.com/SyBozzDEV/Satisfactory-Icons); it agrees with every ID learned from real
 * blueprints' signs and icons. Where a name appears twice, the lower ID is kept.
 */
const FILE = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), "data", "icon-ids.json");

let icons: Record<string, number> | undefined;

export function iconFor(name: string): number | undefined {
  icons ??= JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, number>;
  return icons[name];
}
