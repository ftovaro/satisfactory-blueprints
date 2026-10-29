import { GameData, Item, Recipe, Transport, findItem, findRecipe, pickTier, recipesFor, transportsFor } from "../gamedata/index.js";

/**
 * Production planner: from a target item and rate, works out every production step, how many
 * machines each step needs, their clock speeds, and which belt or pipe tier each flow requires.
 *
 * Clock rule: every machine runs at 100% except the last one in a step, which takes the remainder.
 */

export interface PlanOptions {
  /** Recipe to use for specific items: item query -> recipe query. */
  recipes?: Record<string, string>;
  /** Items supplied from outside the factory instead of being produced (raw resources always are). */
  inputs?: string[];
}

export interface Rate {
  item: Item;
  perMinute: number;
  /** Cheapest belt/pipe that carries this rate; undefined if even the best tier is too slow. */
  transport?: Transport;
}

export interface Step {
  recipe: Recipe;
  /** The item this step exists for. */
  product: Item;
  /** Machines needed and the clock (fraction, 1 = 100%) of each one. */
  clocks: number[];
  /** Output of the product per machine at 100%. */
  productPerMachine: number;
  inputs: Rate[];
  outputs: Rate[];
  /** MW for the whole step. */
  power: number;
}

export interface Plan {
  target: Rate;
  /** Ordered from raw materials toward the target. */
  steps: Step[];
  /** Items the factory needs from outside. */
  inputs: Rate[];
  /** Byproducts that leave the factory unused. */
  byproducts: Rate[];
  power: number;
  warnings: string[];
}

const EPSILON = 1e-6;

/** Per-minute rate of an item in a recipe at 100% clock. */
export function perMinute(recipe: Recipe, itemClass: string, side: "inputs" | "outputs"): number {
  const flow = recipe[side].find((f) => f.item === itemClass);
  return flow ? (flow.amount * 60) / recipe.duration : 0;
}

/** Machine count and clocks: full machines plus one machine for the remainder. */
export function machineClocks(rate: number, perMachine: number): number[] {
  const full = Math.floor(rate / perMachine + EPSILON);
  const remainder = rate - full * perMachine;
  const clocks = new Array(full).fill(1);
  if (remainder > EPSILON * perMachine) clocks.push(remainder / perMachine);
  return clocks;
}

export function plan(data: GameData, targetQuery: string, rate: number, options: PlanOptions = {}): Plan {
  if (!(rate > 0)) throw new Error("Rate must be a positive number of items (or m³) per minute.");
  const target = findItem(data, targetQuery);
  const external = new Set((options.inputs ?? []).map((q) => findItem(data, q).className));
  const chosen = new Map<string, Recipe>();
  for (const [itemQuery, recipeQuery] of Object.entries(options.recipes ?? {})) {
    const item = findItem(data, itemQuery);
    const recipe = findRecipe(data, recipeQuery);
    if (!recipe.outputs.some((o) => o.item === item.className)) throw new Error(`"${recipe.name}" does not produce ${item.name}.`);
    chosen.set(item.className, recipe);
  }
  const warnings: string[] = [];

  const isInput = (cls: string) => cls !== target.className && (data.items[cls]?.raw || external.has(cls));
  const recipeFor = (cls: string): Recipe => {
    const existing = chosen.get(cls);
    if (existing) return existing;
    // Standard recipes first; some items (e.g. Turbofuel) only have recipes the game files mark as alternates.
    const all = recipesFor(data, cls);
    const primary = all.filter((r) => r.outputs[0].item === cls);
    const pool = primary.length > 0 ? primary : all;
    const candidates = pool.some((r) => !r.alternate) ? pool.filter((r) => !r.alternate) : pool;
    if (candidates.length === 0) throw new Error(`No recipe produces ${data.items[cls]?.name ?? cls}. Mark it as an input.`);
    if (candidates[0].alternate) warnings.push(`${data.items[cls].name} has no standard recipe; using "${candidates[0].name}".`);
    chosen.set(cls, candidates[0]);
    return candidates[0];
  };

  // Order items so every consumer comes before its ingredients (depth-first, cycles rejected).
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (cls: string, trail: string[]) => {
    if (isInput(cls) || state.get(cls) === "done") return;
    if (state.get(cls) === "visiting") throw new Error(`Recipe loop: ${[...trail, cls].map((c) => data.items[c]?.name ?? c).join(" -> ")}`);
    state.set(cls, "visiting");
    for (const input of recipeFor(cls).inputs) visit(input.item, [...trail, cls]);
    state.set(cls, "done");
    order.push(cls);
  };
  visit(target.className, []);
  order.reverse();

  const demand = new Map<string, number>([[target.className, rate]]);
  const supplied = new Map<string, number>();
  const steps: Step[] = [];
  for (const cls of order) {
    // Byproducts of earlier steps may already cover part of the demand.
    const needed = (demand.get(cls) ?? 0) - (supplied.get(cls) ?? 0);
    if (needed <= EPSILON) continue;
    const recipe = recipeFor(cls);
    const productPerMachine = perMinute(recipe, cls, "outputs");
    const clocks = machineClocks(needed, productPerMachine);
    const scale = needed / productPerMachine;

    const toRate = (itemClass: string, perMin: number): Rate => {
      const item = data.items[itemClass];
      return { item, perMinute: perMin, transport: pickTier(transportsFor(data, item), perMin) };
    };
    const inputs = recipe.inputs.map((f) => toRate(f.item, perMinute(recipe, f.item, "inputs") * scale));
    const outputs = recipe.outputs.map((f) => toRate(f.item, perMinute(recipe, f.item, "outputs") * scale));
    for (const input of inputs) demand.set(input.item.className, (demand.get(input.item.className) ?? 0) + input.perMinute);
    for (const output of outputs) supplied.set(output.item.className, (supplied.get(output.item.className) ?? 0) + output.perMinute);

    const machine = data.machines[recipe.machine];
    const power = clocks.reduce((sum, c) => sum + machine.power * Math.pow(c, machine.powerExponent), 0);
    steps.push({ recipe, product: data.items[cls], clocks, productPerMachine, inputs, outputs, power });
  }

  const rateOf = (cls: string, perMin: number): Rate => {
    const item = data.items[cls];
    return { item, perMinute: perMin, transport: pickTier(transportsFor(data, item), perMin) };
  };
  const inputs = [...demand]
    .filter(([cls]) => isInput(cls))
    .map(([cls, perMin]) => rateOf(cls, perMin - (supplied.get(cls) ?? 0)))
    .filter((r) => r.perMinute > EPSILON);
  const byproducts = [...supplied]
    .map(([cls, perMin]) => rateOf(cls, perMin - (demand.get(cls) ?? 0)))
    .filter((r) => r.perMinute > EPSILON && r.item.className !== target.className);

  const targetRate = rateOf(target.className, rate);
  for (const r of [targetRate, ...inputs, ...byproducts, ...steps.flatMap((s) => [...s.inputs, ...s.outputs])]) {
    if (!r.transport) warnings.push(`${r.item.name} at ${fmt(r.perMinute)}/min exceeds the fastest ${r.item.form === "solid" ? "belt" : "pipe"}; split it across several lines.`);
  }

  return {
    target: targetRate,
    steps: steps.reverse(),
    inputs,
    byproducts,
    power: steps.reduce((sum, s) => sum + s.power, 0),
    warnings: [...new Set(warnings)],
  };
}

export const fmt = (n: number) => (Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2));
