import { GameData, Item } from "./gamedata/types.js";

/**
 * How blueprints are named, colored and described, so generated ones match organized sessions:
 * "[Type] Name - Product", a color per subcategory, the icon of the machine that makes the final
 * product, and a description listing rates per minute.
 */

export type Color = { r: number; g: number; b: number };

/** Blueprint menu categories and their subcategories, in menu order, with their icon names. */
export const CATEGORIES: { name: string; icon: string; subcategories: string[] }[] = [
  { name: "Power", icon: "Power", subcategories: ["Fuel", "Coal"] },
  { name: "Production", icon: "Factory", subcategories: ["Iron & Steel", "Parts", "Electronics", "Oil & Plastics", "Minerals"] },
  { name: "Modules", icon: "Thumbs Up", subcategories: ["Machine Banks"] },
  { name: "Roads", icon: "Vehicle: Tractor", subcategories: ["Roads", "Truck Stations"] },
  { name: "Buildings", icon: "Equipment Workshop", subcategories: ["Workshops"] },
  { name: "Tests", icon: "", subcategories: ["Rows", "Factories", "Other"] },
];

export const SUBCATEGORY_COLORS: Record<string, Color> = {
  Fuel: { r: 1.0, g: 0.75, b: 0.05 },
  Coal: { r: 1.0, g: 0.75, b: 0.05 },
  "Iron & Steel": { r: 0.42, g: 0.5, b: 0.58 },
  Parts: { r: 0.98, g: 0.45, b: 0.05 },
  Electronics: { r: 0.1, g: 0.45, b: 0.95 },
  "Oil & Plastics": { r: 0.45, g: 0.2, b: 0.75 },
  Minerals: { r: 0.1, g: 0.7, b: 0.65 },
  "Machine Banks": { r: 0.2, g: 0.7, b: 0.25 },
  Roads: { r: 0.3, g: 0.3, b: 0.32 },
  "Truck Stations": { r: 0.3, g: 0.3, b: 0.32 },
  Workshops: { r: 0.55, g: 0.35, b: 0.2 },
  Rows: { r: 0.55, g: 0.12, b: 0.12 },
  Factories: { r: 0.55, g: 0.12, b: 0.12 },
  Other: { r: 0.55, g: 0.12, b: 0.12 },
};

const STEEL = /Steel|Encased Industrial Beam/;
const IRON = /^(Iron (Ore|Ingot|Plate|Rod)|Screws)$/;
const ELECTRONICS = /^(Copper (Ingot|Sheet)|Caterium Ingot|Wire|Cable|Quickwire|Circuit Board|Computer|Supercomputer|High-Speed Connector|Crystal Oscillator|AI Limiter|Radio Control Unit)$/;
const MINERALS = /^(Concrete|Quartz Crystal|Silica|Limestone|Raw Quartz|Sulfur|Compacted Coal)$/;

/** Subcategory and name prefix of a factory making `item`. */
export function familyOf(item: Item): { subcategory: string; prefix: string } {
  if (item.form !== "solid" || /Plastic|Rubber|Polymer|Petroleum|Packaged|Fuel|Resin|Residue/.test(item.name)) return { subcategory: "Oil & Plastics", prefix: "Oil" };
  if (STEEL.test(item.name)) return { subcategory: "Iron & Steel", prefix: "Steel" };
  if (IRON.test(item.name)) return { subcategory: "Iron & Steel", prefix: "Iron" };
  if (ELECTRONICS.test(item.name)) return { subcategory: "Electronics", prefix: "Electronics" };
  if (MINERALS.test(item.name)) return { subcategory: "Minerals", prefix: "Minerals" };
  return { subcategory: "Parts", prefix: "Parts" };
}

const round = (v: number) => String(Math.round(v * 100) / 100);

/** "45 Steel Beam", "180 m³ Crude Oil". */
export function amount(data: GameData, itemClass: string, perMinute: number): string {
  const item = data.items[itemClass];
  return `${round(perMinute)}${item && item.form !== "solid" ? " m³" : ""} ${item?.name ?? itemClass}`;
}

export interface Description {
  inputs: string[];
  outputs: string[];
  byproducts?: string[];
  surplus?: string[];
  /** MW made by generators, if any. */
  makesMW?: number;
  usesMW: number;
  notes?: string[];
}

/** The description's lines: rates per minute, what goes in and out, and power. */
export function describe(d: Description): string {
  return [
    "Rates per minute.",
    `IN: ${d.inputs.join(", ") || "-"}`,
    `OUT: ${d.makesMW ? `${round(d.makesMW)} MW` : d.outputs.join(", ") || "-"}`,
    `BYPRODUCTS: ${d.byproducts?.join(", ") || "none"}`,
    ...(d.surplus?.length ? [`SURPLUS: ${d.surplus.join(", ")}`] : []),
    d.makesMW ? `POWER: makes ${round(d.makesMW)} MW, uses ${round(d.usesMW)} MW, net ${round(d.makesMW - d.usesMW)} MW` : `POWER: uses ${round(d.usesMW)} MW`,
    ...(d.notes ?? []),
  ].join("\n");
}
