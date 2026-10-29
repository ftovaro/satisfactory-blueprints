import { Blueprint, SaveEntity, isSaveEntity } from "@etothepii/satisfactory-file-parser";
import { Vec3, directionToWorld, multiply, normalize, rotate, toWorld, vec } from "../geometry.js";
import { connectorsOf } from "../connectors.js";
import { readSpline } from "./connectors.js";

/**
 * Structural checks for any blueprint, generated or hand-made:
 *
 * - links: every connection is stored on both sides;
 * - gaps: a belt end sits exactly on the connector it is linked to (positions learned from real blueprints);
 * - kinks: two linked belts continue in the same direction;
 * - lifts: belts enter and leave a lift in the direction the lift expects;
 * - clashes: unrelated belts and lifts do not occupy the same space;
 * - power: no pole exceeds its connection limit and every machine is wired.
 *
 * Broken links, lifts fed the wrong way and overloaded poles are errors. Gaps, kinks and clashes are
 * warnings: hand-made blueprints often clip pieces on purpose, and older versions placed some
 * connectors differently. Generated blueprints are expected to have none of either.
 */

export interface CheckResult {
  errors: string[];
  warnings: string[];
  stats: Record<string, number>;
}

const POLE_LIMITS: Record<string, number> = { Build_PowerPoleMk1_C: 4, Build_PowerPoleMk2_C: 7, Build_PowerPoleMk3_C: 10 };
const shortName = (path: string) => path.split(".").slice(-2).join(".");
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

