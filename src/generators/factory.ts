import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BeltEnd, BlueprintBuilder, ConnectorRef, Placed } from "../builder.js";
import { Vec3, add, transform, vec } from "../geometry.js";
import { GameData, pickTier } from "../gamedata/index.js";
import { PlanOptions, Step, fmt, plan } from "../planner/plan.js";
import { BuiltRow, PreparedRow, attachmentPoint, beltType, buildRow, libraryFor, liftType, prepareRow } from "./machine-row.js";
import { rowOptionsFor } from "./row-options.js";

/**
 * A complete factory in one blueprint: every production step of the target item, stacked in floors,
 * with a single input belt per raw material and a single output belt.
 *
 * Steps and floors
 * - One machine row per product (the planner's steps). A product used by several steps is made by
 *   one row and shared, the same way a manifold shares: full consumers back up and the rest flows on.
 * - Floor = how far a step is from raw materials: steps fed only by raw materials are on the ground
 *   floor, every other step one floor above its highest ingredient step. Rows on a floor sit side by
 *   side; each floor stands on a slab of 8 m x 1 m foundations. All rows share one power grid.
 *
 * Connections (layout frame, before the final rotation toward the placement arrow)
 * - Every row is turned so its inputs face +Y and both its supplies and its product meet the outside
 *   at its west (-X) end. All connections therefore live in one zone west of the building.
 * - Each flow (a raw material, or a row's product) gets a "fan line": a belt running east at its own
 *   distance north of the building, with a splitter per consumer. Each splitter drops a belt south
 *   to the consumer's lane, where a Conveyor Lift climbs to the consumer's floor (several chained lifts
 *   above 48 m), and the belt runs south and turns east into the consumer row. A row's product reaches
 *   its fan line from its exit by a belt that runs west, then north.
 * - Raw materials arrive from the west edge at ground level, one open belt end each. The final
 *   product comes down a lift and leaves through an open belt end on the west edge.
 *
 * Avoiding clashes
 * - Lanes are vertical columns side by side along X, flows' lanes kept together. A horizontal belt of
 *   an outer lane only crosses the vertical runs of inner lanes, and only if it is at the same height
 *   and further north. The lane order is chosen by search to avoid that; the result is then
 *   verified by the structural checker like any generated blueprint.
 */

