import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BeltEnd, BlueprintBuilder, ConnectorRef, Placed } from "../builder.js";
import { Transform, Vec3, add, transform, vec, yaw as yawQuat } from "../geometry.js";
import { GameData, pickTier } from "../gamedata/index.js";
import { PlanOptions, Step, fmt, plan } from "../planner/plan.js";
import { BuiltRow, LineKind, PreparedRow, attachmentPoint, beltType, buildRow, libraryFor, liftType, pipeType, prepareRow } from "./machine-row.js";
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
/** Lanes start this far outside the slabs and are spaced this far apart (belts, lifts and pipes are 2 m wide). */
const LANE_MARGIN = 600;
const LANE_SPACING = 400;
/** A flow's column sits this far outside its outermost lane: room to turn north and then east again. */
const COLUMN_OFFSET = 700;
/** Fan lines run north of the lifts, this far apart. */
const FAN_MARGIN = 600;
const FAN_SPACING = 400;
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
const JUNCTION = "Build_PipelineJunction_Cross_C";
const PUMP = "Build_PipelinePump_C";
const PUMP_PATTERN = /Build_PipelinePump_C$/;
/** Rotation that points a pump's flow axis (+X) straight up, for pumps inside vertical pipes. */
const PUMP_UPRIGHT = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
/** A Mk1 pump gives 20 m of head lift; pumps on a rising pipe are this far apart (3 m margin). */
const PUMP_SPACING = 1700;
/** Pumps are powered from one Mk2 pole (7 connections) per lane. */
const LANE_POLE = "Build_PowerPoleMk2_C";
const POLE_HEIGHT = 400;
/** Ground-level pipes (raw fluids and exported fluids) run at a machine pipe connector's height. */
const GROUND_PIPE_Z = 175;
/** Each exported product comes down on its own line, this far south of the previous one. */
const EXPORT_STAGGER = 400;
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

/** One consumer of a flow: a row input, or (for exported products) the ground-level output port. */
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
  kind: LineKind;
  /** Liquids need head lift (pumps); gases and solids do not. */
  liquid: boolean;
  perMinute: number;
  /** Producing row and which of its outputs, or undefined for a raw material. */
  source?: { row: PlacedRow; output: number };
  sinks: Sink[];
  /** Leaves the factory at ground level: the final product, or a byproduct nobody inside uses. */
  exported: boolean;
  /** Goes straight from its row to its only consumer, one or more floors up (no fan line). */
  direct?: boolean;
}

/** Turns, straight runs and vertical moves for one kind of line (belts or pipes) at one tier. */
interface Conduit {
  kind: LineKind;
  straight(from: BeltEnd, to: Vec3): BeltEnd;
  /** Quarter turn of radius TURN_RADIUS from one horizontal direction to another. */
  turn(from: BeltEnd, fromDir: Vec3, toDir: Vec3): BeltEnd;
  /** Vertical move of `rise`, entering moving along inDir and leaving along outDir (both horizontal). */
  vertical(from: BeltEnd, rise: number, inDir: Vec3, outDir: Vec3): BeltEnd;
  /** Smallest rise worth a vertical move; smaller height changes are taken as a slope. */
  minRise: number;
}

