import { GameData, Recipe } from "../gamedata/index.js";
import { fmt, machineClocks, perMinute } from "../planner/plan.js";
import { MACHINES } from "../data/machines.js";
import { MachineRowOptions, PortSpec } from "./machine-row.js";

/**
 * Row options for producing `rate` per minute of a recipe's first product: machine count and clocks
 * (100% except the last machine), one port per ingredient and product, and the belt/pipe speeds
 * used to size every manifold segment.
 */
export function rowOptionsFor(data: GameData, recipe: Recipe, rate: number, belt?: number): Omit<MachineRowOptions, "pole" | "name"> {
  const spec = Object.values(MACHINES).find((m) => m.type === recipe.machine);
  if (!spec) throw new Error(`"${recipe.name}" runs in a ${data.machines[recipe.machine].name}; supported machines: ${Object.keys(MACHINES).join(", ")}.`);

  // The rate applies to the first product; other products (byproducts) follow from the recipe.
  const product = recipe.outputs[0].item;
  const clocks = machineClocks(rate, perMinute(recipe, product, "outputs"));
  const port = (side: "inputs" | "outputs") => (f: { item: string }): PortSpec => ({
    label: data.items[f.item].name,
    kind: data.items[f.item].form === "solid" ? "belt" : "pipe",
    perMachine: clocks.map((c) => perMinute(recipe, f.item, side) * c),
  });
  return {
    machine: spec.key,
    count: clocks.length,
    clocks,
    recipe: recipe.path,
    label: `${fmt(rate)} ${data.items[product].name}`,
    inputs: recipe.inputs.map(port("inputs")),
    outputs: recipe.outputs.map(port("outputs")),
    belt,
    speeds: { belt: data.belts.map((t) => t.perMinute), pipe: data.pipes.map((t) => t.perMinute) },
  };
}
