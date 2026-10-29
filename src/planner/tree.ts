import { GameData, Recipe, findItem, findRecipe, recipesFor } from "../gamedata/index.js";
import { perMinute } from "./plan.js";

/**
 * Production tree for a complete factory. Unlike the flat plan, every node feeds exactly one parent:
 * an intermediate needed by two steps gets two separate machine groups. That costs at most one
 * partially clocked machine per extra group, and in exchange every connection is a single belt from
 * a child's output to its parent's input, which keeps the stacked layout simple and predictable.
 */
export interface TreeNode {
  recipe: Recipe;
  /** Item this node produces for its parent (the recipe's first product). */
  product: string;
  /** Per minute of `product`. */
  rate: number;
  /** One entry per recipe ingredient, in recipe order. */
  inputs: { item: string; perMinute: number; node?: TreeNode }[];
  /** 0 for the final product, +1 per level below. */
  depth: number;
}

export interface TreeOptions {
  /** Recipe to use for specific items: item query -> recipe query. */
  recipes?: Record<string, string>;
  /** Items supplied from outside the factory instead of being produced (raw resources always are). */
  inputs?: string[];
}

export function planTree(data: GameData, targetQuery: string, rate: number, options: TreeOptions = {}): TreeNode {
  if (!(rate > 0)) throw new Error("Rate must be a positive number per minute.");
  const target = findItem(data, targetQuery);
  const external = new Set((options.inputs ?? []).map((q) => findItem(data, q).className));
  const chosen = new Map<string, Recipe>();
  for (const [itemQuery, recipeQuery] of Object.entries(options.recipes ?? {})) {
    const item = findItem(data, itemQuery);
    const recipe = findRecipe(data, recipeQuery);
    if (!recipe.outputs.some((o) => o.item === item.className)) throw new Error(`"${recipe.name}" does not produce ${item.name}.`);
    chosen.set(item.className, recipe);
  }
  const recipeFor = (cls: string): Recipe => {
    const recipe = chosen.get(cls) ?? recipesFor(data, cls).find((r) => !r.alternate);
    if (!recipe) throw new Error(`No standard recipe produces ${data.items[cls]?.name ?? cls}. Pick one with --recipe or mark it as an input.`);
    // Put the requested product first so rates and ports refer to it.
    if (recipe.outputs[0].item !== cls) return { ...recipe, outputs: [...recipe.outputs].sort((a) => (a.item === cls ? -1 : 1)) };
    return recipe;
  };
  const isInput = (cls: string) => cls !== target.className && (data.items[cls]?.raw || external.has(cls));

  const expand = (cls: string, perMin: number, depth: number, trail: string[]): TreeNode => {
    if (trail.includes(cls)) throw new Error(`Recipe loop: ${[...trail, cls].map((c) => data.items[c]?.name ?? c).join(" -> ")}`);
    const recipe = recipeFor(cls);
    const scale = perMin / perMinute(recipe, cls, "outputs");
    return {
      recipe,
      product: cls,
      rate: perMin,
      depth,
      inputs: recipe.inputs.map((f) => {
        const need = perMinute(recipe, f.item, "inputs") * scale;
        return { item: f.item, perMinute: need, node: isInput(f.item) ? undefined : expand(f.item, need, depth + 1, [...trail, cls]) };
      }),
    };
  };
  return expand(target.className, rate, 0, []);
}

/** All nodes, parents before children. */
export function flatten(root: TreeNode): TreeNode[] {
  return [root, ...root.inputs.flatMap((i) => (i.node ? flatten(i.node) : []))];
}
