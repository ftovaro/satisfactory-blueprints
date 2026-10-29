import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GameData, Item, Recipe, Transport } from "./types.js";

export * from "./types.js";

export const GAME_DATA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "game", "gamedata.json");

let cached: GameData | undefined;
export function loadGameData(file = GAME_DATA_FILE): GameData {
  if (!cached) {
    if (!fs.existsSync(file)) throw new Error(`Game data not found. Run "sbp import-game-data" first (it reads your Satisfactory install).`);
    cached = JSON.parse(fs.readFileSync(file, "utf8")) as GameData;
  }
  return cached;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Finds an item by display name ("Iron Plate"), class name ("Desc_IronPlate_C") or short name ("IronPlate"). */
export function findItem(data: GameData, query: string): Item {
  const q = normalize(query);
  const all = Object.values(data.items);
  const exact = all.find((i) => normalize(i.name) === q || normalize(i.className) === q || normalize(i.className.replace(/^Desc_|_C$/g, "")) === q);
  if (exact) return exact;
  const partial = all.filter((i) => normalize(i.name).includes(q));
  if (partial.length === 1) return partial[0];
  const hint = partial.length > 1 ? ` Did you mean: ${partial.slice(0, 8).map((i) => i.name).join(", ")}?` : "";
  throw new Error(`Unknown item "${query}".${hint}`);
}

/** Recipes that produce an item, standard ones first. Packaging/unpackaging recipes are excluded. */
export function recipesFor(data: GameData, itemClass: string): Recipe[] {
  return Object.values(data.recipes)
    .filter((r) => r.outputs.some((o) => o.item === itemClass))
    .filter((r) => !/^Recipe_(Un)?[Pp]ackage/.test(r.className))
    .sort((a, b) => Number(a.alternate) - Number(b.alternate) || a.name.localeCompare(b.name));
}

/** Finds a recipe by display name ("Alternate: Steel Screws"), class name or short name ("Alternate_Screw_2"). */
export function findRecipe(data: GameData, query: string): Recipe {
  const q = normalize(query);
  const all = Object.values(data.recipes);
  const found = all.find((r) => normalize(r.name) === q || normalize(r.className) === q || normalize(r.className.replace(/^Recipe_|_C$/g, "")) === q)
    ?? all.find((r) => normalize(r.name.replace(/^Alternate:\s*/, "")) === q);
  if (!found) throw new Error(`Unknown recipe "${query}". Use "sbp recipes <item>" to list recipes.`);
  return found;
}

/** Smallest transport tier that carries the rate, or undefined when even the best tier is too slow. */
export function pickTier(tiers: Transport[], perMinute: number): Transport | undefined {
  return tiers.find((t) => t.perMinute + 1e-9 >= perMinute);
}

/** Belts for solids, pipes for fluids. */
export function transportsFor(data: GameData, item: Item): Transport[] {
  return item.form === "solid" ? data.belts : data.pipes;
}
