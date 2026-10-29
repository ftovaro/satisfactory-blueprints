import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BeltEnd, BlueprintBuilder, ConnectorRef, Placed, SIGN } from "../builder.js";
import { Vec3, add, transform, vec } from "../geometry.js";
import { GameData, pickTier } from "../gamedata/index.js";
import { PlanOptions, Step, fmt, plan } from "../planner/plan.js";
import { CELL, DIRS, Dir, Grid, LEVEL, Route, Start, Step as GridStep, perpendicular } from "../layout/grid.js";
import { Branch, buildRoute } from "../layout/route-builder.js";
import { BuiltRow, LineKind, PreparedRow, beltType, buildRow, libraryFor, liftType, pipeType, prepareRow } from "./machine-row.js";
import { rowOptionsFor } from "./row-options.js";
import { iconFor } from "../data/icons.js";
import { buildShell } from "../layout/shell.js";

/**
 * A complete factory in one blueprint: every production step of the target item, stacked in floors,
 * with a single input per raw material and a single output per product leaving the factory.
 *
 * Steps and floors
 * - One machine row per product (the planner's steps), shared by every step that uses it.
 * - Floor = how far a step is from raw materials: steps fed only by raw materials are on the ground
 *   floor, every other step one floor above its highest solid ingredient step (a fluid from another
 *   step keeps the consumer on the producer's floor when possible). Rows on a floor sit side by side,
 *   all with their connection end at the same x, on a slab of 8 m x 1 m foundations that covers only
 *   the rows. All rows share one power grid.
 *
 * Connections
 * - Routed in a 3D grid of 4 m cells (src/layout/grid.ts) around and between the rows: shortest paths
 *   made of straight runs, 90° turns and vertical runs (Conveyor Lifts, or vertical pipes with inline
 *   pumps for liquids). A cell holds one piece of one line, so lines never clash.
 * - Each flow (a raw material, or a row's product) is routed to its first consumer; every other
 *   consumer is reached by a branch that leaves an existing straight cell of the flow through a
 *   splitter (junction for pipes).
 * - Raw materials enter through open ends on the back edge (layout -X) at ground level; the final
 *   product and unused byproducts leave through open ends on the front edge (layout +X), in the
 *   direction of the placement arrow after the final rotation.
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
/** Gap (cm) between rows on the same floor: two cells, so lines can rise between them. */
const ROW_GAP = CELL;
/** Head room (cm) above the tallest thing on a floor; floors are a whole number of 4 m walls. */
const HEADROOM = 150;
const WALL = 400;
/**
 * Free space around the rows for routing: behind (where rows connect), in front, and to the sides.
 * The tightest that routes wins; a little overlap between pieces is preferred to a bigger building.
 */
interface Margins { back: number; front: number; side: number }
const MARGINS: Margins[] = [
  { back: 2 * CELL, front: 0, side: 0 },
  { back: 2 * CELL, front: CELL, side: CELL },
  { back: 3 * CELL, front: 2 * CELL, side: 2 * CELL },
];
const NO_ROUTE = "Could not route every connection";
/** One Conveyor Lift is at most about 48 m tall. */
const MAX_RISE_LEVELS = 12;
const ATTEMPTS = 60;
const PUMP_POLE = "Build_PowerPoleMk2_C";
const PUMP_POLE_HEIGHT = 400;
/** Rows are turned so inputs face +Y; their connection end is then at -X. */
const ROW_YAW = 180;
/** Signs float this far above the line they describe, and this far outside the routing grid for ports. */
const SIGN_HEIGHT = 350;
const SIGN_OFFSET = 150;
const SIGN_BACKGROUND = { r: 0.02, g: 0.02, b: 0.025, a: 1 };
/** FICSIT orange for inputs, green for outputs, white for machine rows. */
const INPUT_COLOR = { r: 0.98, g: 0.45, b: 0.05, a: 1 };
const OUTPUT_COLOR = { r: 0.15, g: 0.85, b: 0.3, a: 1 };
const ROW_COLOR = { r: 0.9, g: 0.9, b: 0.9, a: 1 };
const FLOW_TO_FRONT_YAW = -90;
/**
 * Rows taller than this (refineries, blenders) do not set their floor's height: they stand in a band
 * of their own beside the stacked floors and rise through them, so short rows are not spread over
 * tall floors.
 */
