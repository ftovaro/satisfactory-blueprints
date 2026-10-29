import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BeltEnd, BlueprintBuilder, ConnectorRef, Placed } from "../builder.js";
import { Vec3, add, transform, vec } from "../geometry.js";
import { GameData, findItem, pickTier } from "../gamedata/index.js";
import { Generator, Item } from "../gamedata/types.js";
import { PlanOptions, Step, fmt, machineClocks, plan } from "../planner/plan.js";
import { MACHINES } from "../data/machines.js";
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
  /** Burn the target in generators instead of exporting it (a power plant). */
  power?: { generator: Generator; fuel: Item; megawatts: number; fuelPerGenerator: number };
}

export interface PowerPlantOptions extends PlanOptions {
  /** Generator name or class, e.g. "Fuel-Powered Generator". */
  generator: string;
  fuel: string;
  megawatts: number;
  /** Count the plant's own use (machines, pumps) so `megawatts` is what it delivers. */
  net?: boolean;
  name?: string;
  pole?: number;
}

/** Pipeline Pump Mk1 power (game Docs). */
const PUMP_MW = 4;

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
/**
 * Small signs (icon, then "NAME rate" on one line) hang on the walls, this far above the line they
 * describe, 19 cm off the wall (as in real blueprints).
 */
const SMALL_SIGN = "Build_StandaloneWidgetSign_Small_C";
const SIGN_HEIGHT = 250;
const SIGN_OFF_WALL = 19;
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
const LADDER_SEGMENT = 200;

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

/**
 * A power plant: the fuel's production chain feeding a row of generators, all in one building.
 * Generators run at 100% except the last one. With `net`, the plant also covers its own machines
 * and pumps (found by laying it out, then again with the pumps it needed).
 */
