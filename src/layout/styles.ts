import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Blueprint } from "@etothepii/satisfactory-file-parser";

/**
 * Building styles ("kits") modeled on real blueprints the user likes: which wall, window, door,
 * trim, pillar, beam, roof and floor pieces a building uses, and the paint of every piece, copied
 * from those blueprints (swatch slot, custom colors, finish), so generated buildings look like theirs.
 *
 * Each list is a preference order: the first type the chosen template version has wins.
 */
export interface StyleKit {
  name: string;
  /** Blueprints (name substrings) the kit and its paint come from. */
  sources: string[];
  wall: string[];
  window: string[];
  door: string[];
  /** Wall with a conveyor opening in its middle. */
  beltPanel: string[];
  /** Small pillars: stacked at the building's corners and laid along the walls as bands. */
  pillar?: string[];
  /** Where pillar bands run: at every floor line, or only under the roof (a cornice). */
  bands?: "floors" | "cornice";
  /** Painted beams along the roof's edges, with connectors at the corners. */
  beam?: string[];
  beamConnector?: string[];
  /** 8 m x 1 m walls: a parapet around the roof, and a band at every floor line. */
  trim?: string[];
  roof: string[];
  /** Roof pieces away from the edges ("glass": all glass, "skylights": every other one). */
  roofGlass?: "all" | "skylights";
  floor: string[];
  /** Which wall courses get windows. */
  windows: "upper" | "middle" | "sides";
}

export const KITS: StyleKit[] = [
  {
    // Steel Beam Manufacturer, Encased Industrial Beam, Rotor and Stator, 1.5 GW Fuel Power Plant.
    name: "metal frame",
    sources: ["Steel Beam Manufacturer", "Encased Industrial Beam Factory", "Rotor and Stator Factory", "1.5 GW Fuel Power Plant"],
    wall: ["Build_Wall_8x4_01_C"],
    window: ["Build_Wall_Window_8x4_03_C"],
    door: ["Build_Wall_Door_8x4_03_C", "Build_Wall_Door_8x4_01_C"],
    beltPanel: ["Build_Wall_Conveyor_8x4_03_C", "Build_Wall_Conveyor_8x4_03_Steel_C"],
    pillar: ["Build_Pillar_Small_Metal_C"],
    bands: "floors",
    beam: ["Build_Beam_Painted_C"],
    beamConnector: ["Build_Beam_Connector_C"],
    roof: ["Build_Foundation_Asphalt_8x1_C"],
    floor: ["Build_Foundation_Asphalt_8x1_C"],
    windows: "sides",
  },
  {
    // Stackable Motor Factory and Coal power plant 2700MW.
    name: "concrete",
    sources: ["Stackable Motor Factory", "Coal power plant 2700MW"],
    wall: ["Build_Wall_Concrete_8x4_C"],
    window: ["Build_Wall_Concrete_8x4_Window_02_C", "Build_Wall_Concrete_8x4_Window_01_C"],
    door: ["Build_Wall_Concrete_Gate_8x4_C", "Build_Wall_Concrete_SDoor_8x4_C"],
    beltPanel: ["Build_Wall_Concrete_8x4_ConveyorHole_01_C"],
    pillar: ["Build_Pillar_Small_Concrete_C"],
    bands: "cornice",
    trim: ["Build_Wall_Orange_8x1_C", "Build_Wall_Concrete_8x1_C"],
    roof: ["Build_Foundation_Concrete_8x1_C"],
    roofGlass: "all",
    floor: ["Build_Foundation_Concrete_8x1_C"],
    windows: "middle",
  },
  {
    // Raw Quartz -> Quartz Crystal / Silica.
    name: "steel",
    sources: ["Raw Quartz"],
    wall: ["Build_Wall_8x4_02_C"],
    window: ["Build_Wall_Window_Thin_8x4_01_C"],
    door: ["Build_Wall_Door_8x4_03_Steel_C"],
    beltPanel: ["Build_Wall_Conveyor_8x4_03_Steel_C"],
    pillar: ["Build_Pillar_Small_Metal_C"],
    trim: ["Build_SteelWall_8x1_C"],
    roof: ["Build_Foundation_Metal_8x1_C"],
    roofGlass: "skylights",
    floor: ["Build_Foundation_Metal_8x1_C"],
    windows: "upper",
  },
];

/** Every piece type a kit may place. */
export const kitTypes = (kit: StyleKit): string[] =>
  [kit.wall, kit.window, kit.door, kit.beltPanel, kit.pillar, kit.beam, kit.beamConnector, kit.trim, kit.roof, kit.floor].flatMap((l) => l ?? []);

const PAINT_FILE = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data"), "paints.json");

/** Kit name -> building class -> its paint properties (mCustomizationData, mColorSlot), as the source blueprints paint it most often. */
export type Paints = Record<string, Record<string, unknown>>;

export function learnPaints(blueprints: Blueprint[]): Paints {
  const paints: Paints = {};
  for (const kit of KITS) {
    const counts = new Map<string, Map<string, { value: unknown; n: number }>>();
    for (const bp of blueprints.filter((b) => kit.sources.some((s) => b.name.includes(s)))) {
      for (const o of bp.objects as any[]) {
        const custom = o.properties?.mCustomizationData;
        if (!custom || !o.transform) continue;
        const cls = o.typePath.split(".").pop() as string;
        const paint = { mCustomizationData: custom, ...(o.properties.mColorSlot ? { mColorSlot: o.properties.mColorSlot } : {}) };
        const key = JSON.stringify(paint);
        if (!counts.has(cls)) counts.set(cls, new Map());
        const entry = counts.get(cls)!.get(key) ?? { value: paint, n: 0 };
        entry.n++;
        counts.get(cls)!.set(key, entry);
      }
    }
    paints[kit.name] = Object.fromEntries([...counts].map(([cls, m]) => [cls, [...m.values()].sort((a, b) => b.n - a.n)[0].value]));
  }
  return paints;
}

export function savePaints(paints: Paints): void {
  fs.writeFileSync(PAINT_FILE, JSON.stringify(paints));
}

let cached: Paints | undefined;
export function loadPaints(): Paints {
  if (!cached) cached = fs.existsSync(PAINT_FILE) ? JSON.parse(fs.readFileSync(PAINT_FILE, "utf8")) : {};
  return cached!;
}