const TALL_ROW = 1300;
/** Row poles hang from a ceiling (a slab or the roof) at most this high above their floor. */
const MAX_HANG = 2000;

interface PlacedRow {
  step: Step;
  row: PreparedRow;
  floor: number;
  /** Translation of the row's frame. */
  x: number;
  y: number;
  ports?: (BuiltRow["ports"][number] & { global: Vec3 })[];
  poleTops?: { pole: Placed; position: Vec3; hanging: boolean }[];
}

/** One consumer of a flow: a row input, or (for exported products) the front edge. */
interface Sink {
  row?: PlacedRow;
  inputIndex?: number;
  perMinute: number;
  entry?: ConnectorRef & { position: Vec3 };
}

interface Flow {
  item: string;
  label: string;
  kind: LineKind;
  liquid: boolean;
  perMinute: number;
  source?: { row: PlacedRow; output: number };
  sinks: Sink[];
  exported: boolean;
}

/** A routed line: from the flow's source, or branching off another routed line of the same flow. */
interface RoutedLine {
  flow: Flow;
  sink: Sink;
  route: Route;
  parent?: { line: RoutedLine; stepIndex: number; side: Dir };
  children: RoutedLine[];
}

export function generateFactory(data: GameData, options: FactoryOptions): { blueprint: Blueprint; report: string } {
  for (const margins of MARGINS) {
    try {
      return layoutFactory(data, options, margins);
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith(NO_ROUTE)) || margins === MARGINS[MARGINS.length - 1]) throw e;
    }
  }
  throw new Error(NO_ROUTE);
}

