import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BeltEnd, BlueprintBuilder, ConnectorRef, Placed } from "../builder.js";
import { Vec3, add, transform, vec } from "../geometry.js";
import { GameData } from "../gamedata/index.js";
import { fmt } from "../planner/plan.js";
import { TreeNode, TreeOptions, flatten, planTree } from "../planner/tree.js";
import { BuiltRow, PreparedRow, beltType, buildRow, libraryFor, liftType, prepareRow } from "./machine-row.js";
import { rowOptionsFor } from "./row-options.js";

/**
 * A complete factory in one blueprint: every production step of the target item, stacked in floors.
 *
 * - The production tree (src/planner/tree.ts) gives one machine row per step, each feeding exactly
 *   one parent row.
 * - Floor = height of the step's subtree: steps fed only by raw materials sit on the ground floor,
 *   every other step one floor above its highest ingredient step. Rows on a floor sit side by side.
 * - Rows alternate direction with their depth in the tree (serpentine). A row's output then leaves
 *   on the same corner where its parent's input enters.
 * - Connections run outside the floor slabs, in "lanes" at the two corners. Each one leaves its row
 *   along X, turns 90° and runs along Y to its own lane, climbs a Conveyor Lift (entering from the
 *   side), and comes back the same way into the parent row. The lanes form a staircase (the closer
 *   to the building in X, the farther out in Y) and are ordered by where they meet their rows, so
 *   paths on the same floor do not cross each other or another lane's lift.
 * - Raw materials enter at ground level through open belt ends on the blueprint edge, one per row
 *   that needs them. The final product comes down to ground level and leaves through another.
 * - Each floor stands on a slab of 8 m x 1 m foundations, and all rows share one power grid.
 *
 * Seen from the side (layout frame, before the final rotation toward the placement arrow):
 *
 *   floor 2  <== [ final row ] ==>|lift|--> down to the output port
 *   floor 1  ==> [ middle row ] ==>|lift|
 *   floor 0  <== [ raw rows   ] <==|lift|<-- raw-material ports
 */

export interface FactoryOptions extends TreeOptions {
  target: string;
  rate: number;
  name?: string;
  pole?: number;
}

const FOUNDATION = 800;
const FOUNDATION_TYPE = "Build_Foundation_Concrete_8x1_C";
/** Slab thickness (cm); machines stand on its top. */
const SLAB = 100;
/** Ground-level belts (raw inputs and the final output) run 1 m above the terrain, like machine connectors. */
const GROUND_BELT_Z = 100;
/** Gap (cm) between rows on the same floor. */
const ROW_GAP = 800;
/** Head room (cm) above the tallest thing on a floor; floors are a whole number of 4 m walls. */
const HEADROOM = 150;
const WALL = 400;
/** Lanes start this far outside the slabs and are spaced this far apart. */
const LANE_MARGIN = 600;
const LANE_SPACING = 600;
/** Horizontal hop (cm) between chained lifts; stays inside a lane. */
const ZIG = 300;
/** Radius (cm) of every 90° belt turn. */
const TURN_RADIUS = 300;
/** Longest Conveyor Lift the game allows is about 48 m; taller climbs chain several lifts. */
const MAX_LIFT = 4800;
const FLOW_TO_FRONT_YAW = -90;

interface PlacedRow {
  node: TreeNode;
  row: PreparedRow;
  floor: number;
  /** 0 (flow +X) or 180 (flow -X). */
  yaw: number;
  y: number;
  built?: BuiltRow;
  /** Ports in blueprint coordinates. */
  ports?: (BuiltRow["ports"][number] & { global: Vec3 })[];
  poleTops?: { pole: Placed; position: Vec3 }[];
}

/** One connection routed through a corner lane. */
interface LaneRoute {
  corner: 1 | -1;
  /** Where the route meets its row, used to order lanes (outermost row point gets the outermost lane). */
  rowY: number;
  build: (lane: { x: number; y: number }) => void;
}

