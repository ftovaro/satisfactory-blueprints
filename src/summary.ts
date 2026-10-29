import { Blueprint, SaveEntity, isSaveEntity } from "@etothepii/satisfactory-file-parser";

export interface BlueprintSummary {
  name: string;
  description: string;
  saveVersion: number;
  buildVersion: number;
  dimensions: string;
  objectCount: number;
  buildings: Record<string, number>;
  recipes: string[];
  cost: Record<string, number>;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** "/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C" -> "ConstructorMk1" */
export function shortName(typePath: string): string {
  const last = typePath.split(".").pop() ?? typePath;
  return last.replace(/^(Build_|Recipe_|Desc_|BP_)/, "").replace(/_C$/, "");
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function computeBounds(entities: SaveEntity[]): BlueprintSummary["bounds"] {
  if (entities.length === 0) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { transform } of entities) {
    const t = transform.translation;
    [t.x, t.y, t.z].forEach((value, axis) => {
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    });
  }
  return { min, max };
}

export function summarize(blueprint: Blueprint): BlueprintSummary {
  const entities = blueprint.objects.filter(isSaveEntity);
  const dim = blueprint.header.designerDimension;

  return {
    name: blueprint.name,
    description: blueprint.config.description,
    saveVersion: blueprint.header.saveVersion,
    buildVersion: blueprint.header.buildVersion,
    dimensions: dim ? `${dim.x} x ${dim.y} x ${dim.z}` : "unknown",
    objectCount: blueprint.objects.length,
    buildings: countBy(entities, (e) => shortName(e.typePath)),
    recipes: blueprint.header.recipeReferences.map((r) => shortName(r.pathName)),
    cost: Object.fromEntries(blueprint.header.itemCosts.map(([ref, amount]) => [shortName(ref.pathName), amount])),
    bounds: computeBounds(entities),
  };
}

export function formatSummary(s: BlueprintSummary): string {
  const lines = [
    `Blueprint:   ${s.name}`,
    `Description: ${s.description || "(none)"}`,
    `Version:     save ${s.saveVersion}, build ${s.buildVersion}`,
    `Designer:    ${s.dimensions} (foundations)`,
    `Objects:     ${s.objectCount}`,
  ];
  if (s.bounds) {
    const fmt = (v: number[]) => v.map((n) => n.toFixed(0)).join(", ");
    lines.push(`Bounds (cm): min [${fmt(s.bounds.min)}]  max [${fmt(s.bounds.max)}]`);
  }
  lines.push("", "Buildings:");
  for (const [type, count] of Object.entries(s.buildings)) lines.push(`  ${String(count).padStart(4)}  ${type}`);
  lines.push("", "Cost:");
  for (const [item, amount] of Object.entries(s.cost)) lines.push(`  ${String(amount).padStart(6)}  ${item}`);
  return lines.join("\n");
}