function layoutFactory(data: GameData, options: FactoryOptions, margins: Margins): { blueprint: Blueprint; report: string } {
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

  // Floors: one above the highest step whose solid product a step uses; fluids keep their floor.
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
    return { step, row: prepareRow({ ...rowOptionsFor(data, recipe, rate), inputFrom: "east", pole: options.pole }), floor: floorOf(step), x: 0, y: 0 };
  });
  const rowOfStep = new Map(rows.map((r) => [r.step, r]));
  const floors = Array.from({ length: Math.max(...rows.map((r) => r.floor)) + 1 }, (_, f) => rows.filter((r) => r.floor === f));

  // Placement: turned rows (yaw 180 mirrors X and Y), connection ends aligned at x = 0, stacked in y.
  // Tall rows go side by side in a band past the other rows' side.
  const extentOf = (r: PlacedRow) => {
    const e = r.row.extent;
    return { minX: r.x - e.maxX, maxX: r.x - e.minX, minY: r.y - e.maxY, maxY: r.y - e.minY };
  };
  const tall = (r: PlacedRow) => r.row.height > TALL_ROW;
  const stack = (list: PlacedRow[], from: number) => {
    let cursor = from;
    for (const r of list) {
      r.x = r.row.extent.maxX;
      const e = extentOf({ ...r, y: 0 });
      r.y = cursor - e.minY;
      cursor = r.y + e.maxY + ROW_GAP;
    }
    return cursor;
  };
  for (const floor of floors) {
    const short = floor.filter((r) => !tall(r));
    const shift = (stack(short, 0) - ROW_GAP) / 2;
    for (const r of short) r.y -= shift;
  }
  const shortRows = rows.filter((r) => !tall(r));
  const tallRows = rows.filter(tall);
  if (shortRows.length > 0) stack(tallRows, Math.max(...shortRows.map((r) => extentOf(r).maxY)) + ROW_GAP);
  else {
    const shift = (stack(tallRows, 0) - ROW_GAP) / 2;
    for (const r of tallRows) r.y -= shift;
  }
  // Floor heights follow the short rows only; a floor of tall rows only adds no height.
  // The ground floor is wherever the blueprint is placed (no foundations of its own); upper floors are slabs.
  const floorZ: number[] = [];
  let z = 0;
  for (const floor of floors) {
    floorZ.push(z);
    const short = floor.filter((r) => !tall(r));
    if (short.length > 0) z += Math.ceil((Math.max(...short.map((r) => r.row.height)) + SLAB + HEADROOM) / WALL) * WALL;
  }
  const top = Math.max(z, ...rows.filter(tall).map((r) => floorZ[r.floor] + r.row.height + SLAB + HEADROOM));
  // The roof rests on the walls right above the last floor (floors are whole walls tall).
  const roofZ = Math.ceil(top / WALL) * WALL;

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
  for (const e of [{ item: production.target.item.className, perMinute: options.rate }, ...production.byproducts.map((p) => ({ item: p.item.className, perMinute: p.perMinute }))]) {
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
  const required = new Set<string>([FOUNDATION_TYPE, SIGN, options.pole === 2 ? "Build_PowerPoleWall_Mk2_C" : "Build_PowerPoleWall_C"]);
  for (const f of flows) {
    for (const rate of [f.perMinute, ...f.sinks.map((s) => s.perMinute)]) {
      const t = tierFor(f.kind, rate);
      if (f.kind === "belt") required.add(beltType(t)).add(liftType(t));
      else required.add(pipeType(t));
    }
    if (f.sinks.length > 1) required.add(f.kind === "belt" ? "Build_ConveyorAttachmentSplitter_C" : "Build_PipelineJunction_Cross_C");
    if (f.kind === "pipe" && f.liquid) required.add("Build_PipelinePump_C").add(PUMP_POLE);
  }
  const b = new BlueprintBuilder(libraryFor(rows.map((r) => r.row), [...required]));

  // Slabs under the rows and the rows themselves.
  const slabs = floors.map((floor) => {
    const e = floor.map(extentOf);
    return {
      minX: Math.floor(Math.min(...e.map((x) => x.minX)) / FOUNDATION) * FOUNDATION,
      maxX: Math.ceil(Math.max(...e.map((x) => x.maxX)) / FOUNDATION) * FOUNDATION,
      rows: e,
    };
  });
  floors.forEach((floor, f) => {
    // One strip of foundations per row, so the gaps between rows stay open for vertical lines.
    if (floorZ[f] <= 0) return;
    for (const e of slabs[f].rows) {
      for (let x = slabs[f].minX; x < e.maxX; x += FOUNDATION) {
        for (let y = Math.floor(e.minY / FOUNDATION) * FOUNDATION; y < e.maxY; y += FOUNDATION) {
          b.place(FOUNDATION_TYPE, transform(vec(x + FOUNDATION / 2, y + FOUNDATION / 2, floorZ[f] - SLAB / 2)));
        }
      }
    }
  });
  // What is over a spot of a floor: the lowest slab above that covers it, else the roof.
  const ceilingOver = (f: number, x: number, y: number): number => {
    for (let g = f + 1; g < floors.length; g++) {
      if (floorZ[g] <= floorZ[f]) continue;
      const covered = slabs[g].rows.some((e) => x >= slabs[g].minX && x <= e.maxX && y >= Math.floor(e.minY / FOUNDATION) * FOUNDATION && y <= e.maxY);
      if (covered) return floorZ[g] - SLAB;
    }
    return roofZ;
  };
  for (const r of rows) {
    b.withFrame(transform(vec(r.x, r.y, floorZ[r.floor]), ROW_YAW), () => {
      const built = buildRow(b, r.row, {
        ceilingAt: (spot) => {
          // The row frame is turned 180°.
          const height = ceilingOver(r.floor, r.x - spot.x, r.y - spot.y) - floorZ[r.floor];
          return height > r.row.height && height <= MAX_HANG ? height : undefined;
        },
      });
      r.ports = built.ports.map((p) => ({ ...p, global: b.toBlueprint(p.point.position) }));
      r.poleTops = built.poles.map((p) => ({ pole: p.pole, position: b.toBlueprint(p.position), hanging: p.hanging }));
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

  // The routing grid: cell centers on a 4 m lattice, levels at belt height above each floor.
  const all = rows.map(extentOf);
  const bounds = {
    minX: -margins.back,
    maxX: Math.max(...all.map((e) => e.maxX)) + margins.front,
    minY: Math.min(...all.map((e) => e.minY)) - margins.side,
    maxY: Math.max(...all.map((e) => e.maxY)) + margins.side,
  };
  // Cell centers fall on multiples of CELL in x, so the first cell behind the rows (which end at
  // x = 0) is centered 4 m behind them and touches them.
  const origin = { x: bounds.minX, y: bounds.minY + CELL / 2, z: floorZ[0] + 100 };
  // An even number of cells each way, so the walls around the grid tile in 8 m panels.
  const even = (n: number) => n + (n % 2);
  const size = {
    nx: even(Math.ceil((bounds.maxX - bounds.minX) / CELL)),
    ny: even(Math.ceil((bounds.maxY - bounds.minY) / CELL)),
    // Routing levels stay at least 2 m under the roof.
    nz: Math.floor((roofZ - 200 - origin.z) / LEVEL) + 1,
  };
  const makeGrid = () => {
    const grid = new Grid(origin, size);
    rows.forEach((r) => {
      const e = extentOf(r);
      grid.blockBox({ minX: e.minX - 150, maxX: e.maxX + 150, minY: e.minY - 150, maxY: e.maxY + 150, minZ: floorZ[r.floor] - SLAB, maxZ: floorZ[r.floor] + r.row.height });
      // Hanging poles keep lines out of the cell under them.
      for (const p of r.poleTops!.filter((t) => t.hanging)) {
        grid.blockBox({ minX: p.position.x - CELL / 2, maxX: p.position.x + CELL / 2, minY: p.position.y - CELL / 2, maxY: p.position.y + CELL / 2, minZ: p.position.z - LEVEL, maxZ: p.position.z });
      }
    });
    floors.forEach((_, f) => {
      if (f === 0) return;
      for (const e of slabs[f].rows) grid.blockVerticalAt({ minX: slabs[f].minX - 150, maxX: e.maxX + 150, minY: e.minY - 150, maxY: e.maxY + 150 }, floorZ[f] - SLAB / 2);
    });
    return grid;
  };
  const probe = makeGrid();

  // Where lines meet rows: the cell just behind the row end, at the port's height.
  const portCell = (p: Vec3, rowMinX: number) => {
    const i = Math.floor((rowMinX - 250 - origin.x) / CELL);
    return { i, j: Math.round((p.y - origin.y) / CELL), k: Math.round((p.z - origin.z) / LEVEL) };
  };
  const rowMinX = (r: PlacedRow) => extentOf(r).minX;
  const edgeStarts = (): Start[] => Array.from({ length: size.ny }, (_, j) => ({ cell: { i: 0, j, k: 0 }, dir: 0 as Dir }));
  const exportGoals = () => Array.from({ length: size.ny }, (_, j) => ({ cell: { i: size.nx - 1, j, k: 0 }, dir: 0 as Dir }));

  // Route every flow; retry in other orders until everything fits.
  const routeAll = (order: Flow[]): { grid: Grid; lines: RoutedLine[] } | undefined => {
    const grid = makeGrid();
    // Port cells are reserved so other lines do not run through them; each is released for its own line.
    const RESERVED = -3;
    const portCells = flows.flatMap((f) => [
      ...(f.source ? [portCell(exitOf(f).position, rowMinX(f.source.row))] : []),
      ...f.sinks.filter((s) => s.row).map((s) => portCell(s.entry!.position, rowMinX(s.row!))),
    ]);
    portCells.forEach((c) => grid.take(c, RESERVED));
    const release = (c: { i: number; j: number; k: number }) => {
      if (grid.ownerOf(c) === RESERVED) grid.take(c, 0);
    };
    const lines: RoutedLine[] = [];
    let id = 1;
    for (const flow of order) {
      const own: RoutedLine[] = [];
      const sinks = [...flow.sinks].sort((a, c) => (a.entry?.position.z ?? 0) - (c.entry?.position.z ?? 0));
      for (const sink of sinks) {
        const goals = sink.row
          ? [{ cell: portCell(sink.entry!.position, rowMinX(sink.row)), dir: 0 as Dir }]
          : exportGoals();
        let starts: Start[];
        if (own.length === 0) {
          starts = flow.source ? [{ cell: portCell(exitOf(flow).position, rowMinX(flow.source.row)), dir: 2 as Dir }] : edgeStarts();
        } else {
          // Branch off any straight cell already carrying this flow.
          starts = [];
          for (const line of own) {
            line.route.steps.forEach((step, stepIndex) => {
              if (step.kind !== "straight" || own.some((l) => l.children.some((c) => c.parent!.line === line && c.parent!.stepIndex === stepIndex))) return;
              for (const side of perpendicular(step.dir)) {
                const cell = { i: step.cell.i + DIRS[side][0], j: step.cell.j + DIRS[side][1], k: step.cell.k };
                starts.push({ cell, dir: side, cost: 2, tag: { line, stepIndex, side } });
              }
            });
          }
        }
        goals.forEach((g) => release(g.cell));
        if (own.length === 0 && flow.source) release(starts[0].cell);
        // A shared flow starts with one straight cell, so later consumers always have a place to branch.
        let prefix: GridStep[] = [];
        if (own.length === 0 && flow.sinks.length > 1) {
          const shifted: Start[] = [];
          for (const s of starts) {
            const next = { i: s.cell.i + DIRS[s.dir][0], j: s.cell.j + DIRS[s.dir][1], k: s.cell.k };
            if (grid.isFree(s.cell) && grid.isFree(next)) shifted.push({ ...s, cell: next, tag: s });
          }
          starts = shifted;
        }
        const found = grid.route(starts, goals, { maxRise: MAX_RISE_LEVELS, allowRise: true });
        if (found && own.length === 0 && flow.sinks.length > 1) {
          const c = found.steps[0].cell;
          const used = starts.find((s) => s.cell.i === c.i && s.cell.j === c.j && s.cell.k === c.k)!.tag as Start;
          prefix = [{ kind: "straight", cell: used.cell, dir: used.dir }];
        }
        const route = found && { steps: [...prefix, ...found.steps] };
        if (!route) {
          if (process.env.SBP_DEBUG) console.error(`no route: ${flow.label} -> ${sink.row?.step.product.name ?? "edge"} (starts ${starts.length}, goals ${goals.map((g) => JSON.stringify(g.cell)).join(" ")})`);
          return undefined;
        }
        // Which start was used: the route's first step is in that start's cell.
        const first = route.steps[0].cell;
        const start = starts.find((s) => s.cell.i === first.i && s.cell.j === first.j && s.cell.k === first.k);
        const line: RoutedLine = { flow, sink, route, children: [], parent: own.length > 0 ? (start!.tag as RoutedLine["parent"]) : undefined };
        if (line.parent) line.parent.line.children.push(line);
        grid.claim(route, id++);
        own.push(line);
        lines.push(line);
      }
    }
    return { grid, lines };
  };
  for (const flow of flows) {
    for (const sink of flow.sinks) {
      if (sink.row && !probe.isFree(portCell(sink.entry!.position, rowMinX(sink.row)))) throw new Error(`No room to reach ${sink.row.step.product.name}'s ${flow.label} input.`);
    }
  }
  // Flows with the longest climbs first; then shuffled orders until one routes completely.
  const climb = (f: Flow) => Math.max(...f.sinks.map((s) => (s.entry?.position.z ?? 0))) - (f.source ? exitOf(f).position.z : 0);
  let routed = routeAll([...flows].sort((a, c) => climb(c) - climb(a) || c.sinks.length - a.sinks.length));
  for (let attempt = 1; !routed && attempt < ATTEMPTS; attempt++) routed = routeAll([...flows].sort(() => Math.random() - 0.5));
  if (!routed) throw new Error(`${NO_ROUTE}; try a lower rate or fewer steps.`);
  const { grid, lines } = routed;

  // Pumps are wired to poles standing on free ground cells near them.
  const pumpPoles: { pole: Placed; position: Vec3; wires: number }[] = [];
  const onPump = (pump: Placed, at: Vec3) => {
    let pole = pumpPoles.find((p) => p.wires < 6 && Math.hypot(p.position.x - at.x, p.position.y - at.y, p.position.z - at.z) < 6000);
    if (!pole) {
      const c = grid.cellAt(at);
      let spot: Vec3 | undefined;
      for (let r = 1; r <= 4 && !spot; r++) {
        for (let di = -r; di <= r && !spot; di++) for (let dj = -r; dj <= r && !spot; dj++) {
          const cell = { i: c.i + di, j: c.j + dj, k: 0 };
          if (grid.isFree(cell)) {
            grid.take(cell, -2);
            spot = grid.center(cell);
          }
        }
      }
      const base = spot ? vec(spot.x, spot.y, spot.z - 100) : vec(at.x + 200, at.y + 200, at.z - 100);
      const placed = b.place(PUMP_POLE, transform(base));
      const position = add(base, vec(0, 0, PUMP_POLE_HEIGHT));
      const previous = pumpPoles[pumpPoles.length - 1];
      if (previous) {
        b.wire({ building: previous.pole, name: b.powerConnector(previous.pole), position: previous.position }, { building: placed, name: b.powerConnector(placed), position });
        previous.wires++;
      }
      pole = { pole: placed, position, wires: previous ? 1 : 0 };
      pumpPoles.push(pole);
    }
    b.wire({ building: pole.pole, name: b.powerConnector(pole.pole), position: pole.position }, { building: pump, name: b.powerConnector(pump), position: at });
    pole.wires++;
  };

  // Build every line: the trunk from its source, then its branches from their splitters/junctions.
  const rateOf = (line: RoutedLine): number => line.sink.perMinute + line.children.reduce((s, c) => s + rateOf(c), 0);
  const ctx = { b, grid, onPump };
  const buildLine = (line: RoutedLine, from: BeltEnd) => {
    const { flow, sink } = line;
    const spec = { kind: flow.kind, tier: tierFor(flow.kind, rateOf(line)), liquid: flow.liquid };
    const branches: Branch[] = line.children.map((child) => ({
      stepIndex: child.parent!.stepIndex,
      side: child.parent!.side,
      build: (start: BeltEnd) => {
        // From the splitter/junction's side connector to the branch's first cell.
        const cell = grid.center(child.route.steps[0].cell);
        const dir = vec(DIRS[child.parent!.side][0], DIRS[child.parent!.side][1], 0);
        const entry = add(cell, vec(-dir.x * CELL / 2, -dir.y * CELL / 2, 0));
        buildLine(child, connect(child.flow, tierFor(child.flow.kind, rateOf(child)), start, entry, dir));
      },
    }));
    const end = buildRoute(ctx, line.route, spec, from, branches);
    if (sink.entry) connect(flow, tierFor(flow.kind, sink.perMinute), end, sink.entry.position, vec(1, 0, 0), sink.entry);
    else ports.push({ flow, at: end.position, side: "output" });
  };
  /** A short belt/pipe moving along `dir` (curving sideways or vertically if needed). */
  function connect(flow: Flow, tier: number, from: BeltEnd, to: Vec3, dir: Vec3, target?: ConnectorRef): BeltEnd {
    const end: BeltEnd = target ? { ...target, position: to } : { position: to };
    if (Math.hypot(to.x - from.position.x, to.y - from.position.y, to.z - from.position.z) < 5) {
      if (target && from.building) b.link(from as ConnectorRef, target);
      return from;
    }
    const piece = flow.kind === "belt" ? b.belt(beltType(tier), from, end, dir) : b.pipe(pipeType(tier), from, end, dir);
    return { building: piece, name: flow.kind === "belt" ? "ConveyorAny1" : "PipelineConnection1", position: to };
  }
  const ports: { flow: Flow; at: Vec3; side: "input" | "output" }[] = [];
  for (const line of lines.filter((l) => !l.parent)) {
    const { flow } = line;
    const first = grid.center(line.route.steps[0].cell);
    let from: BeltEnd;
    if (flow.source) {
      // From the row's exit (moving -X) to the first cell's east side.
      from = connect(flow, tierFor(flow.kind, flow.perMinute), exitOf(flow), add(first, vec(CELL / 2, 0, 0)), vec(-1, 0, 0));
    } else {
      // Raw material: an open end on the back edge.
      from = { position: add(first, vec(-CELL / 2, 0, 0)) };
      ports.push({ flow, at: from.position, side: "input" });
    }
    buildLine(line, from);
  }

  // Signs: what comes in and goes out (just outside the routing grid, above each open end, facing
  // away from the factory), and what each row makes (behind its connection end, above its ports).
  const units = (f: Flow) => (f.kind === "belt" ? "/min" : " m³/min");
  for (const port of ports) {
    const outward = port.side === "input" ? -1 : 1;
    b.sign(vec(port.at.x + outward * SIGN_OFFSET, port.at.y, port.at.z + SIGN_HEIGHT), port.side === "input" ? 180 : 0, {
      texts: {
        // The sign layout shows only its main text, so the rate goes next to the item.
        Name: `${port.flow.label.toUpperCase()} ${fmt(port.flow.perMinute)}${units(port.flow)}`,
        Other_0: `${port.side === "input" ? "INPUT" : "OUTPUT"} · ${port.flow.kind} Mk${tierFor(port.flow.kind, port.flow.perMinute)}`,
        Other_1: `${fmt(port.flow.perMinute)}${units(port.flow)}`,
      },
      icon: iconFor(port.flow.label),
      text: port.side === "input" ? INPUT_COLOR : OUTPUT_COLOR,
      background: SIGN_BACKGROUND,
    });
  }
  for (const r of rows) {
    const e = extentOf(r);
    const levels = Math.max(r.row.inputLines.length, r.row.outputLines.length) - 1;
    const rate = r.step.outputs.find((o) => o.item.className === r.step.product.className)!.perMinute;
    b.sign(vec(e.minX - CELL / 2, (e.minY + e.maxY) / 2, floorZ[r.floor] + 100 + levels * LEVEL + SIGN_HEIGHT), 180, {
      texts: {
        Name: `${r.step.product.name.toUpperCase()} ${fmt(rate)}/min`,
        Other_0: `${r.row.options.count}x ${r.row.spec.key}${(r.row.options.clocks ?? []).some((c) => Math.abs(c - 1) > 1e-6) ? ` (last at ${fmt((r.row.options.clocks ?? []).slice(-1)[0] * 100)}%)` : ""}`,
        Other_1: `${fmt(rate)}/min`,
      },
      icon: iconFor(r.step.product.name),
      text: ROW_COLOR,
      background: SIGN_BACKGROUND,
    });
  }

  // The building: walls on the grid's outer edge (where the ports are), holes where lines cross
  // them, a flat roof above everything and a wall pole outside the back wall as the power inlet.
  const envelope = {
    minX: origin.x - CELL / 2, maxX: origin.x + (size.nx - 0.5) * CELL,
    minY: origin.y - CELL / 2, maxY: origin.y + (size.ny - 0.5) * CELL,
  };
  const shell = buildShell(b, { envelope, floorZ: 0, roofZ, openings: ports.map((p) => ({ at: p.at, kind: p.flow.kind })) });
  if (shell.inlet) {
    const first = rows[0].poleTops![0];
    b.wire({ building: shell.inlet.pole, name: b.powerConnector(shell.inlet.pole), position: shell.inlet.position }, { building: first.pole, name: b.powerConnector(first.pole), position: first.position });
  }

  // One power grid: each row's last pole wired to the next row's first pole, pump poles to the last row pole.
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].poleTops![rows[i - 1].poleTops!.length - 1];
    const c = rows[i].poleTops![0];
    b.wire({ building: a.pole, name: b.powerConnector(a.pole), position: a.position }, { building: c.pole, name: b.powerConnector(c.pole), position: c.position });
  }
  if (pumpPoles.length > 0) {
    const last = rows[rows.length - 1].poleTops![rows[rows.length - 1].poleTops!.length - 1];
    b.wire({ building: last.pole, name: b.powerConnector(last.pole), position: last.position }, { building: pumpPoles[0].pole, name: b.powerConnector(pumpPoles[0].pole), position: pumpPoles[0].position });
  }

  const productName = production.target.item.name;
  const unit = (f: Flow) => (f.kind === "belt" ? "/min" : " m³/min");
  const carrier = (f: Flow) => `${f.kind} Mk${tierFor(f.kind, f.perMinute)}`;
  const rawFlows = flows.filter((f) => !f.source);
  const exported = flows.filter((f) => f.exported);
  const rawText = rawFlows.map((f) => `${fmt(f.perMinute)}${unit(f)} ${f.label} (${carrier(f)})`).join(", ");
  const outText = exported.map((f) => `${fmt(f.perMinute)}${unit(f)} ${f.label} (${carrier(f)})`).join(", ");
  const half = Math.ceil(Math.max(-envelope.minX, envelope.maxX, -envelope.minY, envelope.maxY) / FOUNDATION) * FOUNDATION;
  const blueprint = b.build(options.name ?? `Factory ${fmt(options.rate)} ${productName}`, {
    description: `Complete factory: ${fmt(options.rate)}/min ${productName} in ${floors.length} floor(s). `
      + `Inputs at ground level on the back edge, one each: ${rawText}. Outputs at ground level on the front edge: ${outText}. Power: connect any pole.`,
    designerSize: (half * 2) / FOUNDATION,
    yaw: FLOW_TO_FRONT_YAW,
  });

  const pumps = blueprint.objects.filter((o) => /Build_PipelinePump_C$/.test(o.typePath) && "transform" in o).length;
  const report = [
    `${productName}: ${fmt(options.rate)}/min in ${floors.length} floor(s), ${rows.reduce((n, r) => n + r.row.options.count, 0)} machines${pumps ? `, ${pumps} pump(s)` : ""}, building ${fmt((envelope.maxX - envelope.minX) / 100)} x ${fmt((envelope.maxY - envelope.minY) / 100)} x ${fmt(roofZ / 100)} m`,
    ...floors.map((floor, f) => `  floor ${f} (${fmt(floorZ[f] / 100)} m): ` + floor.map((r) => {
      const partial = (r.row.options.clocks ?? []).filter((c) => Math.abs(c - 1) > 1e-6).map((c) => `${fmt(c * 100)}%`);
      const rate = r.step.outputs.find((o) => o.item.className === r.step.product.className)!.perMinute;
      return `${r.row.options.count}x ${r.row.spec.key} -> ${fmt(rate)}/min ${r.step.product.name}${partial.length ? ` (last at ${partial.join(", ")})` : ""}`;
    }).join(" | ")),
    `  inputs (back edge, ground level): ${rawText}`,
    `  outputs (front edge, ground level): ${outText}`,
    ...flows.filter((f) => f.source && !f.exported && f.sinks.length > 1).map((f) => `  ${f.label} is shared by ${f.sinks.length} rows`),
    ...(rawFlows.some((f) => f.liquid) ? ["  liquid inputs need about 3 m of head lift at the port (an extractor gives 10 m)"] : []),
  ].join("\n");
  return { blueprint, report };
}