export function generatePowerPlant(data: GameData, options: PowerPlantOptions): { blueprint: Blueprint; report: string } {
  const query = options.generator.toLowerCase();
  const generator = Object.values(data.generators ?? {}).find((g) => g.className === options.generator || g.name.toLowerCase().startsWith(query));
  if (!generator) throw new Error(`Unknown generator "${options.generator}". Known: ${Object.values(data.generators ?? {}).map((g) => g.name).join(", ")}. Run "sbp import-game-data" if none are listed.`);
  const fuel = findItem(data, options.fuel);
  if (!generator.fuels.includes(fuel.className) || !fuel.energy) throw new Error(`${generator.name} does not burn ${fuel.name}.`);
  if (fuel.form === "solid") throw new Error("Only fluid fuels are supported for now.");
  const fuelPerGenerator = (generator.power * 60) / fuel.energy;
  const fuelFor = (megawatts: number) => (megawatts / generator.power) * fuelPerGenerator;
  let pumps = 0;
  for (let pass = 0; ; pass++) {
    let gross = options.megawatts;
    if (options.net) {
      for (let i = 0; i < 20; i++) {
        const own = plan(data, fuel.className, fuelFor(gross), options).steps.reduce((sum, step) => sum + step.power, 0);
        gross = options.megawatts + own + pumps * PUMP_MW;
      }
    }
    const result = generateFactory(data, {
      ...options, target: fuel.className, rate: fuelFor(gross),
      name: options.name ?? `${fuel.name} Power Plant ${fmt(options.megawatts)} MW${options.net ? " net" : ""}`,
      power: { generator, fuel, megawatts: gross, fuelPerGenerator },
    });
    const used = result.blueprint.objects.filter((o) => /Build_PipelinePump_C$/.test(o.typePath) && "transform" in o).length;
    if (!options.net || used <= pumps || pass >= 2) return result;
    pumps = used;
  }
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
  // Power plant: a row of generators burning the target.
  const power = options.power;
  if (power) {
    const spec = Object.values(MACHINES).find((m) => m.type === power.generator.className);
    if (!spec) throw new Error(`No layout for ${power.generator.name} yet.`);
    const clocks = machineClocks(power.megawatts, power.generator.power);
    const step: Step = {
      recipe: { className: "", name: power.generator.name, path: "", alternate: false, machine: power.generator.className, duration: 60, inputs: [{ item: power.fuel.className, amount: options.rate }], outputs: [] },
      product: power.fuel, clocks, productPerMachine: 0, inputs: [{ item: power.fuel, perMinute: options.rate }], outputs: [], power: -power.megawatts,
    };
    rows.push({
      step, floor: floorOf(step), x: 0, y: 0,
      row: prepareRow({
        machine: spec.key, count: clocks.length, clocks, inputFrom: "east", pole: options.pole, outputs: [],
        inputs: [{ label: power.fuel.name, kind: kindOf(power.fuel.className), perMachine: clocks.map((c) => c * power.fuelPerGenerator) }],
        speeds: { belt: data.belts.map((t) => t.perMinute), pipe: data.pipes.map((t) => t.perMinute) },
      }),
    });
  }
  // What a row's sign and the report say it makes.
  const rowText = (r: PlacedRow) => {
    if (r.row.spec.generator) return `${power!.generator.name}: ${fmt(-r.step.power)} MW`;
    const rate = r.step.outputs.find((o) => o.item.className === r.step.product.className)!.perMinute;
    return `${r.step.product.name}: ${fmt(rate)}${r.step.product.form === "solid" ? "/min" : " m³/min"}`;
  };
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
  for (const e of [...(power ? [] : [{ item: production.target.item.className, perMinute: options.rate }]), ...production.byproducts.map((p) => ({ item: p.item.className, perMinute: p.perMinute }))]) {
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
  const required = new Set<string>([FOUNDATION_TYPE, SMALL_SIGN, options.pole === 2 ? "Build_PowerPoleWall_Mk2_C" : "Build_PowerPoleWall_C"]);
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

  // What is over a floor: the next floor up (a full slab), else the roof.
  const levels = [...new Set(floorZ.filter((z) => z > 0))].sort((a, c) => a - c);
  const ceilingOver = (f: number): number => {
    const above = levels.find((z) => z > floorZ[f]);
    return above !== undefined ? above - SLAB : roofZ;
  };
  for (const r of rows) {
    b.withFrame(transform(vec(r.x, r.y, floorZ[r.floor]), ROW_YAW), () => {
      const built = buildRow(b, r.row, {
        ceilingAt: () => {
          const height = ceilingOver(r.floor) - floorZ[r.floor];
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
  // Walls tile in 8 m panels. Along x the grid has an even number of cells. Along y it has an odd
  // number, and the walls reach half a cell past it, so every other cell is centered on a panel: the
  // ports use those cells, so belts pass through the middle of conveyor wall panels.
  const even = (n: number) => n + (n % 2);
  const odd = (n: number) => n + 1 - (n % 2);
  const size = {
    nx: even(Math.ceil((bounds.maxX - bounds.minX) / CELL)),
    ny: odd(Math.ceil((bounds.maxY - bounds.minY) / CELL)),
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
    return grid;
  };
  const probe = makeGrid();

  // Where lines meet rows: the cell just behind the row end, at the port's height.
  const portCell = (p: Vec3, rowMinX: number) => {
    const i = Math.floor((rowMinX - 250 - origin.x) / CELL);
    return { i, j: Math.round((p.y - origin.y) / CELL), k: Math.round((p.z - origin.z) / LEVEL) };
  };
  const rowMinX = (r: PlacedRow) => extentOf(r).minX;
  const panelCells = Array.from({ length: (size.ny + 1) / 2 }, (_, n) => 2 * n);
  const edgeStarts = (): Start[] => panelCells.map((j) => ({ cell: { i: 0, j, k: 0 }, dir: 0 as Dir }));
  const exportGoals = () => panelCells.map((j) => ({ cell: { i: size.nx - 1, j, k: 0 }, dir: 0 as Dir }));

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

  // Signs: what comes in and goes out (on the outside of the wall, above each opening), and what each
  // row makes (on the inside of the back wall, facing the row's connection end, above its ports).
  const units = (f: Flow) => (f.kind === "belt" ? "/min" : " m³/min");
  for (const port of ports) {
    const outward = port.side === "input" ? -1 : 1;
    b.sign(vec(port.at.x + outward * SIGN_OFF_WALL, port.at.y, port.at.z + SIGN_HEIGHT), port.side === "input" ? 180 : 0, {
      type: SMALL_SIGN,
      texts: { Name: `${port.flow.label.toUpperCase()} ${fmt(port.flow.perMinute)}${units(port.flow)}` },
      icon: iconFor(port.flow.label),
      text: port.side === "input" ? INPUT_COLOR : OUTPUT_COLOR,
      background: SIGN_BACKGROUND,
    });
  }
  for (const r of rows) {
    const e = extentOf(r);
    const levels = Math.max(r.row.inputLines.length, r.row.outputLines.length) - 1;
    b.sign(vec(origin.x - CELL / 2 + SIGN_OFF_WALL, (e.minY + e.maxY) / 2, floorZ[r.floor] + 100 + levels * LEVEL + SIGN_HEIGHT), 0, {
      type: SMALL_SIGN,
      texts: { Name: rowText(r).replace(":", "").toUpperCase() },
      icon: iconFor(r.step.product.name),
      text: ROW_COLOR,
      background: SIGN_BACKGROUND,
    });
  }

  // The building: walls on the grid's outer edge (where the ports are), holes where lines cross
  // them, a flat roof above everything and a wall pole outside the back wall as the power inlet.
  const envelope = {
    minX: origin.x - CELL / 2, maxX: origin.x + (size.nx - 0.5) * CELL,
    minY: origin.y - CELL, maxY: origin.y + size.ny * CELL,
  };
  // A style picked from the product name, so each factory looks a little different.
  const style = [...production.target.item.name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

  // Upper floors: full slabs over the whole building, cut out where a tall row rises through, with a
  // Floor Hole wherever a lift or pipe crosses, and an opening by a side wall with a ladder up to it.
  const floorType = b.pick(...(style % 2 ? ["Build_Foundation_Metal_8x1_C"] : []), FOUNDATION_TYPE)!;
  const ladderType = b.pick("Build_Ladder_C");
  const liftHole = b.pick("Build_FoundationPassthrough_Lift_C");
  const pipeHole = b.pick("Build_FoundationPassthrough_Pipe_C");
  type Tile = { x0: number; y0: number; x1: number; y1: number };
  const overlaps = (t: Tile, e: { minX: number; maxX: number; minY: number; maxY: number }) => t.x0 < e.maxX && t.x1 > e.minX && t.y0 < e.maxY && t.y1 > e.minY;
  const tileAt = (x: number, y: number): Tile => {
    const x0 = envelope.minX + Math.floor((x - envelope.minX) / FOUNDATION) * FOUNDATION;
    const y0 = envelope.minY + Math.floor((y - envelope.minY) / FOUNDATION) * FOUNDATION;
    return { x0, y0, x1: x0 + FOUNDATION, y1: y0 + FOUNDATION };
  };
  const key = (z: number, t: Tile) => `${z}:${t.x0}:${t.y0}`;
  const solid = new Set<string>();
  const ladders: Vec3[] = [];
  let lastOpening: Tile | undefined;
  levels.forEach((z, n) => {
    const below = n === 0 ? 0 : levels[n - 1];
    const cutouts = rows.filter((r) => tall(r) && floorZ[r.floor] < z && floorZ[r.floor] + r.row.height > z - SLAB - HEADROOM).map(extentOf);
    const standing = rows.filter((r) => floorZ[r.floor] === z).map(extentOf);
    const tiles: Tile[] = [];
    for (let x = envelope.minX; x < envelope.maxX; x += FOUNDATION) {
      for (let y = envelope.minY; y < envelope.maxY; y += FOUNDATION) tiles.push({ x0: x, y0: y, x1: x + FOUNDATION, y1: y + FOUNDATION });
    }
    // The ladder opening: a tile against a side wall, with nothing standing on it or rising through
    // it, and not above the opening of the floor below (the ladder stands on solid floor).
    const opening = !ladderType ? undefined : tiles
      .filter((t) => t.y0 === envelope.minY || t.y1 === envelope.maxY)
      .find((t) => !standing.some((e) => overlaps(t, e)) && !cutouts.some((e) => overlaps(t, e))
        && !(lastOpening && lastOpening.x0 === t.x0 && lastOpening.y0 === t.y0));
    for (const t of tiles) {
      if (t === opening || cutouts.some((e) => overlaps(t, e))) continue;
      b.place(floorType, transform(vec(t.x0 + FOUNDATION / 2, t.y0 + FOUNDATION / 2, z - SLAB / 2)));
      solid.add(key(z, t));
    }
    if (opening) {
      // A ladder stands with its back 50 cm from the wall (learned from real blueprints); one segment is about 2 m.
      const onRight = opening.y0 === envelope.minY;
      const at = vec((opening.x0 + opening.x1) / 2, onRight ? envelope.minY + 50 : envelope.maxY - 50, below);
      const ladder = b.place(ladderType!, transform(at, onRight ? 90 : -90));
      const props = ladder.entity.properties as any;
      if (props.mNumSegments) props.mNumSegments.value = Math.ceil((z - below) / LADDER_SEGMENT);
      ladders.push(at);
      lastOpening = opening;
    }
  });
  // Floor Holes where lifts and vertical pipes cross a floor (in the middle of the slab, as in real blueprints).
  for (const line of lines) {
    const hole = line.flow.kind === "belt" ? liftHole : pipeHole;
    if (!hole) continue;
    for (const step of line.route.steps) {
      if (step.kind !== "rise") continue;
      const c = grid.center(step.cell);
      const [low, high] = [c.z, c.z + step.levels * LEVEL].sort((a, d) => a - d);
      for (const z of levels) {
        if (z - SLAB / 2 <= low || z - SLAB / 2 >= high || !solid.has(key(z, tileAt(c.x, c.y)))) continue;
        const placed = b.place(hole, transform(vec(c.x, c.y, z - SLAB / 2)));
        const props = placed.entity.properties as any;
        delete props.mBottomSnappedConnection;
        delete props.mTopSnappedConnection;
      }
    }
  }

  // The door goes where the ground cells just inside it are free (no line, machine or ladder in the way).
  const doorway = (at: Vec3, inward: Vec3) => {
    if (ladders.some((l) => l.z === 0 && Math.hypot(l.x - at.x, l.y - at.y) < FOUNDATION)) return false;
    const along = vec(-inward.y, inward.x, 0);
    const cells = [CELL / 2, CELL].flatMap((d) => [-CELL / 2, CELL / 2].map((s) =>
      grid.cellAt(vec(at.x + inward.x * d + along.x * s, at.y + inward.y * d + along.y * s, origin.z))));
    const inside = cells.filter((c) => grid.inside(c));
    return inside.length > 0 && inside.every((c) => grid.isFree(c));
  };
  const shell = buildShell(b, { envelope, floorZ: 0, roofZ, openings: ports.map((p) => ({ at: p.at, kind: p.flow.kind })), doorway, style });
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

  const productName = power ? `${fmt(power.megawatts)} MW ${power.generator.name} plant` : production.target.item.name;
  const netText = power ? ` Plant use ${fmt(production.steps.reduce((s, st) => s + st.power, 0))} MW + pumps.` : "";
  const unit = (f: Flow) => (f.kind === "belt" ? "/min" : " m³/min");
  const carrier = (f: Flow) => `${f.kind} Mk${tierFor(f.kind, f.perMinute)}`;
  const rawFlows = flows.filter((f) => !f.source);
  const exported = flows.filter((f) => f.exported);
  const rawText = rawFlows.map((f) => `${fmt(f.perMinute)}${unit(f)} ${f.label} (${carrier(f)})`).join(", ");
  const outText = exported.map((f) => `${fmt(f.perMinute)}${unit(f)} ${f.label} (${carrier(f)})`).join(", ");
  const half = Math.ceil(Math.max(-envelope.minX, envelope.maxX, -envelope.minY, envelope.maxY) / FOUNDATION) * FOUNDATION;
  const blueprint = b.build(options.name ?? (power ? `Power Plant ${fmt(power.megawatts)} MW` : `Factory ${fmt(options.rate)} ${productName}`), {
    description: (power
      ? `Power plant: ${rows[rows.length - 1].row.options.count}x ${power.generator.name} burning ${fmt(options.rate)} m³/min ${power.fuel.name} = ${fmt(power.megawatts)} MW.${netText} `
      : `Complete factory: ${fmt(options.rate)}/min ${productName} in ${floors.length} floor(s). `)
      + `Inputs at ground level on the back edge, one each: ${rawText}. Outputs at ground level on the front edge: ${outText}. Power: connect any pole.`,
    designerSize: (half * 2) / FOUNDATION,
    yaw: FLOW_TO_FRONT_YAW,
  });

  const pumps = blueprint.objects.filter((o) => /Build_PipelinePump_C$/.test(o.typePath) && "transform" in o).length;
  const report = [
    `${productName}${power ? ` (${fmt(options.rate)} m³/min ${power.fuel.name}.${netText})` : `: ${fmt(options.rate)}/min`} in ${floors.length} floor(s), ${rows.reduce((n, r) => n + r.row.options.count, 0)} machines${pumps ? `, ${pumps} pump(s)` : ""}, building ${fmt((envelope.maxX - envelope.minX) / 100)} x ${fmt((envelope.maxY - envelope.minY) / 100)} x ${fmt(roofZ / 100)} m`,
    ...floors.map((floor, f) => `  floor ${f} (${fmt(floorZ[f] / 100)} m): ` + floor.map((r) => {
      const partial = (r.row.options.clocks ?? []).filter((c) => Math.abs(c - 1) > 1e-6).map((c) => `${fmt(c * 100)}%`);
      return `${r.row.options.count}x ${r.row.spec.key} -> ${rowText(r).replace(/^(.*): (.*)$/, r.row.spec.generator ? "$2" : "$2 $1")}${partial.length ? ` (last at ${partial.join(", ")})` : ""}`;
    }).join(" | ")),
    `  inputs (back edge, ground level): ${rawText}`,
    `  outputs (front edge, ground level): ${outText}`,
    ...flows.filter((f) => f.source && !f.exported && f.sinks.length > 1).map((f) => `  ${f.label} is shared by ${f.sinks.length} rows`),
    ...(rawFlows.some((f) => f.liquid) ? ["  liquid inputs need about 3 m of head lift at the port (an extractor gives 10 m)"] : []),
  ].join("\n");
  return { blueprint, report };
}
