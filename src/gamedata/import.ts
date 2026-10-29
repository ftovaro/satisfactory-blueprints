import * as fs from "node:fs";
import * as path from "node:path";
import { GameData, Item, ItemForm, Generator, Machine, Recipe, Transport } from "./types.js";

/**
 * Imports game data from the Docs file that ships with Satisfactory
 * (`<game>/CommunityResources/Docs/en-US.json`). The file is owned by Coffee Stain Studios, so it is
 * read from the player's own install and the converted result is kept out of the repository.
 */

const DEFAULT_GAME_DIRS = [
  "C:/Program Files (x86)/Steam/steamapps/common/Satisfactory",
  "C:/Program Files/Epic Games/SatisfactoryEarlyAccess",
  "C:/Program Files/Epic Games/Satisfactory",
  path.join(process.env.HOME ?? "", ".steam/steam/steamapps/common/Satisfactory"),
];

export function findDocsFile(gameDir?: string): string {
  const dirs = gameDir ? [gameDir] : [process.env.SATISFACTORY_GAME_DIR, ...DEFAULT_GAME_DIRS].filter((d): d is string => !!d);
  for (const dir of dirs) {
    const file = path.join(dir, "CommunityResources", "Docs", "en-US.json");
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`Could not find CommunityResources/Docs/en-US.json. Pass --game-dir <Satisfactory install folder> or set SATISFACTORY_GAME_DIR.`);
}

/** The Docs file is UTF-16 LE with a BOM on current versions, UTF-8 on some older ones. */
function readDocs(file: string): { NativeClass: string; Classes: Record<string, string>[] }[] {
  const bytes = fs.readFileSync(file);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le").slice(1) : bytes.toString("utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

/** "/Script/Engine.BlueprintGeneratedClass'/Game/.../Desc_X.Desc_X_C'" -> "/Game/.../Desc_X.Desc_X_C" */
const unquotePath = (raw: string) => raw.replace(/^.*?'(.*)'$/, "$1").replace(/^"|"$/g, "");
const classOf = (gamePath: string) => gamePath.split(".").pop()!;

/** Parses "((ItemClass=\"...\",Amount=3),(ItemClass=\"...\",Amount=1000))". */
function parseAmounts(raw: string | undefined): { path: string; amount: number }[] {
  if (!raw) return [];
  return [...raw.matchAll(/ItemClass="?([^",]+)"?,Amount=(\d+)/g)].map((m) => ({ path: unquotePath(m[1]), amount: Number(m[2]) }));
}

/** Parses '("/Game/a.a_C","/Game/b.b_C")'. */
function parsePathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const FORMS: Record<string, ItemForm> = { RF_SOLID: "solid", RF_LIQUID: "liquid", RF_GAS: "gas" };

export function importGameData(docsFile: string): GameData {
  const groups = readDocs(docsFile);
  const classesOf = (nativeClass: string) => groups.filter((g) => g.NativeClass.endsWith(`.${nativeClass}'`)).flatMap((g) => g.Classes);

  const items: Record<string, Item> = {};
  const itemGroups = ["FGItemDescriptor", "FGResourceDescriptor", "FGItemDescriptorBiomass", "FGItemDescriptorNuclearFuel",
    "FGConsumableDescriptor", "FGEquipmentDescriptor", "FGPowerShardDescriptor", "FGItemDescriptorPowerBoosterFuel", "FGAmmoTypeProjectile",
    "FGAmmoTypeSpreadshot", "FGAmmoTypeInstantHit"];
  for (const group of itemGroups) {
    for (const c of classesOf(group)) {
      items[c.ClassName] = {
        className: c.ClassName,
        name: c.mDisplayName,
        form: FORMS[c.mForm] ?? "solid",
        raw: group === "FGResourceDescriptor",
        path: "",
        // mEnergyValue is MJ per item, or per liter for fluids.
        ...(Number(c.mEnergyValue) > 0 ? { energy: Number(c.mEnergyValue) * (FORMS[c.mForm] && FORMS[c.mForm] !== "solid" ? 1000 : 1) } : {}),
      };
    }
  }

  const machines: Record<string, Machine> = {};
  for (const group of ["FGBuildableManufacturer", "FGBuildableManufacturerVariablePower"]) {
    for (const c of classesOf(group)) {
      const variable = group.endsWith("VariablePower");
      machines[c.ClassName] = {
        className: c.ClassName,
        name: c.mDisplayName,
        power: variable ? (Number(c.mEstimatedMininumPowerConsumption) + Number(c.mEstimatedMaximumPowerConsumption)) / 2 : Number(c.mPowerConsumption),
        powerExponent: Number(c.mPowerConsumptionExponent),
        shardSlots: Number(c.mProductionShardSlotSize ?? 0),
      };
    }
  }

  const generators: Record<string, Generator> = {};
  for (const c of classesOf("FGBuildableGeneratorFuel")) {
    const fuels = (c.mFuel as unknown as { mFuelClass: string; mSupplementalResourceClass: string }[] | undefined) ?? [];
    generators[c.ClassName] = {
      className: c.ClassName,
      name: c.mDisplayName,
      power: Number(c.mPowerProduction),
      fuels: fuels.map((f) => f.mFuelClass).filter((cls) => items[cls]),
      ...(fuels[0]?.mSupplementalResourceClass ? { supplemental: fuels[0].mSupplementalResourceClass } : {}),
    };
  }

  const recipes: Record<string, Recipe> = {};
  for (const c of classesOf("FGRecipe")) {
    const producedIn = parsePathList(c.mProducedIn).map(classOf).filter((cls) => machines[cls]);
    if (producedIn.length === 0) continue; // build-gun, workbench-only or equipment recipes
    const toFlow = (entries: { path: string; amount: number }[]) =>
      entries.map(({ path: itemPath, amount }) => {
        const cls = classOf(itemPath);
        const item = items[cls];
        if (item) item.path = itemPath;
        // Fluids are stored in liters; convert to m³ like the in-game UI.
        return { item: cls, amount: item && item.form !== "solid" ? amount / 1000 : amount };
      });
    recipes[c.ClassName] = {
      className: c.ClassName,
      name: c.mDisplayName,
      path: c.FullName.replace(/^\S+\s+/, ""),
      alternate: /^Recipe_Alternate_/.test(c.ClassName) || /^Alternate:/.test(c.mDisplayName),
      machine: producedIn[0],
      duration: Number(c.mManufactoringDuration),
      inputs: toFlow(parseAmounts(c.mIngredients)),
      outputs: toFlow(parseAmounts(c.mProduct)),
    };
  }

  const transport = (group: string, kind: Transport["kind"], toPerMinute: (c: Record<string, string>) => number) =>
    classesOf(group)
      .map((c): Transport => ({ className: c.ClassName, name: c.mDisplayName, kind, perMinute: toPerMinute(c) }))
      .sort((a, b) => a.perMinute - b.perMinute);

  return {
    source: { file: path.basename(docsFile), importedAt: new Date().toISOString() },
    items,
    recipes,
    machines,
    generators,
    // Conveyor mSpeed / 2 gives items per minute (60, 120, 270, 480, 780, 1200 as shown in-game).
    belts: transport("FGBuildableConveyorBelt", "belt", (c) => Number(c.mSpeed) / 2),
    lifts: transport("FGBuildableConveyorLift", "lift", (c) => Number(c.mSpeed) / 2),
    // Pipeline mFlowLimit is m³ per second.
    pipes: transport("FGBuildablePipeline", "pipe", (c) => Number(c.mFlowLimit) * 60).filter((p) => !/NoIndicator/.test(p.className)),
  };
}