export function checkBlueprint(blueprint: Blueprint): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byName = new Map(blueprint.objects.map((o) => [o.instanceName, o as any]));
  const ownerOf = (component: string) => byName.get(component.slice(0, component.lastIndexOf("."))) as any;
  const linkOf = (component: string): string | undefined => byName.get(component)?.properties?.mConnectedComponent?.value?.pathName || undefined;
  const entities = blueprint.objects.filter(isSaveEntity) as any[];
  const isBelt = (e: SaveEntity) => /ConveyorBelt/.test(e.typePath);
  const isLift = (e: SaveEntity) => /ConveyorLift/.test(e.typePath);

  /** Position of a connector, plus the travel direction for spline ends. */
  const connectorAt = (component: string): { position: Vec3; travel?: Vec3 } | undefined => {
    const owner = ownerOf(component);
    if (!owner?.transform) return undefined;
    const name = component.split(".").pop()!;
    const spline = readSpline(owner);
    if (spline) {
      const first = name.endsWith("0");
      const point = first ? spline[0] : spline[spline.length - 1];
      return { position: toWorld(owner.transform, point.location), travel: normalize(directionToWorld(owner.transform, first ? point.leave : point.arrive)) };
    }
    if (isLift(owner)) {
      // The input sits at the transform and the output at mTopTransform, swapped on reversed lifts.
      const top = owner.properties.mTopTransform?.value?.properties?.Translation?.value ?? vec();
      const atTransform = (name === "ConveyorAny0") !== !!owner.properties.mIsReversed?.value;
      return { position: atTransform ? owner.transform.translation : toWorld(owner.transform, top) };
    }
    try {
      const learned = connectorsOf(owner.typePath).find((c) => c.name.toLowerCase() === name.toLowerCase());
      return learned ? { position: toWorld(owner.transform, learned.offset) } : undefined;
    } catch {
      return undefined;
    }
  };

  // Links, gaps and kinks.
  let links = 0;
  for (const e of entities) {
    for (const ref of e.components ?? []) {
      const target = linkOf(ref.pathName);
      if (!target) continue;
      links++;
      if (linkOf(target) !== ref.pathName) errors.push(`One-way link: ${shortName(ref.pathName)} -> ${shortName(target)}`);
      if (!isBelt(e)) continue;
      const a = connectorAt(ref.pathName);
      const b = connectorAt(target);
      if (!a || !b) continue;
      const gap = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
      if (gap > 5) warnings.push(`Gap of ${gap.toFixed(0)} cm between ${shortName(ref.pathName)} and ${shortName(target)}`);
      if (a.travel && b.travel && dot(a.travel, b.travel) < 0.9) warnings.push(`Belts meet at an angle: ${shortName(ref.pathName)} -> ${shortName(target)}`);
    }
  }

  // Lift directions: the input accepts items moving along the lift's local -X, the far end sends
  // them along its own (possibly rotated) +X.
  // Reversed lifts (older saves) store their ends swapped; only check the plain form we generate.
  for (const lift of entities.filter((e) => isLift(e) && !e.properties.mIsReversed?.value)) {
    const turn = lift.properties.mTopTransform?.value?.properties?.Rotation?.value ?? { x: 0, y: 0, z: 0, w: 1 };
    const expected: Record<string, Vec3> = {
      ConveyorAny0: rotate(lift.transform.rotation, vec(-1, 0, 0)),
      ConveyorAny1: rotate(multiply(lift.transform.rotation, turn), vec(1, 0, 0)),
    };
    for (const ref of lift.components) {
      const name = ref.pathName.split(".").pop()!;
      const target = linkOf(ref.pathName);
      if (!target) {
        warnings.push(`Lift ${shortName(ref.pathName)} is not connected`);
        continue;
      }
      const travel = connectorAt(target)?.travel;
      if (travel && expected[name] && dot(travel, expected[name]) < 0.95) errors.push(`Belt at ${shortName(ref.pathName)} moves the wrong way for the lift`);
    }
  }

  // Clashes: sample belts and lifts and look for unrelated pieces closer than 1 m.
  type Sample = { id: string; p: Vec3 };
  const samples: Sample[] = [];
  const related = new Map<string, Set<string>>();
  for (const e of entities) {
    if (!isBelt(e) && !isLift(e)) continue;
    const set = new Set<string>([e.instanceName]);
    for (const ref of e.components ?? []) {
      const t = linkOf(ref.pathName);
      if (t) set.add(t.slice(0, t.lastIndexOf(".")));
    }
    related.set(e.instanceName, set);
    if (isBelt(e)) {
      const s = readSpline(e)!;
      const [p0, p1, t0, t1] = [s[0].location, s[s.length - 1].location, s[0].leave, s[s.length - 1].arrive];
      for (let i = 1; i < 20; i++) {
        const u = i / 20;
        const h = [2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2];
        const at = (k: "x" | "y" | "z") => h[0] * p0[k] + h[1] * t0[k] + h[2] * p1[k] + h[3] * t1[k];
        samples.push({ id: e.instanceName, p: toWorld(e.transform, vec(at("x"), at("y"), at("z"))) });
      }
    } else {
      const rise = e.properties.mTopTransform?.value?.properties?.Translation?.value?.z ?? 0;
      const t = e.transform.translation;
      for (let z = Math.min(0, rise) + 100; z < Math.max(0, rise) - 100; z += 100) samples.push({ id: e.instanceName, p: vec(t.x, t.y, t.z + z) });
    }
  }
  const grid = new Map<string, Sample[]>();
  const cell = (p: Vec3) => `${Math.floor(p.x / 100)},${Math.floor(p.y / 100)},${Math.floor(p.z / 100)}`;
  for (const s of samples) grid.set(cell(s.p), [...(grid.get(cell(s.p)) ?? []), s]);
  const clashes = new Set<string>();
  for (const s of samples) {
    const [cx, cy, cz] = cell(s.p).split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const o of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (o.id === s.id || related.get(s.id)?.has(o.id) || related.get(o.id)?.has(s.id)) continue;
        if (Math.abs(o.p.x - s.p.x) < 100 && Math.abs(o.p.y - s.p.y) < 100 && Math.abs(o.p.z - s.p.z) < 100) {
          const key = [s.id, o.id].sort().join(" x ");
          if (!clashes.has(key)) {
            clashes.add(key);
            warnings.push(`Clash near (${(s.p.x / 100).toFixed(0)}, ${(s.p.y / 100).toFixed(0)}, ${(s.p.z / 100).toFixed(0)}) m: ${shortName(s.id)} x ${shortName(o.id)}`);
          }
        }
      }
    }
  }

  // Power.
  let machines = 0;
  for (const e of entities) {
    const power = (e.components ?? []).map((r: any) => byName.get(r.pathName)).find((c: any) => c?.typePath.endsWith("FGPowerConnectionComponent"));
    if (!power) continue;
    const wires = power.properties.mWires?.values?.length ?? 0;
    const limit = POLE_LIMITS[e.typePath.split(".").pop()];
    if (limit !== undefined) {
      if (wires > limit) errors.push(`${shortName(e.instanceName)} has ${wires} wires; the limit is ${limit}`);
    } else if (/PowerPole|PowerTower/.test(e.typePath)) {
      continue;
    } else {
      machines++;
      if (wires === 0) warnings.push(`${shortName(e.instanceName)} is not wired to power`);
    }
  }

  return { errors, warnings, stats: { links, samples: samples.length, poweredMachines: machines } };
}

export function formatCheck(result: CheckResult): string {
  const lines = [
    ...result.errors.slice(0, 30).map((e) => `ERROR   ${e}`),
    ...(result.errors.length > 30 ? [`... and ${result.errors.length - 30} more errors`] : []),
    ...result.warnings.slice(0, 15).map((w) => `WARNING ${w}`),
    ...(result.warnings.length > 15 ? [`... and ${result.warnings.length - 15} more warnings`] : []),
    `Structure: ${result.stats.links} links checked, ${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
  ];
  return lines.join("\n");
}