export interface FactoryOptions extends PlanOptions {
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
/** Lanes start this far outside the slabs, are spaced this far apart, and flows are separated by a wider gap. */
const LANE_MARGIN = 900;
const LANE_SPACING = 600;
const FLOW_GAP = 1200;
/** Fan lines run north of the lifts, this far apart. */
const FAN_MARGIN = 900;
const FAN_SPACING = 600;
/** Horizontal hop (cm) between chained lifts. */
const ZIG = 300;
/** Radius (cm) of every 90° belt turn. */
const TURN_RADIUS = 300;
/** Longest Conveyor Lift the game allows is about 48 m; taller climbs chain several lifts. */
const MAX_LIFT = 4800;
/** Rows are turned so inputs face +Y; their connection end is then at -X. */
const ROW_YAW = 180;
const FLOW_TO_FRONT_YAW = -90;
const SPLITTER = "Build_ConveyorAttachmentSplitter_C";
/** A vertical run that would cross an outer belt travels this much higher and drops back with a short lift. */
const DETOUR = 200;

interface PlacedRow {
  step: Step;
  row: PreparedRow;
  floor: number;
  y: number;
  ports?: (BuiltRow["ports"][number] & { global: Vec3 })[];
  poleTops?: { pole: Placed; position: Vec3 }[];
}

/** One consumer of a flow: a row input, or the ground-level output port. */
interface Sink {
  row?: PlacedRow;
  inputIndex?: number;
  perMinute: number;
  /** Filled once rows are built. */
  entry?: BeltEnd & { position: Vec3 };
}

interface Flow {
  item: string;
  label: string;
  perMinute: number;
  /** Producing row, or undefined for a raw material. */
  source?: PlacedRow;
  sinks: Sink[];
  final: boolean;
}

export function generateFactory(data: GameData, options: FactoryOptions): { blueprint: Blueprint; report: string } {
  const production = plan(data, options.target, options.rate, options);
  for (const step of production.steps) {
    const fluids = [...step.recipe.inputs, ...step.recipe.outputs].filter((f) => data.items[f.item].form !== "solid");
    if (fluids.length > 0) throw new Error(`"${step.recipe.name}" uses fluids; complete factories with fluids are not supported yet. Generate it as a row instead.`);
    if (step.recipe.outputs.length > 1) throw new Error(`"${step.recipe.name}" has a byproduct; complete factories need single-product steps for now.`);
  }

  // Rows and floors.
  const producerOf = new Map(production.steps.map((s) => [s.product.className, s]));
  const floorOf = (step: Step): number => {
    const producers = step.inputs.flatMap((i) => (producerOf.has(i.item.className) ? [producerOf.get(i.item.className)!] : []));
    return producers.length === 0 ? 0 : 1 + Math.max(...producers.map(floorOf));
  };
  const rows: PlacedRow[] = production.steps.map((step) => {
    const rate = step.outputs.find((o) => o.item.className === step.product.className)!.perMinute;
    return { step, row: prepareRow({ ...rowOptionsFor(data, step.recipe, rate), inputFrom: "east", pole: options.pole }), floor: floorOf(step), y: 0 };
  });
  const rowOfStep = new Map(rows.map((r) => [r.step, r]));
  const floors = Array.from({ length: Math.max(...rows.map((r) => r.floor)) + 1 }, (_, f) => rows.filter((r) => r.floor === f));

  // Extents of a turned row (yaw 180 mirrors X and Y) shifted by its y.
  const extentOf = (r: PlacedRow) => {
    const e = r.row.extent;
    return { minX: -e.maxX, maxX: -e.minX, minY: -e.maxY + r.y, maxY: -e.minY + r.y };
  };
  for (const floor of floors) {
    let cursor = 0;
    for (const r of floor) {
      const e = extentOf({ ...r, y: 0 });
      r.y = cursor - e.minY;
      cursor = r.y + e.maxY + ROW_GAP;
    }
    const shift = (cursor - ROW_GAP) / 2;
    for (const r of floor) r.y -= shift;
  }
  const floorZ: number[] = [];
  let z = SLAB;
  for (const floor of floors) {
    floorZ.push(z);
    z += Math.ceil((Math.max(...floor.map((r) => r.row.height)) + SLAB + HEADROOM) / WALL) * WALL;
  }
  const extents = rows.map(extentOf);
  const slab = {
    x: Math.ceil(Math.max(...extents.map((e) => Math.max(-e.minX, e.maxX))) / FOUNDATION) * FOUNDATION,
    y: Math.ceil(Math.max(...extents.map((e) => Math.max(-e.minY, e.maxY))) / FOUNDATION) * FOUNDATION,
  };

  // Flows: every product and raw material with its consumers.
  const flows: Flow[] = [];
  const flowOf = new Map<string, Flow>();
  for (const r of rows) {
    r.step.inputs.forEach((input, inputIndex) => {
      const cls = input.item.className;
      let flow = flowOf.get(cls);
      if (!flow) {
        const producer = producerOf.get(cls);
        flow = { item: cls, label: input.item.name, perMinute: 0, source: producer ? rowOfStep.get(producer) : undefined, sinks: [], final: false };
        flowOf.set(cls, flow);
        flows.push(flow);
      }
      flow.perMinute += input.perMinute;
      flow.sinks.push({ row: r, inputIndex, perMinute: input.perMinute });
    });
  }
  const root = rowOfStep.get(producerOf.get(production.target.item.className)!)!;
  flows.push({ item: production.target.item.className, label: production.target.item.name, perMinute: options.rate, source: root, sinks: [{ perMinute: options.rate }], final: true });

  const tierFor = (perMinute: number) => {
    const t = pickTier(data.belts, perMinute);
    if (!t) throw new Error(`${fmt(perMinute)}/min is more than one belt carries; lower the rate or split the factory.`);
    return Number(t.className.match(/Mk(\d)/)![1]);
  };
  const tiers = new Set(flows.flatMap((f) => [f.perMinute, ...f.sinks.map((s) => s.perMinute)]).map(tierFor));
  const b = new BlueprintBuilder(libraryFor(rows.map((r) => r.row), [FOUNDATION_TYPE, SPLITTER, ...[...tiers].flatMap((t) => [beltType(t), liftType(t)])]));

  // Slabs and rows.
  floors.forEach((floor, f) => {
    const e = floor.map(extentOf);
    const x0 = Math.floor(Math.min(...e.map((x) => x.minX)) / FOUNDATION) * FOUNDATION;
    const x1 = Math.ceil(Math.max(...e.map((x) => x.maxX)) / FOUNDATION) * FOUNDATION;
    const y0 = Math.floor(Math.min(...e.map((x) => x.minY)) / FOUNDATION) * FOUNDATION;
    const y1 = Math.ceil(Math.max(...e.map((x) => x.maxY)) / FOUNDATION) * FOUNDATION;
    for (let x = x0; x < x1; x += FOUNDATION) {
      for (let y = y0; y < y1; y += FOUNDATION) b.place(FOUNDATION_TYPE, transform(vec(x + FOUNDATION / 2, y + FOUNDATION / 2, floorZ[f] - SLAB / 2)));
    }
  });
  for (const r of rows) {
    b.withFrame(transform(vec(0, r.y, floorZ[r.floor]), ROW_YAW), () => {
      const built = buildRow(b, r.row);
      r.ports = built.ports.map((p) => ({ ...p, global: b.toBlueprint(p.point.position) }));
      r.poleTops = built.poles.map((p) => ({ pole: p.pole, position: b.toBlueprint(p.position) }));
    });
  }
  for (const flow of flows) {
    for (const sink of flow.sinks) {
      if (!sink.row) continue;
      const port = sink.row.ports!.find((p) => p.side === "input" && p.spec === sink.row!.row.options.inputs![sink.inputIndex!])!;
      sink.entry = { ...port.point, position: port.global };
    }
  }
  const exitOf = (r: PlacedRow) => {
    const port = r.ports!.find((p) => p.side === "output")!;
    return { ...port.point, position: port.global } as ConnectorRef & { position: Vec3 };
  };

  // Lane order: search for the arrangement with the fewest same-height crossings (see file comment).
  const { order, detours } = chooseLaneOrder(flows, exitOf);
  const yLane = slab.y + LANE_MARGIN;
  let x = slab.x + LANE_MARGIN;
  const laneX = new Map<Sink, number>();
  const columnX = new Map<Flow, number>();
  for (const flow of order) {
    for (const sink of sortSinks(flow)) {
      laneX.set(sink, -x);
      x += LANE_SPACING;
    }
    if (flow.source && !flow.final) {
      columnX.set(flow, -(x - LANE_SPACING + TURN_RADIUS * 2 + 200));
      x += TURN_RADIUS * 2 + 200;
    }
    x += FLOW_GAP;
  }
  // Fan lines north of the lifts: raw materials farthest, inner flows farther than outer ones.
  const fanY = new Map<Flow, number>();
  const fans = order.filter((f) => !f.final);
  const withSource = fans.filter((f) => f.source);
  const raw = fans.filter((f) => !f.source);
  [...withSource.reverse(), ...raw.reverse()].forEach((f, i) => fanY.set(f, yLane + FAN_MARGIN + i * FAN_SPACING));
  const outer = Math.max(x, Math.max(slab.y, ...fanY.values()) + FAN_MARGIN);
  const half = Math.ceil((outer + FOUNDATION) / FOUNDATION) * FOUNDATION;

  // Routing pieces: straight belts, 90° turns and lifts (entered from the side).
  const X = (s: number) => vec(s, 0, 0);
  const Y = (s: number) => vec(0, s, 0);
  const straight = (tier: number, from: BeltEnd, to: Vec3): BeltEnd => {
    if (Math.hypot(to.x - from.position.x, to.y - from.position.y, to.z - from.position.z) < 10) return from;
    const belt = b.belt(beltType(tier), from, { position: to });
    return { building: belt, name: "ConveyorAny1", position: to };
  };
  const turn = (tier: number, from: BeltEnd, fromDir: Vec3, toDir: Vec3) => b.beltTurn(beltType(tier), from, fromDir, toDir, TURN_RADIUS);
  const yawOf = (d: Vec3) => (Math.atan2(d.y, d.x) * 180) / Math.PI;
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
  /** From a lane (moving -Y at the entry's height or below) south, then east into the row entry. */
  const intoRow = (tier: number, start: BeltEnd, entry: BeltEnd) => {
    let end = straight(tier, start, vec(start.position.x, entry.position.y + TURN_RADIUS, entry.position.z));
    end = turn(tier, end, Y(-1), X(1));
    b.belt(beltType(tier), end, entry);
  };
  /**
   * From the point above a lane's lift (moving -Y): climb to the entry's floor and go in. A detoured
   * run climbs DETOUR higher, runs south above the belts it would cross, and drops back just before
   * turning into the row.
   */
  const laneToRow = (tier: number, start: BeltEnd, entry: BeltEnd, detour: boolean) => {
    const runZ = entry.position.z + (detour ? DETOUR : 0);
    const rise = runZ - start.position.z;
    let end = rise < WALL ? start : climb(tier, start, rise, Y(-1), Y(-1));
    if (detour) {
      end = straight(tier, end, vec(end.position.x, entry.position.y + TURN_RADIUS + ZIG, runZ));
      end = climb(tier, end, -DETOUR, Y(-1), Y(-1));
    }
    intoRow(tier, end, entry);
  };

  for (const flow of order) {
    const sinks = sortSinks(flow);
    if (flow.final) {
      // Root exit -> west -> north to the lane -> down -> west edge.
      const sink = sinks[0];
      const lx = laneX.get(sink)!;
      const exit = exitOf(flow.source!);
      const tier = tierFor(flow.perMinute);
      let end = straight(tier, exit, vec(lx + TURN_RADIUS, exit.position.y, exit.position.z));
      end = turn(tier, end, X(-1), Y(1));
      end = straight(tier, end, vec(lx, yLane, exit.position.z));
      const drop = GROUND_BELT_Z - exit.position.z;
      if (drop <= -WALL) end = climb(tier, end, drop, Y(1), X(-1));
      else {
        end = straight(tier, end, vec(lx, yLane + FAN_MARGIN - TURN_RADIUS, exit.position.z));
        end = turn(tier, end, Y(1), X(-1));
      }
      straight(tier, end, vec(-half, end.position.y, GROUND_BELT_Z));
      continue;
    }

    // Bring the flow to the east end of its fan line (moving east, at the fan's y and the source height).
    const y = fanY.get(flow)!;
    let head: BeltEnd;
    if (flow.source) {
      const exit = exitOf(flow.source);
      const cx = columnX.get(flow)!;
      const tier = tierFor(flow.perMinute);
      if (detours.has(flow)) {
        // Run north DETOUR higher than the exit, over the belts this column would cross.
        head = straight(tier, exit, vec(cx, exit.position.y, exit.position.z));
        head = climb(tier, head, DETOUR, X(-1), Y(1));
      } else {
        head = straight(tier, exit, vec(cx + TURN_RADIUS, exit.position.y, exit.position.z));
        head = turn(tier, head, X(-1), Y(1));
      }
      head = straight(tier, head, vec(cx, y - TURN_RADIUS, head.position.z));
      head = turn(tier, head, Y(1), X(1));
    } else {
      head = { position: vec(-half, y, GROUND_BELT_Z) };
    }

    // Fan line, moving east from the outermost lane inward: a splitter per consumer (a simple turn
    // when there is only one), each dropping south to its lane.
    let remaining = flow.perMinute;
    [...sinks].reverse().forEach((sink) => {
      const lx = laneX.get(sink)!;
      const sinkTier = tierFor(sink.perMinute);
      const lineTier = tierFor(remaining);
      const fz = head.position.z;
      let drop: BeltEnd;
      if (sinks.length === 1) {
        head = straight(lineTier, head, vec(lx - TURN_RADIUS, y, fz));
        drop = turn(sinkTier, head, X(1), Y(-1));
      } else {
        // Splitters along the fan are turned so Output3 faces south (-Y) when items move east.
        const center = vec(lx, y, fz);
        const splitter = b.place(SPLITTER, transform(center, 0));
        b.belt(beltType(lineTier), head, { building: splitter, name: "Input1", position: attachmentPoint(SPLITTER, center, "Input1") });
        drop = { building: splitter, name: "Output3", position: attachmentPoint(SPLITTER, center, "Output3") };
        head = { building: splitter, name: "Output1", position: attachmentPoint(SPLITTER, center, "Output1") };
      }
      remaining -= sink.perMinute;
      const atLift = straight(sinkTier, drop, vec(lx, yLane, fz));
      laneToRow(sinkTier, atLift, sink.entry!, detours.has(sink));
    });
  }

  // One power grid: each row's last pole wired to the next row's first pole (at most one extra wire per pole).
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].poleTops![rows[i - 1].poleTops!.length - 1];
    const c = rows[i].poleTops![0];
    b.wire({ building: a.pole, name: b.powerConnector(a.pole), position: a.position }, { building: c.pole, name: b.powerConnector(c.pole), position: c.position });
  }

  const productName = production.target.item.name;
  const rawFlows = flows.filter((f) => !f.source);
  const rawText = rawFlows.map((f) => `${fmt(f.perMinute)}/min ${f.label} (belt Mk${tierFor(f.perMinute)})`).join(", ");
  const blueprint = b.build(options.name ?? `Factory ${fmt(options.rate)} ${productName}`, {
    description: `Complete factory: ${fmt(options.rate)}/min ${productName} in ${floors.length} floor(s). `
      + `Inputs at ground level, one belt each: ${rawText}. The product leaves at ground level (belt Mk${tierFor(options.rate)}). Power: connect any pole.`,
    designerSize: (half * 2) / FOUNDATION,
    yaw: FLOW_TO_FRONT_YAW,
  });

  const report = [
    `${productName}: ${fmt(options.rate)}/min in ${floors.length} floor(s), ${rows.reduce((n, r) => n + r.row.options.count, 0)} machines`,
    ...floors.map((floor, f) => `  floor ${f} (${fmt(floorZ[f] / 100)} m): ` + floor.map((r) => {
      const partial = (r.row.options.clocks ?? []).filter((c) => Math.abs(c - 1) > 1e-6).map((c) => `${fmt(c * 100)}%`);
      const rate = r.step.outputs[0].perMinute;
      return `${r.row.options.count}x ${r.row.spec.key} -> ${fmt(rate)}/min ${r.step.product.name}${partial.length ? ` (last at ${partial.join(", ")})` : ""}`;
    }).join(" | ")),
    `  inputs (one belt each, ground level): ${rawText}`,
    `  product leaves at ground level on belt Mk${tierFor(options.rate)}`,
    ...flows.filter((f) => f.source && !f.final && f.sinks.length > 1).map((f) => `  ${f.label} is shared by ${f.sinks.length} rows`),
  ].join("\n");
  return { blueprint, report };
}

