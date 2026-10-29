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

/**
 * Templates captured from blueprints of a single save version. Objects are serialized according to
 * the blueprint header's version, so a generated blueprint must never mix templates from different
 * versions (doing so crashed the game when placing it).
 */
export interface TemplateLibrary {
  /** Header and compression settings copied from the newest blueprint of this save version. */
  header: Blueprint["header"];
  compressionInfo: Blueprint["compressionInfo"];
  types: Record<string, BuildingTemplate>;
}

export interface TemplateCatalog {
  /** One library per save version, newest first. */
  versions: TemplateLibrary[];
}

/** Oldest save version to keep templates for (Satisfactory 1.0). */
const MIN_SAVE_VERSION = 46;

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

/** Captures one template per building type for every save version found (1.0 and newer). */
export function extractTemplates(blueprints: Blueprint[], wantedTypes?: (typePath: string) => boolean): TemplateCatalog {
  const byVersion = new Map<number, Blueprint[]>();
  for (const blueprint of blueprints) {
    const version = blueprint.header.saveVersion;
    if (version < MIN_SAVE_VERSION) continue;
    byVersion.set(version, [...(byVersion.get(version) ?? []), blueprint]);
  }
  const versions = [...byVersion.keys()]
    .sort((a, b) => b - a)
    .map((version) => extractLibrary(byVersion.get(version)!, wantedTypes))
    .filter((library) => Object.keys(library.types).length > 0);
  return { versions };
}

function extractLibrary(blueprints: Blueprint[], wantedTypes?: (typePath: string) => boolean): TemplateLibrary {
  const sorted = [...blueprints].sort((a, b) => b.header.buildVersion - a.header.buildVersion);
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

export function saveTemplates(catalog: TemplateCatalog, file = TEMPLATE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog, replacer));
}

let cached: TemplateCatalog | undefined;
export function loadTemplates(file = TEMPLATE_FILE): TemplateCatalog {
  if (!cached) {
    if (!fs.existsSync(file)) throw new Error(`Template library not found at ${file}. Run "sbp learn" first.`);
    cached = JSON.parse(fs.readFileSync(file, "utf8"), reviver) as TemplateCatalog;
  }
  return cached;
}

/** Newest single-version library that has templates for every required building type (class names like "Build_ConstructorMk1_C"). */
export function selectLibrary(requiredTypes: string[], catalog = loadTemplates()): TemplateLibrary {
  const has = (library: TemplateLibrary, type: string) => Object.keys(library.types).some((t) => t.endsWith(`.${type}`));
  const library = catalog.versions.find((lib) => requiredTypes.every((type) => has(lib, type)));
  if (!library) {
    const missing = requiredTypes.filter((type) => !catalog.versions.some((lib) => has(lib, type)));
    throw new Error(
      missing.length > 0
        ? `No template for: ${missing.join(", ")}. Add a blueprint containing them and run "sbp learn".`
        : `No single game version has templates for all of: ${requiredTypes.join(", ")}. Add a blueprint containing them and run "sbp learn".`,
    );
  }
  return library;
}
