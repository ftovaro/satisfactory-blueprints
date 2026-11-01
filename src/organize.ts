import * as fs from "node:fs";
import * as path from "node:path";
import { Parser, SatisfactorySave } from "@etothepii/satisfactory-file-parser";
import { readBlueprint } from "./blueprint-io.js";
import { cloneDeep } from "./templates.js";

/**
 * Organizes a session's blueprints: new names, icons, colors and descriptions (.sbpcfg), and the
 * Blueprint menu's categories and subcategories, which the game keeps in the save file.
 *
 * - Blueprint files are renamed; their .sbp content is not touched, only the .sbpcfg is rewritten.
 * - The save is never overwritten: a new save is written next to it with the categories, and with
 *   the new names in the blueprint proxies (blueprints already placed in the world remember the
 *   name of the blueprint they came from).
 * - The session's blueprint folder is copied to a backup folder first.
 */
export interface OrganizeEntry {
  /** Current blueprint name (file name without extension). */
  from: string;
  name: string;
  category: string;
  subcategory: string;
  /** Icon ID in the game's icon library, -1 for none. */
  icon: number;
  color: { r: number; g: number; b: number };
  description: string;
}

export interface OrganizePlan {
  /** Categories in menu order, each with its subcategories in order. */
  categories: { name: string; icon: number; subcategories: string[] }[];
  entries: OrganizeEntry[];
}

const ICON_LIBRARY = "/Game/FactoryGame/-Shared/Blueprint/IconLibrary";

/**
 * Sets a BoolProperty. Newer saves store the value in the property tag's flags (0x10 = true), which
 * the parser keeps on write but does not read into `value`; both must change together.
 */
function setBool(property: { value: boolean; flags?: number }, value: boolean): void {
  property.value = value;
  if (typeof property.flags === "number") property.flags = value ? property.flags | 0x10 : property.flags & ~0x10;
}

const toArrayBuffer = (bytes: Buffer) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const safeFileName = (name: string) => name.replace(/[<>:"/\\|?*]/g, "_");

export function validatePlan(plan: OrganizePlan, blueprintDir: string): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const e of plan.entries) {
    if (!fs.existsSync(path.join(blueprintDir, `${e.from}.sbp`))) problems.push(`No blueprint "${e.from}".`);
    if (safeFileName(e.name) !== e.name) problems.push(`"${e.name}" has characters a file name cannot have.`);
    if (names.has(e.name.toLowerCase())) problems.push(`Two blueprints would be named "${e.name}".`);
    names.add(e.name.toLowerCase());
    const category = plan.categories.find((c) => c.name === e.category);
    if (!category?.subcategories.includes(e.subcategory)) problems.push(`"${e.name}": unknown category ${e.category} / ${e.subcategory}.`);
  }
  for (const f of fs.readdirSync(blueprintDir).filter((f) => f.endsWith(".sbp"))) {
    const name = f.slice(0, -4);
    if (!plan.entries.some((e) => e.from === name) && names.has(name.toLowerCase())) problems.push(`"${name}" already exists and is not in the plan.`);
  }
  return problems;
}

/** Rewrites each blueprint's .sbpcfg with its new look and renames its files. */
export function organizeBlueprints(plan: OrganizePlan, blueprintDir: string, backupDir: string): void {
  fs.cpSync(blueprintDir, backupDir, { recursive: true, errorOnExist: true, force: false });
  for (const e of plan.entries) {
    const sbp = path.join(blueprintDir, `${e.from}.sbp`);
    const blueprint = readBlueprint(sbp);
    blueprint.config.description = e.description;
    blueprint.config.iconID = e.icon;
    blueprint.config.color = { ...e.color, a: 1 };
    if (e.icon >= 0) {
      blueprint.config.referencedIconLibrary = ICON_LIBRARY;
      blueprint.config.iconLibraryType = "IconLibrary";
    }
    const { configFileBinary } = Parser.WriteBlueprintFiles(blueprint, () => undefined, () => undefined);
    const oldConfig = path.join(blueprintDir, `${e.from}.sbpcfg`);
    if (fs.existsSync(oldConfig)) fs.rmSync(oldConfig);
    fs.renameSync(sbp, path.join(blueprintDir, `${e.name}.sbp`));
    fs.writeFileSync(path.join(blueprintDir, `${e.name}.sbpcfg`), Buffer.from(configFileBinary));
  }
}

/** Reads a save, sets its blueprint categories and renames blueprint proxies, and writes it as a new file. */
export function organizeSave(plan: OrganizePlan, saveIn: string, saveOut: string): { proxies: number } {
  if (fs.existsSync(saveOut)) throw new Error(`${saveOut} already exists; pick another name.`);
  const save: SatisfactorySave = Parser.ParseSave(path.basename(saveIn, ".sav"), toArrayBuffer(fs.readFileSync(saveIn)));
  const renamed = new Map(plan.entries.map((e) => [e.from, e.name]));
  let proxies = 0;
  let subsystem: any;
  for (const level of Object.values(save.levels) as any[]) {
    for (const o of level.objects) {
      if (/BP_BlueprintSusbystem/.test(o.typePath)) subsystem = o;
      const text = o.properties?.mBlueprintName?.value;
      if (/FGBlueprintProxy/.test(o.typePath) && text && renamed.has(text.value)) {
        text.value = renamed.get(text.value);
        proxies++;
      }
    }
  }
  const records = subsystem?.properties?.mBlueprintCategoryRecords;
  if (!records?.values?.length) throw new Error("The save has no blueprint category records to model new ones on.");

  // New records are copies of the existing first ("Undefined") record, so every property keeps the
  // exact type tags the game wrote.
  const model = records.values[0];
  const subModel = model.properties.SubCategoryRecords.values[0];
  const undefinedRecord = cloneDeep(model);
  const placed = new Set(plan.entries.map((e) => e.from));
  // Blueprints not in the plan stay in the Undefined category.
  undefinedRecord.properties.SubCategoryRecords.values = undefinedRecord.properties.SubCategoryRecords.values.slice(0, 1);
  const leftover = undefinedRecord.properties.SubCategoryRecords.values[0].properties.BlueprintNames;
  leftover.values = leftover.values.filter((n: string) => !placed.has(n));

  const categories = plan.categories.map((c, i) => {
    const record = cloneDeep(model);
    record.properties.CategoryName.value = c.name;
    record.properties.IconID.value = c.icon;
    record.properties.MenuPriority.value = i + 1;
    setBool(record.properties.IsUndefined, false);
    record.properties.SubCategoryRecords.values = c.subcategories.map((s, j) => {
      const sub = cloneDeep(subModel);
      sub.properties.SubCategoryName.value = s;
      sub.properties.MenuPriority.value = j;
      sub.properties.IsUndefined.value = { ...sub.properties.IsUndefined.value, value: 0 };
      sub.properties.BlueprintNames.values = plan.entries.filter((e) => e.category === c.name && e.subcategory === s).map((e) => e.name).sort();
      return sub;
    });
    return record;
  });
  records.values = [undefinedRecord, ...categories];

  const parts: Uint8Array[] = [];
  Parser.WriteSave(save, (header) => parts.push(header), (chunk) => parts.push(chunk));
  fs.writeFileSync(saveOut, Buffer.concat(parts));
  return { proxies };
}
