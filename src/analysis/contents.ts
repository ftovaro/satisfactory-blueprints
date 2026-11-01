import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { GameData, Generator } from "../gamedata/types.js";

/**
 * What a blueprint does, read from its contents: machines with their recipes and clock speeds give
 * the items it takes in, makes and has left over; generators give the power it produces.
 */
export interface BlueprintContents {
  /** Machine class -> count (production machines and generators). */
  machines: Record<string, number>;
  /** Machines placed without a recipe. */
  idleMachines: number;
  /** Net items per minute (m³ for fluids): positive = leaves the blueprint, negative = must be supplied. */
  net: Record<string, number>;
  /** Items some recipe makes as its main (first) product. */
  primaryOutputs: Set<string>;
  /** MW produced by generators at their clock speeds. */
  powerMW: number;
  /** MW used by machines at their clock speeds. */
  usesMW: number;
  /** Counts of other notable buildings (truck stations, storage, ...). */
  other: Record<string, number>;
}

const OTHER = /Build_(TruckStation|TrainStation|TrainDockingStation\w*|StorageContainerMk\d|IndustrialTank|PipeStorageTank|WaterPump|OilPump|MinerMk\d|ResourceSink|Workbench\w*|SpaceElevator|RailroadTrack\w*|Foundation\w*Asphalt\w*|Ramp\w*Asphalt\w*)_C$/;

export function analyzeContents(bp: Blueprint, data: GameData): BlueprintContents {
  const recipesByPath = new Map(Object.values(data.recipes).map((r) => [r.path, r]));
  const contents: BlueprintContents = { machines: {}, idleMachines: 0, net: {}, primaryOutputs: new Set(), powerMW: 0, usesMW: 0, other: {} };
  const add = (item: string, perMinute: number) => (contents.net[item] = (contents.net[item] ?? 0) + perMinute);
  const generators: { generator: Generator; megawatts: number }[] = [];
  for (const o of bp.objects as any[]) {
    if (!o.transform) continue;
    const cls = o.typePath.split(".").pop() as string;
    const props = o.properties ?? {};
    const clock = props.mCurrentPotential?.value ?? props.mPendingPotential?.value ?? 1;
    const machine = data.machines[cls];
    const generator = data.generators?.[cls];
    if (machine) {
      contents.machines[cls] = (contents.machines[cls] ?? 0) + 1;
      const recipe = recipesByPath.get(props.mCurrentRecipe?.value?.pathName);
      if (!recipe) {
        contents.idleMachines++;
        continue;
      }
      contents.usesMW += machine.power * Math.pow(clock, machine.powerExponent || 1.321928);
      for (const f of recipe.inputs) add(f.item, (-f.amount * 60 * clock) / recipe.duration);
      for (const f of recipe.outputs) add(f.item, (f.amount * 60 * clock) / recipe.duration);
      contents.primaryOutputs.add(recipe.outputs[0].item);
    } else if (generator) {
      contents.machines[cls] = (contents.machines[cls] ?? 0) + 1;
      contents.powerMW += generator.power * clock;
      generators.push({ generator, megawatts: generator.power * clock });
    } else {
      const m = cls.match(OTHER);
      if (m) contents.other[m[1]] = (contents.other[m[1]] ?? 0) + 1;
    }
  }
  // Generators burn the fuel the blueprint makes most of, else the first one they take (and their
  // supplemental resource, e.g. water for coal).
  const made = { ...contents.net };
  for (const { generator, megawatts } of generators) {
    const fuel = [...generator.fuels].sort((a, b) => (made[b] ?? 0) - (made[a] ?? 0))[0];
    const energy = data.items[fuel]?.energy;
    if (energy) add(fuel, (-megawatts * 60) / energy);
    if (generator.supplemental && generator.supplementalPerMW) add(generator.supplemental, -megawatts * generator.supplementalPerMW);
  }
  for (const [item, v] of Object.entries(contents.net)) if (Math.abs(v) < 1e-6) delete contents.net[item];
  return contents;
}