export function generateFactory(data: GameData, options: FactoryOptions): { blueprint: Blueprint; report: string } {
  const production = plan(data, options.target, options.rate, options);
  const kindOf = (cls: string): LineKind => (data.items[cls].form === "solid" ? "belt" : "pipe");

  // Who makes each item: the step whose product it is, else a step that makes it as a byproduct.
  const producerOf = new Map<string, { step: Step; output: number }>();
  for (const step of production.steps) {
    step.recipe.outputs.forEach((o, output) => {
      const existing = producerOf.get(o.item);
      if (!existing || (o.item === step.product.className && existing.step.product.className !== o.item)) producerOf.set(o.item, { step, output });
    });
  }
  const consumed = new Set(production.steps.flatMap((s) => s.inputs.map((i) => i.item.className)));
  for (const by of production.byproducts) {
    if (consumed.has(by.item.className)) {
      throw new Error(`${by.item.name} is made as a byproduct but only partly used (${fmt(by.perMinute)}/min left over). Pick other recipes or rates so it is fully used or not used at all.`);
    }
  }

  // Floors: one above the highest step whose solid product a step uses. A fluid from another step
  // keeps the consumer on the producer's floor when possible, so fluids rarely have to climb.
  const floorOf = (step: Step): number => {
    let floor = 0;
    for (const input of step.inputs) {
      const producer = producerOf.get(input.item.className);
      if (!producer || producer.step === step) continue;
      floor = Math.max(floor, floorOf(producer.step) + (kindOf(input.item.className) === "pipe" ? 0 : 1));
    }
    return floor;
  };
  const rows: PlacedRow[] = production.steps.map((step) => {
    const rate = step.outputs.find((o) => o.item.className === step.product.className)!.perMinute;
    const recipe = { ...step.recipe, outputs: [...step.recipe.outputs].sort((a) => (a.item === step.product.className ? -1 : 1)) };
    return { step, row: prepareRow({ ...rowOptionsFor(data, recipe, rate), inputFrom: "east", pole: options.pole }), floor: floorOf(step), y: 0 };
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

  // Flows: every item a row consumes, plus everything that leaves the factory.
  const flows: Flow[] = [];
  const flowOf = new Map<string, Flow>();
  const newFlow = (cls: string, exported: boolean): Flow => {
    const producer = producerOf.get(cls);
    return {
      item: cls, label: data.items[cls].name, kind: kindOf(cls), liquid: data.items[cls].form === "liquid", perMinute: 0,
      source: producer ? { row: rowOfStep.get(producer.step)!, output: producer.output } : undefined, sinks: [], exported,
    };
  };
  for (const r of rows) {
    r.step.inputs.forEach((input, inputIndex) => {
      const cls = input.item.className;
      if (!flowOf.has(cls)) {
        flowOf.set(cls, newFlow(cls, false));
        flows.push(flowOf.get(cls)!);
      }
      const flow = flowOf.get(cls)!;
      flow.perMinute += input.perMinute;
      flow.sinks.push({ row: r, inputIndex, perMinute: input.perMinute });
    });
  }
  const exports = [{ item: production.target.item.className, perMinute: options.rate }, ...production.byproducts.map((p) => ({ item: p.item.className, perMinute: p.perMinute }))];
  for (const e of exports) {
    const flow = newFlow(e.item, true);
    flow.perMinute = e.perMinute;
    flow.sinks.push({ perMinute: e.perMinute });
    flows.push(flow);
  }

  const tierFor = (kind: LineKind, perMinute: number) => {
    const t = pickTier(kind === "belt" ? data.belts : data.pipes, perMinute);
    if (!t) throw new Error(`${fmt(perMinute)}/min is more than one ${kind} carries; lower the rate or split the factory.`);
    return kind === "belt" ? Number(t.className.match(/Mk(\d)/)![1]) : /MK2/i.test(t.className) ? 2 : 1;
  };
  const required = new Set<string>([FOUNDATION_TYPE]);
  for (const f of flows) {
    for (const rate of [f.perMinute, ...f.sinks.map((s) => s.perMinute)]) {
      const t = tierFor(f.kind, rate);
      if (f.kind === "belt") required.add(beltType(t)).add(liftType(t));
      else required.add(pipeType(t));
    }
    if (f.kind === "belt" && f.sinks.length > 1) required.add(SPLITTER);
    if (f.kind === "pipe" && f.sinks.length > 1) required.add(JUNCTION);
    if (f.kind === "pipe" && f.liquid && !f.exported) required.add(PUMP).add(LANE_POLE);
  }
  const b = new BlueprintBuilder(libraryFor(rows.map((r) => r.row), [...required]));

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
  const exitOf = (flow: Flow) => {
    const { row, output } = flow.source!;
    const port = row.ports!.find((p) => p.side === "output" && p.spec === row.row.options.outputs![output])!;
    return { ...port.point, position: port.global } as ConnectorRef & { position: Vec3 };
  };

  // A product with one consumer on a higher floor can go straight there; the climb turns it back.
  for (const flow of flows) {
    if (!flow.source || flow.exported || flow.sinks.length !== 1) continue;
    const rise = flow.sinks[0].entry!.position.z - exitOf(flow).position.z;
    flow.direct = rise >= (flow.kind === "belt" ? WALL : TURN_RADIUS * 2 + 100);
  }

  // Lane order: search for the arrangement with the fewest same-height crossings (see file comment).
  const { order, detours } = chooseLaneOrder(flows, exitOf);
  const exported = order.filter((f) => f.exported);
  const yLane = slab.y + LANE_MARGIN + EXPORT_STAGGER * (exported.length - 1);
  let x = slab.x + LANE_MARGIN;
  const laneX = new Map<Sink, number>();
  const columnX = new Map<Flow, number>();
  for (const flow of order) {
    for (const sink of sortSinks(flow)) {
      laneX.set(sink, -x);
      x += LANE_SPACING;
    }
    if (needsFan(flow) && flow.source) {
      columnX.set(flow, -(x - LANE_SPACING + COLUMN_OFFSET));
      x += COLUMN_OFFSET;
    }
  }
  // Fan lines north of the lifts: raw materials farthest, inner flows farther than outer ones.
  const fanY = new Map<Flow, number>();
  const fans = order.filter(needsFan);
  [...fans.filter((f) => f.source).reverse(), ...fans.filter((f) => !f.source).reverse()].forEach((f, i) => fanY.set(f, yLane + FAN_MARGIN + i * FAN_SPACING));
  const outer = Math.max(x, Math.max(slab.y, ...fanY.values()) + FAN_MARGIN);
  const half = Math.ceil((outer + FOUNDATION) / FOUNDATION) * FOUNDATION;

  // Pumps get power from one pole per lane, chained together and to the factory grid.
  const lanePoles: { pole: Placed; position: Vec3 }[] = [];
  const pumpPole = (near: Vec3) => {
    const position = vec(near.x + LANE_SPACING / 2, near.y + 200, near.z - 100);
    const pole = b.place(LANE_POLE, transform(position));
    const top = add(position, vec(0, 0, POLE_HEIGHT));
    const previous = lanePoles[lanePoles.length - 1];
    if (previous) b.wire({ building: previous.pole, name: b.powerConnector(previous.pole), position: previous.position }, { building: pole, name: b.powerConnector(pole), position: top });
    lanePoles.push({ pole, position: top });
    return lanePoles[lanePoles.length - 1];
  };

  // Conduits. Belts climb with lifts entered from the side; pipes curve into a vertical run with an
  // inline pump every PUMP_SPACING when the liquid has to climb.
  const X = (s: number) => vec(s, 0, 0);
  const Y = (s: number) => vec(0, s, 0);
  const Z = (s: number) => vec(0, 0, s);
  const yawOf = (d: Vec3) => (Math.atan2(d.y, d.x) * 180) / Math.PI;
  const beltConduit = (tier: number): Conduit => {
    const conduit: Conduit = {
      kind: "belt",
      minRise: WALL,
      straight: (from, to) => {
        if (Math.hypot(to.x - from.position.x, to.y - from.position.y, to.z - from.position.z) < 10) return from;
        const belt = b.belt(beltType(tier), from, { position: to });
        return { building: belt, name: "ConveyorAny1", position: to };
      },
      turn: (from, fromDir, toDir) => b.beltTurn(beltType(tier), from, fromDir, toDir, TURN_RADIUS),
      vertical: (from, rise, inDir, outDir) => {
        // Rises beyond one lift's limit zig-zag: every lift but the last makes a U-turn.
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
            previous = conduit.straight(previous, add(output, vec(out.x * ZIG, out.y * ZIG, 0)));
            dir = out;
          }
        }
        return previous;
      },
    };
    return conduit;
  };
  const pipeConduit = (tier: number, liquid: boolean): Conduit => {
    const type = pipeType(tier);
    const pipeTo = (from: BeltEnd, to: Vec3, dir: Vec3): BeltEnd => {
      if (Math.hypot(to.x - from.position.x, to.y - from.position.y, to.z - from.position.z) < 10) return from;
      const pipe = b.pipe(type, from, { position: to }, dir);
      return { building: pipe, name: "PipelineConnection1", position: to };
    };
    const curve = (from: BeltEnd, fromDir: Vec3, toDir: Vec3): BeltEnd => {
      const to = add(from.position, add(vec(fromDir.x * TURN_RADIUS, fromDir.y * TURN_RADIUS, fromDir.z * TURN_RADIUS), vec(toDir.x * TURN_RADIUS, toDir.y * TURN_RADIUS, toDir.z * TURN_RADIUS)));
      const pipe = b.pipeCurve(type, from, { position: to }, fromDir, toDir, 1.657 * TURN_RADIUS);
      return { building: pipe, name: "PipelineConnection1", position: to };
    };
    return {
      kind: "pipe",
      minRise: TURN_RADIUS * 2 + 100,
      straight: (from, to) => {
        const d = vec(to.x - from.position.x, to.y - from.position.y, 0);
        const len = Math.hypot(d.x, d.y) || 1;
        return pipeTo(from, to, vec(d.x / len, d.y / len, 0));
      },
      turn: curve,
      vertical: (from, rise, inDir, outDir) => {
        const up = Z(Math.sign(rise));
        const pumped = liquid && rise > 0;
        const pole = pumped ? pumpPole(from.position) : undefined;
        // A powered pump resets head lift to 20 m from where it sits. The first one goes on the level
        // stretch right before the climb (the source may have only a few meters left); the others sit
        // inside the vertical pipe every PUMP_SPACING, keeping 3 m of margin.
        const pumpAt = (end: BeltEnd, at: Vec3, rotation: Transform["rotation"]): BeltEnd => {
          const pump = b.place(PUMP, { rotation, translation: at, scale3d: vec(1, 1, 1) });
          if (end.building) b.link({ building: pump, name: "Connection0" }, end as ConnectorRef);
          b.wire({ building: pole!.pole, name: b.powerConnector(pole!.pole), position: pole!.position }, { building: pump, name: b.powerConnector(pump), position: at });
          return { building: pump, name: "Connection1", position: at };
        };
        let end = pumped ? pumpAt(from, from.position, yawQuat(yawOf(inDir))) : from;
        end = curve(end, inDir, up);
        const top = add(end.position, Z(rise - 2 * TURN_RADIUS * Math.sign(rise)));
        if (pumped) {
          for (let pz = from.position.z + PUMP_SPACING; pz < top.z - 100; pz += PUMP_SPACING) {
            const at = vec(end.position.x, end.position.y, pz);
            end = pumpAt(pipeTo(end, at, up), at, PUMP_UPRIGHT);
          }
        }
        end = pipeTo(end, top, up);
        return curve(end, up, outDir);
      },
    };
  };
  const conduitFor = (flow: Flow, perMinute: number) =>
    flow.kind === "belt" ? beltConduit(tierFor("belt", perMinute)) : pipeConduit(tierFor("pipe", perMinute), flow.liquid);

  /** From a lane (moving -Y) south at the entry's height, then east into the row entry. */
  const intoRow = (c: Conduit, start: BeltEnd, entry: BeltEnd) => {
    let end = c.straight(start, vec(start.position.x, entry.position.y + TURN_RADIUS, entry.position.z));
    end = c.turn(end, Y(-1), X(1));
    const last = c.straight(end, entry.position);
    if (entry.building && last.building) b.link(last as ConnectorRef, entry as ConnectorRef);
  };
  /**
   * From the point above a lane's lift (moving -Y): climb to the entry's floor and go in. A detoured
   * run climbs DETOUR higher, runs south above what it would cross, and drops back just before
   * turning into the row.
   */
  const laneToRow = (c: Conduit, start: BeltEnd, entry: BeltEnd, detour: boolean, arriving = Y(-1)) => {
    const runZ = entry.position.z + (detour ? DETOUR : 0);
    const rise = runZ - start.position.z;
    let end = Math.abs(rise) < c.minRise ? start : c.vertical(start, rise, arriving, Y(-1));
    if (detour) {
      end = c.straight(end, vec(end.position.x, entry.position.y + TURN_RADIUS + ZIG, runZ));
      // Belts drop back with a short lift; pipes simply slope down in the last stretch.
      if (c.kind === "belt") end = c.vertical(end, -DETOUR, Y(-1), Y(-1));
    }
    intoRow(c, end, entry);
  };

  exported.forEach((flow, i) => {
    // Exit -> west -> north to the lane -> down -> west edge, each export on its own line.
    const sink = flow.sinks[0];
    const lx = laneX.get(sink)!;
    const exit = exitOf(flow);
    const c = conduitFor(flow, flow.perMinute);
    const y = yLane - i * EXPORT_STAGGER;
    const groundZ = flow.kind === "belt" ? GROUND_BELT_Z : GROUND_PIPE_Z;
    let end: BeltEnd = c.straight(exit, vec(lx + TURN_RADIUS, exit.position.y, exit.position.z));
    end = c.turn(end, X(-1), Y(1));
    const drop = groundZ - exit.position.z;
    // Turning west (or a pipe curving into its vertical run) moves one turn radius forward; stop short
    // so the run toward the edge stays on y. A belt lift turns in place.
    const lifts = -drop >= c.minRise;
    end = c.straight(end, vec(lx, y - (c.kind === "pipe" || !lifts ? TURN_RADIUS : 0), exit.position.z));
    end = lifts ? c.vertical(end, drop, Y(1), X(-1)) : c.turn(end, Y(1), X(-1));
    c.straight(end, vec(-half, end.position.y, groundZ));
  });

  // A product with a single consumer goes straight to that consumer's lane: out of its row, north to
  // the lane, up, and into the consumer row. No column or fan line needed.
  for (const flow of order.filter((f) => !f.exported && !needsFan(f))) {
    const sink = flow.sinks[0];
    const lx = laneX.get(sink)!;
    const exit = exitOf(flow);
    const c = conduitFor(flow, flow.perMinute);
    let end: BeltEnd;
    if (detours.has(flow) && c.kind === "belt") {
      end = c.straight(exit, vec(lx, exit.position.y, exit.position.z));
      end = c.vertical(end, DETOUR, X(-1), Y(1));
    } else {
      end = c.straight(exit, vec(lx + TURN_RADIUS, exit.position.y, exit.position.z));
      end = c.turn(end, X(-1), Y(1));
      if (detours.has(flow)) end = c.straight(end, vec(lx, end.position.y + ZIG, end.position.z + DETOUR));
    }
    end = c.straight(end, vec(lx, yLane, end.position.z));
    // Arriving northbound, the climb turns the flow back south (a lift U-turn, or a pipe curve).
    laneToRow(c, end, sink.entry!, detours.has(sink), Y(1));
  }

  for (const flow of order.filter(needsFan)) {
    const sinks = sortSinks(flow);
    // Bring the flow to the west end of its fan line (moving east, at the fan's y and the source height).
    const y = fanY.get(flow)!;
    let head: BeltEnd;
    if (flow.source) {
      const exit = exitOf(flow);
      const cx = columnX.get(flow)!;
      const c = conduitFor(flow, flow.perMinute);
      if (detours.has(flow) && flow.kind === "belt") {
        // Run north DETOUR higher than the exit, over the belts this column would cross.
        head = c.straight(exit, vec(cx, exit.position.y, exit.position.z));
        head = beltConduit(tierFor("belt", flow.perMinute)).vertical(head, DETOUR, X(-1), Y(1));
      } else {
        head = c.straight(exit, vec(cx + TURN_RADIUS, exit.position.y, exit.position.z));
        head = c.turn(head, X(-1), Y(1));
        if (detours.has(flow)) head = c.straight(head, vec(cx, head.position.y + ZIG, head.position.z + DETOUR));
      }
      head = c.straight(head, vec(cx, y - TURN_RADIUS, head.position.z));
      head = c.turn(head, Y(1), X(1));
    } else {
      head = { position: vec(-half, y, flow.kind === "belt" ? GROUND_BELT_Z : GROUND_PIPE_Z) };
    }

    // Fan line, moving east from the outermost lane inward: a splitter (or junction) per consumer, or
    // a simple turn when there is only one, each dropping south to its lane.
    let remaining = flow.perMinute;
    for (const sink of [...sinks].reverse()) {
      const lx = laneX.get(sink)!;
      const line = conduitFor(flow, remaining);
      const branch = conduitFor(flow, sink.perMinute);
      const fz = head.position.z;
      let drop: BeltEnd;
      if (sinks.length === 1) {
        head = line.straight(head, vec(lx - TURN_RADIUS, y, fz));
        drop = branch.turn(head, X(1), Y(-1));
      } else {
        // Splitters/junctions along the fan: items enter from the west, continue east and drop south.
        const [type, input, through, south] = flow.kind === "belt"
          ? [SPLITTER, "Input1", "Output1", "Output3"]
          : [JUNCTION, "Connection0", "Connection1", "Connection3"];
        const center = vec(lx, y, fz);
        const attachment = b.place(type, transform(center, 0));
        const arrived = line.straight(head, attachmentPoint(type, center, input));
        b.link(arrived as ConnectorRef, { building: attachment, name: input });
        drop = { building: attachment, name: south, position: attachmentPoint(type, center, south) };
        head = { building: attachment, name: through, position: attachmentPoint(type, center, through) };
      }
      remaining -= sink.perMinute;
      const atLift = branch.straight(drop, vec(lx, yLane, fz));
      laneToRow(branch, atLift, sink.entry!, detours.has(sink));
    }
  }

  // One power grid: each row's last pole wired to the next row's first pole (at most one extra wire
  // per pole), and the pump poles to the very last row pole, which has a free connection.
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].poleTops![rows[i - 1].poleTops!.length - 1];
    const c = rows[i].poleTops![0];
    b.wire({ building: a.pole, name: b.powerConnector(a.pole), position: a.position }, { building: c.pole, name: b.powerConnector(c.pole), position: c.position });
  }
  if (lanePoles.length > 0) {
    const last = rows[rows.length - 1].poleTops![rows[rows.length - 1].poleTops!.length - 1];
    b.wire({ building: last.pole, name: b.powerConnector(last.pole), position: last.position }, { building: lanePoles[0].pole, name: b.powerConnector(lanePoles[0].pole), position: lanePoles[0].position });
  }

  const productName = production.target.item.name;
  const unit = (f: Flow) => (f.kind === "belt" ? "/min" : " m³/min");
  const carrier = (f: Flow) => (f.kind === "belt" ? `belt Mk${tierFor("belt", f.perMinute)}` : `pipe Mk${tierFor("pipe", f.perMinute)}`);
  const rawFlows = flows.filter((f) => !f.source);
  const rawText = rawFlows.map((f) => `${fmt(f.perMinute)}${unit(f)} ${f.label} (${carrier(f)})`).join(", ");
  const outText = exported.map((f) => `${fmt(f.perMinute)}${unit(f)} ${f.label} (${carrier(f)})`).join(", ");
  const blueprint = b.build(options.name ?? `Factory ${fmt(options.rate)} ${productName}`, {
    description: `Complete factory: ${fmt(options.rate)}/min ${productName} in ${floors.length} floor(s). `
      + `Inputs at ground level, one each: ${rawText}. Outputs at ground level: ${outText}. Power: connect any pole.`,
    designerSize: (half * 2) / FOUNDATION,
    yaw: FLOW_TO_FRONT_YAW,
  });

  const pumps = blueprint.objects.filter((o) => PUMP_PATTERN.test(o.typePath) && "transform" in o).length;
  const report = [
    `${productName}: ${fmt(options.rate)}/min in ${floors.length} floor(s), ${rows.reduce((n, r) => n + r.row.options.count, 0)} machines${pumps ? `, ${pumps} pump(s)` : ""}`,
    ...floors.map((floor, f) => `  floor ${f} (${fmt(floorZ[f] / 100)} m): ` + floor.map((r) => {
      const partial = (r.row.options.clocks ?? []).filter((c) => Math.abs(c - 1) > 1e-6).map((c) => `${fmt(c * 100)}%`);
      const rate = r.step.outputs.find((o) => o.item.className === r.step.product.className)!.perMinute;
      return `${r.row.options.count}x ${r.row.spec.key} -> ${fmt(rate)}/min ${r.step.product.name}${partial.length ? ` (last at ${partial.join(", ")})` : ""}`;
    }).join(" | ")),
    `  inputs (one each, ground level): ${rawText}`,
    `  outputs (ground level): ${outText}`,
    ...flows.filter((f) => f.source && !f.exported && f.sinks.length > 1).map((f) => `  ${f.label} is shared by ${f.sinks.length} rows`),
    ...(rawFlows.some((f) => f.liquid) ? ["  liquid inputs need about 3 m of head lift at the port (an extractor gives 10 m)"] : []),
  ].join("\n");
  return { blueprint, report };
}