/** Consumers of a flow from the building outward: the northernmost entry closest to the building. */
function sortSinks(flow: Flow): Sink[] {
  return [...flow.sinks].sort((a, c) => (c.entry?.position.y ?? -Infinity) - (a.entry?.position.y ?? -Infinity));
}

/**
 * Picks the order of flows from the building outward. A horizontal belt of an outer element crosses
 * the vertical run of an inner one when both are at the same height and the outer belt is further
 * north than the inner run's southern end. Flows are tried in many orders (exhaustively when few,
 * randomly otherwise) and the one with the fewest crossed runs wins; the final product's lane is
 * always outermost because its belt to the edge passes every other lane. Runs that are still crossed
 * become detours (they travel DETOUR higher).
 */
function chooseLaneOrder(flows: Flow[], exitOf: (r: PlacedRow) => { position: Vec3 }): { order: Flow[]; detours: Set<Sink | Flow> } {
  const finalFlow = flows.find((f) => f.final)!;
  const others = flows.filter((f) => !f.final);
  /** A lane (a consumer) or a source column: its horizontal leg and its vertical run start at the same row point. */
  type Element = { key: Sink | Flow; y: number; z: number };
  const elementsOf = (flow: Flow): Element[] => {
    const lanes: Element[] = sortSinks(flow).map((s) => (s.entry
      ? { key: s, y: s.entry.position.y, z: s.entry.position.z }
      : { key: s, y: -Infinity, z: -Infinity }));
    if (flow.source && !flow.final) {
      const exit = exitOf(flow.source).position;
      lanes.push({ key: flow, y: exit.y, z: exit.z });
    } else if (flow.final) {
      const exit = exitOf(flow.source!).position;
      lanes[0] = { key: lanes[0].key, y: exit.y, z: exit.z };
    }
    return lanes;
  };
  /** Inner elements whose run an outer element's leg would cross. */
  const crossed = (sequence: Flow[]) => {
    const elements = sequence.flatMap(elementsOf);
    const hit = new Set<Sink | Flow>();
    for (let i = 0; i < elements.length; i++) {
      for (let j = i + 1; j < elements.length; j++) {
        if (Math.abs(elements[j].z - elements[i].z) < 200 && elements[j].y > elements[i].y) hit.add(elements[i].key);
      }
    }
    return hit;
  };
  let best = others;
  let bestCost = crossed([...others, finalFlow]).size;
  const consider = (sequence: Flow[]) => {
    const c = crossed([...sequence, finalFlow]).size;
    if (c < bestCost) {
      best = sequence;
      bestCost = c;
    }
  };
  if (others.length <= 7) {
    const permute = (prefix: Flow[], rest: Flow[]) => {
      if (bestCost === 0) return;
      if (rest.length === 0) return consider(prefix);
      rest.forEach((f, i) => permute([...prefix, f], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    permute([], others);
  } else {
    for (let attempt = 0; attempt < 5000 && bestCost > 0; attempt++) consider([...others].sort(() => Math.random() - 0.5));
  }
  const order = [...best, finalFlow];
  return { order, detours: crossed(order) };
}
