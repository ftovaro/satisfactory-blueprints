export type ItemForm = "solid" | "liquid" | "gas";

export interface Item {
  /** e.g. "Desc_IronPlate_C" */
  className: string;
  /** e.g. "Iron Plate" */
  name: string;
  form: ItemForm;
  /** Mined or extracted resource (ore, water, crude oil, ...). */
  raw: boolean;
  /** Full asset path, filled in when a recipe references the item. */
  path: string;
  /** Energy released when burned: MJ per item, or per m³ for fluids. */
  energy?: number;
}

export interface Flow {
  item: string;
  /** Items per craft, or m³ per craft for fluids. */
  amount: number;
}

export interface Recipe {
  className: string;
  name: string;
  /** Full asset path used by machines' mCurrentRecipe. */
  path: string;
  alternate: boolean;
  /** Machine class that runs it, e.g. "Build_ConstructorMk1_C". */
  machine: string;
  /** Seconds per craft at 100% clock. */
  duration: number;
  inputs: Flow[];
  outputs: Flow[];
}

export interface Machine {
  className: string;
  name: string;
  /** MW at 100% clock (average for variable-power machines). */
  power: number;
  powerExponent: number;
  shardSlots: number;
}

/** A power generator that burns fuel (Coal, Fuel-Powered, ...). Power and fuel use scale linearly with the clock. */
export interface Generator {
  className: string;
  name: string;
  /** MW at 100% clock. */
  power: number;
  /** Item classes it can burn. */
  fuels: string[];
  /** Item class it also needs (e.g. water for coal generators), if any. */
  supplemental?: string;
}

export interface Transport {
  className: string;
  name: string;
  kind: "belt" | "lift" | "pipe";
  /** Items per minute (belts, lifts) or m³ per minute (pipes). */
  perMinute: number;
}

export interface GameData {
  source: { file: string; importedAt: string };
  items: Record<string, Item>;
  recipes: Record<string, Recipe>;
  machines: Record<string, Machine>;
  generators?: Record<string, Generator>;
  belts: Transport[];
  lifts: Transport[];
  pipes: Transport[];
}