export function generateFactory(data: GameData, options: FactoryOptions): { blueprint: Blueprint; report: string } {
  const tree = planTree(data, options.target, options.rate, options);
  const nodes = flatten(tree);
  for (const node of nodes) {
    const fluids = [...node.recipe.inputs, ...node.recipe.outputs].filter((f) => data.items[f.item].form !== "solid");
    if (fluids.length > 0) throw new Error(`"${node.recipe.name}" uses fluids; complete factories support solid-only steps for now. Generate it as a row instead.`);
    if (node.recipe.outputs.length > 1) throw new Error(`"${node.recipe.name}" has a byproduct; complete factories need single-product steps for now.`);
  }

  // Rows, floors and orientation.
  // Floor = height of the node's subtree: steps fed only by raw materials sit on the ground floor
  // (raw materials never climb), and every step sits one floor above its highest ingredient step.
  const floorOf = (node: TreeNode): number => {
    const children = node.inputs.flatMap((i) => (i.node ? [i.node] : []));
    return children.length === 0 ? 0 : 1 + Math.max(...children.map(floorOf));
  };
  const rows: PlacedRow[] = nodes.map((node) => ({
    node,
    row: prepareRow({ ...rowOptionsFor(data, node.recipe, node.rate), pole: options.pole }),
    floor: floorOf(node),
    // Orientation alternates by depth, so a child's exit corner is always its parent's entry corner.
    yaw: node.depth % 2 === 0 ? 0 : 180,
    y: 0,
  }));
  const rowOf = new Map(rows.map((r) => [r.node, r]));
  const floors = Array.from({ length: floorOf(tree) + 1 }, (_, f) => rows.filter((r) => r.floor === f));

  // Global extent of a row when turned by its yaw and shifted by y.
  const globalExtent = (r: PlacedRow) => {
    const e = r.row.extent;
    return r.yaw === 0
      ? { minX: e.minX, maxX: e.maxX, minY: e.minY + r.y, maxY: e.maxY + r.y }
      : { minX: -e.maxX, maxX: -e.minX, minY: -e.maxY + r.y, maxY: -e.minY + r.y };
  };

  // Stack each floor's rows along Y, centered on the origin.
  for (const floor of floors) {
    let cursor = 0;
    for (const r of floor) {
      const e = globalExtent({ ...r, y: 0 });
      r.y = cursor - e.minY;
      cursor = r.y + e.maxY + ROW_GAP;
    }
    const shift = (cursor - ROW_GAP) / 2;
    for (const r of floor) r.y -= shift;
  }

  // Floor elevations: slab top of floor 0 at 1 m, each floor tall enough for its rows.
  const floorZ: number[] = [];
  let z = SLAB;
  for (const floor of floors) {
    floorZ.push(z);
    const tallest = Math.max(...floor.map((r) => r.row.height));
    z += Math.ceil((tallest + SLAB + HEADROOM) / WALL) * WALL;
  }

  const extents = rows.map(globalExtent);
  const slabEdge = {
    x: Math.ceil(Math.max(...extents.map((e) => Math.max(-e.minX, e.maxX))) / FOUNDATION) * FOUNDATION,
    y: Math.ceil(Math.max(...extents.map((e) => Math.max(-e.minY, e.maxY))) / FOUNDATION) * FOUNDATION,
  };

  // Connections use the tier of the port they serve: belts plus a lift.
  const connectionTiers = rows.flatMap((r) => [...r.row.inputLines, ...r.row.outputLines].map((l) => l.tiers.end));
  const routes: LaneRoute[] = [];
  const b = new BlueprintBuilder(libraryFor(rows.map((r) => r.row), [FOUNDATION_TYPE, ...new Set(connectionTiers.flatMap((t) => [beltType(t), liftType(t)]))]));

  // Slabs: one layer of foundations per floor, covering that floor's rows.
  floors.forEach((floor, f) => {
    const e = floor.map(globalExtent);
    const x0 = Math.floor(Math.min(...e.map((x) => x.minX)) / FOUNDATION) * FOUNDATION;
    const x1 = Math.ceil(Math.max(...e.map((x) => x.maxX)) / FOUNDATION) * FOUNDATION;
    const y0 = Math.floor(Math.min(...e.map((x) => x.minY)) / FOUNDATION) * FOUNDATION;
    const y1 = Math.ceil(Math.max(...e.map((x) => x.maxY)) / FOUNDATION) * FOUNDATION;
    for (let x = x0; x < x1; x += FOUNDATION) {
      for (let y = y0; y < y1; y += FOUNDATION) {
        b.place(FOUNDATION_TYPE, transform(vec(x + FOUNDATION / 2, y + FOUNDATION / 2, floorZ[f] - SLAB / 2)));
      }
    }
  });

  // Rows, each in its own frame.
  for (const r of rows) {
    b.withFrame(transform(vec(0, r.y, floorZ[r.floor]), r.yaw), () => {
      r.built = buildRow(b, r.row);
      r.ports = r.built.ports.map((p) => ({ ...p, global: b.toBlueprint(p.point.position) }));
      r.poleTops = r.built.poles.map((p) => ({ pole: p.pole, position: b.toBlueprint(p.position) }));
    });
  }

  // Corner geometry. A row with yaw 0 flows +X: its output leaves at +X on its +Y side, its inputs
  // enter at -X on its -Y side. Yaw 180 mirrors both, so child exits and parent entries share a corner.
  const flowX = (r: PlacedRow) => (r.yaw === 0 ? 1 : -1);
  const outputCorner = (r: PlacedRow) => flowX(r) as 1 | -1;
  const inputCorner = (r: PlacedRow) => -flowX(r) as 1 | -1;

  // Routing pieces. Every path is made of straight belts and 90° turns of radius TURN_RADIUS, which
  // the game can build, and lifts that take the belt from the side.
  const X = (s: number) => vec(s, 0, 0);
  const Y = (s: number) => vec(0, s, 0);
  const straight = (tier: number, from: BeltEnd, to: Vec3): BeltEnd => {
    if (Math.hypot(to.x - from.position.x, to.y - from.position.y, to.z - from.position.z) < 10) return from;
    const belt = b.belt(beltType(tier), from, { position: to });
    return { building: belt, name: "ConveyorAny1", position: to };
  };
  const turn = (tier: number, from: BeltEnd, fromDir: Vec3, toDir: Vec3) => b.beltTurn(beltType(tier), from, fromDir, toDir, TURN_RADIUS);

  /** Row exit -> along X out of the building -> turn -> along Y out to the lane, arriving moving c·Y. */
  const legOut = (tier: number, exit: BeltEnd, c: number, lane: { x: number; y: number }, stopShort = false): BeltEnd => {
    const z = exit.position.z;
    let end = straight(tier, exit, vec(lane.x - c * TURN_RADIUS, exit.position.y, z));
    end = turn(tier, end, X(c), Y(c));
    return straight(tier, end, vec(lane.x, lane.y - (stopShort ? c * TURN_RADIUS : 0), z));
  };
  /** Lane (moving -c·Y) -> along Y back toward the building -> turn -> along X into the row entry. */
  const legIn = (tier: number, start: BeltEnd, c: number, entry: BeltEnd): void => {
    let end = straight(tier, start, vec(start.position.x, entry.position.y + c * TURN_RADIUS, entry.position.z));
    end = turn(tier, end, Y(-c), X(-c));
    b.belt(beltType(tier), end, entry);
  };
  const yawOf = (d: Vec3) => (Math.atan2(d.y, d.x) * 180) / Math.PI;

  /**
   * Vertical move of `rise` cm, entering moving along inDir and leaving along outDir. Rises beyond one
   * lift's limit become a zig-zag: every lift but the last makes a U-turn and a 3 m belt leads to the
   * next one, so the column stays in its lane.
   */
  const climb = (tier: number, from: BeltEnd, rise: number, inDir: Vec3, outDir: Vec3): BeltEnd => {
    const segments = Math.ceil(Math.abs(rise) / MAX_LIFT);
    const step = rise / segments;
    let previous = from;
    let dir = inDir;
    for (let i = 0; i < segments; i++) {
      const last = i === segments - 1;
      const out = last ? outDir : vec(-dir.x, -dir.y, 0);
      const { lift, output } = b.lift(liftType(tier), previous.position, step, yawOf(dir), yawOf(out));
      if (previous.building) b.link({ building: lift, name: "ConveyorAny0" }, previous as ConnectorRef);
      previous = { building: lift, name: "ConveyorAny1", position: output };
      if (!last) {
        previous = straight(tier, previous, add(output, vec(out.x * ZIG, out.y * ZIG, 0)));
        dir = out;
      }
    }
    return previous;
  };

  // Child -> parent connections: out of the child row, up the lane, into the parent row.
  for (const parent of rows) {
    parent.node.inputs.forEach((input, index) => {
      if (!input.node) return;
      const child = rowOf.get(input.node)!;
      const exit = child.ports!.find((p) => p.side === "output")!;
      const entry = parent.ports!.find((p) => p.side === "input" && p.spec === parent.row.options.inputs![index])!;
      const c = outputCorner(child);
      routes.push({
        corner: c,
        rowY: exit.global.y,
        build: (lane) => {
          const bottom = legOut(exit.tier, { ...exit.point, position: exit.global }, c, lane);
          const top = climb(exit.tier, bottom, entry.global.z - exit.global.z, Y(c), Y(-c));
          legIn(exit.tier, top, c, { ...entry.point, position: entry.global });
        },
      });
    });
  }

  // Raw-material inputs: open belt end on the blueprint edge -> lane -> up -> row entry.
  const rawPorts: { label: string; tier: number; corner: number }[] = [];
  const designer = { half: 0 };
  for (const r of rows) {
    r.node.inputs.forEach((input, index) => {
      if (input.node) return;
      const entry = r.ports!.find((p) => p.side === "input" && p.spec === r.row.options.inputs![index])!;
      const c = inputCorner(r);
      rawPorts.push({ label: entry.label, tier: entry.tier, corner: c });
      routes.push({
        corner: c,
        rowY: entry.global.y,
        build: (lane) => {
          const port: BeltEnd = { position: vec(c * designer.half, lane.y, GROUND_BELT_Z) };
          const target: BeltEnd = { ...entry.point, position: entry.global };
          const rise = entry.global.z - GROUND_BELT_Z;
          if (rise < WALL) {
            // Ground floor: no lift, just turn at the lane and slope up to the entry.
            let end = straight(entry.tier, port, vec(lane.x + c * TURN_RADIUS, lane.y, GROUND_BELT_Z));
            end = turn(entry.tier, end, X(-c), Y(-c));
            legIn(entry.tier, end, c, target);
            return;
          }
          const bottom = straight(entry.tier, port, vec(lane.x, lane.y, GROUND_BELT_Z));
          legIn(entry.tier, climb(entry.tier, bottom, rise, X(-c), Y(-c)), c, target);
        },
      });
    });
  }

  // Final product: row exit -> lane -> down -> open belt end on the blueprint edge.
  const root = rowOf.get(tree)!;
  const finalExit = root.ports!.find((p) => p.side === "output")!;
  const finalCorner = outputCorner(root);
  routes.push({
    corner: finalCorner,
    rowY: finalExit.global.y,
    build: (lane) => {
      const c = finalCorner;
      const exit: BeltEnd = { ...finalExit.point, position: finalExit.global };
      const drop = GROUND_BELT_Z - finalExit.global.z;
      if (drop > -WALL) {
        // Single-floor factory: turn at the lane and run straight out.
        let end = legOut(finalExit.tier, exit, c, lane, true);
        end = turn(finalExit.tier, end, Y(c), X(c));
        straight(finalExit.tier, end, vec(c * designer.half, lane.y, GROUND_BELT_Z));
        return;
      }
      const bottom = climb(finalExit.tier, legOut(finalExit.tier, exit, c, lane), drop, Y(c), X(c));
      straight(finalExit.tier, bottom, vec(c * designer.half, lane.y, GROUND_BELT_Z));
    },
  });

  // Lanes: a staircase per corner (see the file comment), outermost row point -> outermost lane.
  const lanesPerCorner = new Map<number, LaneRoute[]>();
  for (const route of routes) lanesPerCorner.set(route.corner, [...(lanesPerCorner.get(route.corner) ?? []), route]);
  const laneCount = Math.max(...[...lanesPerCorner.values()].map((l) => l.length));
  const outer = Math.max(slabEdge.x, slabEdge.y) + LANE_MARGIN + LANE_SPACING * laneCount;
  designer.half = Math.ceil((outer + FOUNDATION) / FOUNDATION) * FOUNDATION;
  for (const [corner, list] of lanesPerCorner) {
    list.sort((a, c) => corner * c.rowY - corner * a.rowY);
    list.forEach((route, k) => route.build({
      x: corner * (slabEdge.x + LANE_MARGIN + LANE_SPACING * k),
      y: corner * (slabEdge.y + LANE_MARGIN + LANE_SPACING * (list.length - 1 - k)),
    }));
  }

  // One power grid: each row's last pole wired to the next row's first pole. That adds at most one
  // wire to any pole, which keeps every Mk1 pole within its 4 connections.
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].poleTops![rows[i - 1].poleTops!.length - 1];
    const c = rows[i].poleTops![0];
    b.wire({ building: a.pole, name: b.powerConnector(a.pole), position: a.position }, { building: c.pole, name: b.powerConnector(c.pole), position: c.position });
  }

  const name = options.name ?? `Factory ${fmt(options.rate)} ${data.items[tree.product].name}`;
  const rawText = rawPorts.map((p) => `${p.label} (belt Mk${p.tier})`).join(", ");
  const blueprint = b.build(name, {
    description: `Complete factory: ${fmt(options.rate)}/min ${data.items[tree.product].name} in ${floors.length} floor(s). `
      + `Raw materials enter at ground level, one belt each: ${rawText}. The product leaves at ground level (belt Mk${finalExit.tier}). Power: connect any pole.`,
    designerSize: (designer.half * 2) / FOUNDATION,
    yaw: FLOW_TO_FRONT_YAW,
  });

  const report = [
    `${data.items[tree.product].name}: ${fmt(options.rate)}/min in ${floors.length} floor(s), ${rows.reduce((n, r) => n + r.row.options.count, 0)} machines`,
    ...floors.map((floor, f) => `  floor ${f} (${fmt(floorZ[f] / 100)} m): ` + floor.map((r) => {
      const clocks = r.row.options.clocks ?? [];
      const partial = clocks.filter((c) => Math.abs(c - 1) > 1e-6).map((c) => `${fmt(c * 100)}%`);
      return `${r.row.options.count}x ${r.row.spec.key} -> ${fmt(r.node.rate)}/min ${data.items[r.node.product].name}${partial.length ? ` (last at ${partial.join(", ")})` : ""}`;
    }).join(" | ")),
    `  raw inputs at ground level: ${rawText}`,
    `  product leaves at ground level on belt Mk${finalExit.tier}`,
  ].join("\n");
  return { blueprint, report };
}