/** Raw materials and products with several consumers use a fan line; a single consumer is reached directly. */
function needsFan(flow: Flow): boolean {
  return !flow.exported && !flow.direct;
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
function chooseLaneOrder(flows: Flow[], exitOf: (flow: Flow) => { position: Vec3 }): { order: Flow[]; detours: Set<Sink | Flow> } {
  const exportedFlows = flows.filter((f) => f.exported);
  const others = flows.filter((f) => !f.exported);
  /** A lane (a consumer) or a source column: its horizontal leg and its vertical run start at the same row point. */
  type Element = { key: Sink | Flow; y: number; z: number; sameLane?: boolean };
  const elementsOf = (flow: Flow): Element[] => {
    const lanes: Element[] = sortSinks(flow).map((s) => (s.entry
      ? { key: s, y: s.entry.position.y, z: s.entry.position.z }
      : { key: s, y: -Infinity, z: -Infinity }));
    if (flow.source && needsFan(flow)) {
      const exit = exitOf(flow).position;
      lanes.push({ key: flow, y: exit.y, z: exit.z });
    } else if (flow.direct) {
      // Direct flow: its single lane also carries the run up from the exit.
      const exit = exitOf(flow).position;
      lanes.push({ key: flow, y: exit.y, z: exit.z, sameLane: true });
    } else if (flow.exported) {
      const exit = exitOf(flow).position;
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
        if (elements[j].sameLane && j === i + 1) continue; // two runs of the same lane
        if (Math.abs(elements[j].z - elements[i].z) < 200 && elements[j].y > elements[i].y) hit.add(elements[i].key);
      }
    }
    return hit;
  };
  let best = others;
  let bestCost = crossed([...others, ...exportedFlows]).size;
  const consider = (sequence: Flow[]) => {
    const c = crossed([...sequence, ...exportedFlows]).size;
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
  const order = [...best, ...exportedFlows];
  return { order, detours: crossed(order) };
}
