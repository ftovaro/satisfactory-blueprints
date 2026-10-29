/**
 * Production machines the generators know how to place.
 * `pitch` is the distance (cm) between neighboring machines in a row; it leaves a gap for power poles.
 */

export interface MachineSpec {
  key: string;
  type: string;
  pitch: number;
  /** Building height (cm), from the wiki; decides how tall a factory floor must be. */
  height: number;
  recipes: Record<string, string>;
}

const recipe = (folder: string, name: string) => `/Game/FactoryGame/Recipes/${folder}/Recipe_${name}.Recipe_${name}_C`;

export const MACHINES: Record<string, MachineSpec> = {
  constructor: {
    key: "constructor",
    type: "Build_ConstructorMk1_C",
    pitch: 1000,
    height: 850,
    recipes: Object.fromEntries(
      ["IronPlate", "IronRod", "Screw", "Wire", "Cable", "Concrete", "CopperSheet", "Quickwire", "SteelBeam", "SteelPipe", "Silica", "AluminumCasing"]
        .map((name) => [name, recipe("Constructor", name)]),
    ),
  },
  smelter: {
    key: "smelter",
    type: "Build_SmelterMk1_C",
    pitch: 800,
    height: 850,
    recipes: Object.fromEntries(["IngotIron", "IngotCopper", "IngotCaterium"].map((name) => [name, recipe("Smelter", name)])),
  },
  // Multi-input machines: pick recipes through the game data (generate row --rate --recipe "<name>").
  assembler: { key: "assembler", type: "Build_AssemblerMk1_C", pitch: 1200, height: 1100, recipes: {} },
  foundry: { key: "foundry", type: "Build_FoundryMk1_C", pitch: 1200, height: 900, recipes: {} },
  manufacturer: { key: "manufacturer", type: "Build_ManufacturerMk1_C", pitch: 2000, height: 1200, recipes: {} },
  // Fluid machines (pipe connectors); see src/fluids.
  refinery: { key: "refinery", type: "Build_OilRefinery_C", pitch: 1200, height: 3000, recipes: {} },
  blender: { key: "blender", type: "Build_Blender_C", pitch: 2000, height: 1600, recipes: {} },
  packager: { key: "packager", type: "Build_Packager_C", pitch: 1000, height: 800, recipes: {} },
};

export function findMachine(key: string): MachineSpec {
  const spec = MACHINES[key.toLowerCase()];
  if (!spec) throw new Error(`Unknown machine "${key}". Supported: ${Object.keys(MACHINES).join(", ")}`);
  return spec;
}

/** Accepts a short recipe name from the machine's list (case-insensitive) or a full recipe path. */
export function findRecipe(spec: MachineSpec, name: string): string {
  if (name.startsWith("/Game/")) return name;
  const match = Object.entries(spec.recipes).find(([key]) => key.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`Unknown ${spec.key} recipe "${name}". Known: ${Object.keys(spec.recipes).join(", ")}`);
  return match[1];
}
