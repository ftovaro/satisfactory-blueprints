import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Blueprint, SaveComponent, SaveEntity, isSaveEntity } from "@etothepii/satisfactory-file-parser";

/**
 * Building templates: a real entity plus its components, captured from an existing blueprint.
 *
 * Generating objects from scratch would mean reproducing every property tag the game expects.
 * Cloning a known-good object and only changing names, transforms and connections is far safer.
 * The entity's instance name is replaced with the {SELF} placeholder so it can be re-instantiated.
 */

export const SELF = "{SELF}";

export interface BuildingTemplate {
  entity: SaveEntity;
  components: SaveComponent[];
}

export interface TemplateLibrary {
  /** Header and compression settings copied from the newest blueprint the templates came from. */
  header: Blueprint["header"];
  compressionInfo: Blueprint["compressionInfo"];
  types: Record<string, BuildingTemplate>;
}

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const TEMPLATE_FILE = path.join(DATA_DIR, "templates.json");

/** Properties that only make sense for the original object and must not be copied. */
const DROPPED_PROPERTIES = ["mBuildTimeStamp", "mBlueprintProxy", "mCurrentRecipe", "mDidFirstTimeUse", "mTimeSinceStartStopProducing"];

// JSON cannot hold BigInt or -0; tag them so templates survive a save/load cycle unchanged.
const replacer = (_key: string, value: unknown) => {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === 0 && 1 / value < 0) return { $negZero: true };
  return value;
};
const reviver = (_key: string, value: any) => {
  if (value && typeof value === "object") {
    if (typeof value.$bigint === "string") return BigInt(value.$bigint);
    if (value.$negZero === true) return -0;
  }
  return value;
};

export const cloneDeep = <T>(value: T): T => JSON.parse(JSON.stringify(value, replacer), reviver);

function sanitize(entity: SaveEntity, components: SaveComponent[]): BuildingTemplate {
  const selfName = entity.instanceName;
  const text = JSON.stringify({ entity, components }, replacer).split(JSON.stringify(selfName).slice(1, -1)).join(SELF);
  const template: BuildingTemplate = JSON.parse(text, reviver);

  for (const name of DROPPED_PROPERTIES) delete (template.entity.properties as any)[name];
  for (const component of template.components) {
    const props = component.properties as any;
    delete props.mConnectedComponent;
    if (props.mWires) props.mWires.values = [];
    if (props.mHiddenConnections) props.mHiddenConnections.values = [];
  }
  const special = template.entity.specialProperties as any;
  if (special?.type === "PowerLineSpecialProperties") {
    special.source = { levelName: "", pathName: "" };
    special.target = { levelName: "", pathName: "" };
  }
  return template;
}

/** Captures one template per building type, preferring blueprints saved by the newest game version. */
export function extractTemplates(blueprints: Blueprint[], wantedTypes?: (typePath: string) => boolean): TemplateLibrary {
  const sorted = [...blueprints].sort((a, b) => b.header.saveVersion - a.header.saveVersion || b.header.buildVersion - a.header.buildVersion);
  const newest = sorted[0];
  const types: Record<string, BuildingTemplate> = {};

  for (const blueprint of sorted) {
    const byName = new Map(blueprint.objects.map((o) => [o.instanceName, o]));
    for (const obj of blueprint.objects) {
      if (!isSaveEntity(obj) || types[obj.typePath] || (wantedTypes && !wantedTypes(obj.typePath))) continue;
      const components = obj.components
        .map((ref) => byName.get(ref.pathName))
        .filter((c): c is SaveComponent => c !== undefined && !isSaveEntity(c));
      if (components.length !== obj.components.length) continue;
      const template = sanitize(obj, components);
      // Some buildings (e.g. signs) record the account of the player who edited them; never ship those.
      if (/NetIdBundle|PlayerInfo|"STEAM"|"EOS"/.test(JSON.stringify(template, replacer))) continue;
      types[obj.typePath] = template;
    }
  }

  const header = cloneDeep(newest.header);
  header.itemCosts = [];
  header.recipeReferences = [];
  return { header, compressionInfo: cloneDeep(newest.compressionInfo), types: Object.fromEntries(Object.entries(types).sort()) };
}

export function saveTemplates(library: TemplateLibrary, file = TEMPLATE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(library, replacer, 1));
}

let cached: TemplateLibrary | undefined;
export function loadTemplates(file = TEMPLATE_FILE): TemplateLibrary {
  if (!cached) {
    if (!fs.existsSync(file)) throw new Error(`Template library not found at ${file}. Run "sbp templates" first.`);
    cached = JSON.parse(fs.readFileSync(file, "utf8"), reviver) as TemplateLibrary;
  }
  return cached;
}
