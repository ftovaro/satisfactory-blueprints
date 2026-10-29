import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BlueprintBuilder, ConnectorRef, Placed } from "../builder.js";
import { connector, connectorsOf } from "../connectors.js";
import { Vec3, add, rotate, transform, vec, yaw as yawQuat } from "../geometry.js";
import { MachineSpec, findMachine, findRecipe } from "../data/machines.js";
import { selectLibrary } from "../templates.js";
import type { ConnectorStats } from "../analysis/connectors.js";

/**
 * A row of identical machines with one manifold per input and one per output, powered by a chain
 * of power poles. Solids use splitter/merger manifolds on belts; fluids use pipe manifolds built
 * from Junction Crosses (see src/fluids for the rules they follow). Seen from above, one input:
 *
 *        merger --- merger --- merger ---> output (right end)
 *          |          |          |
 *       [machine] [machine] [machine]          (row runs along +X)
 *          |          |          |
 *  input -> splitter - splitter - splitter
 *
 * When a side has several ports they would cross, so each extra one gets its own manifold stacked
 * 4 m higher. Seen from the side, on the input side:
 *
 *   level 2  splitter --> lift ┐             (belts drop through Conveyor Lifts)
 *   level 1  junction ~~~~~~~~~┤             (pipes curve down; going down needs no head lift)
 *   level 0  junction ---------┴--> [machine]
 *
 * Fluids take the lowest input levels (so whatever feeds them needs the least head lift) and the
 * upper output levels (machines push fluids up to 10 m). Pipe input manifolds feeding 3 or more
 * machines get a loopback pipe, as the wiki recommends.
 *
 * Finally the layout is rotated so inputs enter at the back of the blueprint and products leave at
 * the front, through open belt/pipe ends on the designer boundary that Auto-Connect can use.
 */

export type LineKind = "belt" | "pipe";

export interface PortSpec {
  /** Item or fluid name, for the description. */
  label: string;
  kind: LineKind;
  /** Items (or m³) per minute per machine at its clock; enables per-segment tier sizing. */
  perMachine?: number[];
}

export interface MachineRowOptions {
  machine: string;
  count: number;
  /** Short recipe name from the machine spec, or a full recipe path. */
  recipe?: string;
  /** Clock speed per machine (fraction, 1 = 100%); defaults to 100% for all. */
  clocks?: number[];
  /** Label used in the default name, e.g. "45 Iron Plate". */
  label?: string;
  /** Recipe ingredients and products in recipe order; defaults to the machine's belt connectors. */
  inputs?: PortSpec[];
  outputs?: PortSpec[];
  /** Items/min of belts Mk1..Mk6 and m³/min of pipes Mk1..Mk2, from the game data. */
  speeds?: { belt: number[]; pipe: number[] };
  /** Force one conveyor tier (1-6) everywhere instead of sizing each segment. */
  belt?: number;
  /**
   * End of the row where supplies arrive: "west" (-X, the default; the product leaves at the other
   * end) or "east" (+X, the same end the product leaves from, so all connections share one side).
   */
  inputFrom?: "west" | "east";
  /** Power pole tier 1-2. */
  pole?: number;
  name?: string;
}

/** Length (cm) of the short belts between a machine connector and its splitter/merger. */
const FEEDER_LENGTH = 200;
/** Distance (cm) from a splitter/merger/junction center to its connectors. */
const ATTACHMENT_RADIUS = 100;
/** Belt height above the floor (cm); machine belt connectors sit at this height. */
const BELT_HEIGHT = 100;
/** Vertical distance (cm) between stacked manifolds: one wall. */
const LEVEL_HEIGHT = 400;
/** Distance (cm) from a machine input to the lift that feeds it. */
const LIFT_SETBACK = 300;
/** Distance (cm) from the machine face to stacked manifolds when a side has several ports. */
const STACKED_MANIFOLD_SETBACK = 700;
/** Distance (cm) of the loopback pipe from its manifold, and how far past the row its junctions sit. */
const LOOPBACK_OFFSET = 400;
const LOOPBACK_MIN_MACHINES = 3;
/** Approximate height (cm) where wires attach to a power pole. */
const POLE_HEIGHT = 400;
const FOUNDATION = 800;
/**
 * The row is laid out with the flow running along +X. The blueprint's front (its placement arrow)
 * is -Y, so rotating by -90° makes the products leave toward the arrow.
 */
const FLOW_TO_FRONT_YAW = -90;

const SPLITTER = "Build_ConveyorAttachmentSplitter_C";
const MERGER = "Build_ConveyorAttachmentMerger_C";
const JUNCTION = "Build_PipelineJunction_Cross_C";
export const beltType = (tier: number) => `Build_ConveyorBeltMk${tier}_C`;
export const liftType = (tier: number) => `Build_ConveyorLiftMk${tier}_C`;
export const pipeType = (tier: number) => (tier === 1 ? "Build_Pipeline_C" : "Build_PipelineMK2_C");

/**
 * Tiers of one manifold line.
 *
 * In steady state, an input line between attachment i and i+1 only carries what machines i+1..n
 * consume, and an output line after attachment i carries what machines 0..i produced. Segments get
 * slower tiers toward the far end of an input line and faster ones toward the exit of an output line.
 */
export interface LineTiers {
  feeders: number[];
  /** chain[i] is the segment between attachment i and attachment i+1. */
  chain: number[];
  /** Tier of the belt/pipe entering (input line) or leaving (output line) the row. */
  end: number;
}

export function planLine(count: number, side: "input" | "output", port: PortSpec, options: Pick<MachineRowOptions, "belt" | "speeds">): LineTiers {
  const speeds = options.speeds?.[port.kind];
  const fixedTier = port.kind === "belt" ? options.belt : undefined;
  if (fixedTier !== undefined || !port.perMachine || !speeds) {
    const tier = fixedTier ?? 1;
    return { feeders: new Array(count).fill(tier), chain: new Array(Math.max(0, count - 1)).fill(tier), end: tier };
  }
  const tier = (flow: number) => {
    const index = speeds.findIndex((s) => s + 1e-9 >= flow);
    if (index < 0) throw new Error(`${port.label}: ${flow.toFixed(2)}/min is more than the fastest ${port.kind} carries; split the row.`);
    return index + 1;
  };
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const flows = port.perMachine;
  return {
    feeders: flows.map(tier),
    chain: flows.slice(1).map((_, i) => tier(side === "input" ? sum(flows.slice(i + 1)) : sum(flows.slice(0, i + 1)))),
    end: tier(sum(flows)),
  };
}

/** A port matched to the machine connector that serves it, with its stacking level. */
interface Line {
  port: PortSpec;
  connector: ConnectorStats;
  /** Connector offset in the layout frame (machine possibly turned 180°). */
  offset: Vec3;
  level: number;
  tiers: LineTiers;
}

/** Everything decided about a row before anything is placed. */
export interface PreparedRow {
  spec: MachineSpec;
  options: MachineRowOptions;
  inputLines: Line[];
  outputLines: Line[];
  /** 180 when the machine's inputs are on its +Y face and it must be turned. */
  machineYaw: number;
  /** Building types the row places (for picking a template library). */
  required: Set<string>;
  /** Highest point of the row's machines and manifolds above its floor (cm). */
  height: number;
  /** Footprint in the row's own coordinates (cm), machines and manifolds included. */
  extent: { minX: number; maxX: number; minY: number; maxY: number };
}

export function prepareRow(options: MachineRowOptions): PreparedRow {
  const spec = findMachine(options.machine);
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("count must be a positive integer.");
  const all = connectorsOf(spec.type);
  const connectorsFor = (side: "input" | "output", kind: LineKind) =>
    all.filter((c) => c.kind === kind && (side === "input" ? /input/i : /output/i).test(c.name));

  const inputPorts = options.inputs ?? connectorsFor("input", "belt").map((c, i) => ({ label: `input ${i + 1}`, kind: "belt" as const }));
  const outputPorts = options.outputs ?? connectorsFor("output", "belt").slice(0, 1).map(() => ({ label: "output", kind: "belt" as const }));
  if (inputPorts.length === 0 || outputPorts.length === 0) throw new Error(`${spec.key} needs at least one input and one output.`);

  // Machines take any ingredient on any connector of the right kind, so assign them in order.
  const assign = (side: "input" | "output", ports: PortSpec[]) => {
    const used = new Map<LineKind, number>();
    return ports.map((port) => {
      const index = used.get(port.kind) ?? 0;
      used.set(port.kind, index + 1);
      const candidates = connectorsFor(side, port.kind);
      if (!candidates[index]) {
        throw new Error(`No learned ${port.kind} ${side} connector #${index + 1} for ${spec.key} (${port.label}). Add a blueprint using this machine that way and run "sbp learn".`);
      }
      return { port, connector: candidates[index] };
    });
  };
  const inputs = assign("input", inputPorts);
  const outputs = assign("output", outputPorts);

  // The layout expects inputs on the machine's -Y face; turn machines that have them on +Y.
  const turned = inputs[0].connector.normal.y > 0;
  const local = (c: ConnectorStats): Vec3 => (turned ? vec(-c.offset.x, -c.offset.y, c.offset.z) : c.offset);

  // Fluids get the lowest input levels and the highest output levels.
  const order = (side: "input" | "output") => (a: { port: PortSpec }, b: { port: PortSpec }) => {
    const rank = (p: PortSpec) => (side === "input" ? (p.kind === "pipe" ? 0 : 1) : p.kind === "belt" ? 0 : 1);
    return rank(a.port) - rank(b.port);
  };
  // Input lines fed from the east carry their flow westward, so size them on the reversed machine order.
  const fromEast = options.inputFrom === "east";
  const tiersFor = (side: "input" | "output", port: PortSpec): LineTiers => {
    if (side === "output" || !fromEast || !port.perMachine) return planLine(options.count, side, port, options);
    const t = planLine(options.count, side, { ...port, perMachine: [...port.perMachine].reverse() }, options);
    return { feeders: [...t.feeders].reverse(), chain: [...t.chain].reverse(), end: t.end };
  };
  const toLines = (side: "input" | "output", list: { port: PortSpec; connector: ConnectorStats }[]): Line[] =>
    [...list].sort(order(side)).map((l, level) => ({ ...l, offset: local(l.connector), level, tiers: tiersFor(side, l.port) }));
  const inputLines = toLines("input", inputs);
  const outputLines = toLines("output", outputs);
  if (outputLines.some((l) => l.port.kind === "belt" && l.level > 0)) throw new Error(`${spec.key}: more than one belt output is not supported.`);

  const poleType = `Build_PowerPoleMk${options.pole ?? 1}_C`;
  const lines = [...inputLines, ...outputLines];
  const typesOf = (kind: LineKind, pick: (t: LineTiers) => number[]) =>
    lines.filter((l) => l.port.kind === kind).flatMap((l) => pick(l.tiers));
  const allTiers = (t: LineTiers) => [...t.feeders, ...t.chain, t.end];
  const required = new Set<string>([spec.type, poleType, "Build_PowerLine_C"]);
  typesOf("belt", allTiers).forEach((t) => required.add(beltType(t)));
  typesOf("pipe", allTiers).forEach((t) => required.add(pipeType(t)));
  inputLines.filter((l) => l.port.kind === "belt" && l.level > 0).forEach((l) => l.tiers.feeders.forEach((t) => required.add(liftType(t))));
  if (lines.some((l) => l.port.kind === "pipe")) required.add(JUNCTION);
  if (inputLines.some((l) => l.port.kind === "belt")) required.add(SPLITTER);
  if (outputLines.some((l) => l.port.kind === "belt")) required.add(MERGER);

  const rowLength = (options.count - 1) * spec.pitch;
  const levels = Math.max(inputLines.length, outputLines.length) - 1;
  const inFace = inputLines[0].offset.y;
  const outFace = outputLines[0].offset.y;
  const inLineY = inFace - (inputLines.length > 1 ? STACKED_MANIFOLD_SETBACK : FEEDER_LENGTH + ATTACHMENT_RADIUS);
  const outLineY = outFace + (outputLines.length > 1 ? STACKED_MANIFOLD_SETBACK : FEEDER_LENGTH + ATTACHMENT_RADIUS);
  const loopback = inputLines.some((l) => l.port.kind === "pipe") && options.count >= LOOPBACK_MIN_MACHINES ? LOOPBACK_OFFSET : 0;
  return {
    spec, options, inputLines, outputLines, required,
    machineYaw: turned ? 180 : 0,
    height: Math.max(spec.height, BELT_HEIGHT + levels * LEVEL_HEIGHT + 200),
    extent: {
      minX: -rowLength / 2 - spec.pitch / 2 - loopback,
      maxX: rowLength / 2 + spec.pitch / 2 + loopback,
      minY: inLineY - ATTACHMENT_RADIUS - loopback,
      maxY: outLineY + ATTACHMENT_RADIUS,
    },
  };
}

/** What a built row exposes: where its lines meet the outside, and its power poles. */
export interface BuiltRow {
  /** Input ports are where supply must arrive (moving +X); output ports where products leave (moving +X). */
  ports: (Port & { label: string; level: number; spec: PortSpec })[];
  poles: { pole: Placed; position: Vec3 }[];
}

/** Places a prepared row in the builder's current frame: machines along X at y = 0 on z = 0. */
export function buildRow(b: BlueprintBuilder, row: PreparedRow): BuiltRow {
  const { spec, options, inputLines, outputLines } = row;
  const rowLength = (options.count - 1) * spec.pitch;
  const xOf = (i: number) => i * spec.pitch - rowLength / 2;

  const machines: Placed[] = [];
  for (let i = 0; i < options.count; i++) {
    const machine = b.place(spec.type, transform(vec(xOf(i), 0, 0), row.machineYaw));
    if (options.recipe) b.setRecipe(machine, findRecipe(spec, options.recipe));
    const clock = options.clocks?.[i] ?? 1;
    if (Math.abs(clock - 1) > 1e-6) b.setClock(machine, clock);
    machines.push(machine);
  }

  const ctx: RowContext = {
    b, machines, xOf,
    inFace: inputLines[0].offset.y,
    outFace: outputLines[0].offset.y,
    inStacked: inputLines.length > 1,
    outStacked: outputLines.length > 1,
    fromEast: options.inputFrom === "east",
  };
  const tag = (line: Line, port: Port) => ({ ...port, label: line.port.label, level: line.level, spec: line.port });
  const ports = [
    ...inputLines.map((l) => tag(l, l.port.kind === "belt" ? beltInputLine(ctx, l) : pipeInputLine(ctx, l))),
    ...outputLines.map((l) => tag(l, l.port.kind === "belt" ? beltOutputLine(ctx, l) : pipeOutputLine(ctx, l))),
  ];

  // Power: one pole in the gap between each pair of machines, powering both of them, chained to the
  // next pole (4 connections at most, which a Mk1 pole supports). An odd last machine gets its pole on the right.
  const poleType = `Build_PowerPoleMk${options.pole ?? 1}_C`;
  const poles: BuiltRow["poles"] = [];
  for (let i = 0; i < machines.length; i += 2) {
    const pair = machines.slice(i, i + 2);
    const position = vec(xOf(i) + spec.pitch / 2, 0, 0);
    const pole = b.place(poleType, transform(position));
    const top = add(position, vec(0, 0, POLE_HEIGHT));
    for (const machine of pair) {
      b.wire({ building: pole, name: b.powerConnector(pole), position: top }, { building: machine, name: b.powerConnector(machine), position: b.worldPoint(machine, vec(0, 0, 200)) });
    }
    const previous = poles[poles.length - 1];
    if (previous) b.wire({ building: previous.pole, name: b.powerConnector(previous.pole), position: previous.position }, { building: pole, name: b.powerConnector(pole), position: top });
    poles.push({ pole, position: top });
  }
  return { ports, poles };
}

/** Building types needed by a set of prepared rows plus extra ones, as one template library. */
export function libraryFor(rows: PreparedRow[], extra: string[] = []) {
  return selectLibrary([...new Set([...rows.flatMap((r) => [...r.required]), ...extra])]);
}

export function generateMachineRow(options: MachineRowOptions): Blueprint {
  const row = prepareRow(options);
  const b = new BlueprintBuilder(libraryFor([row]));
  const { ports } = buildRow(b, row);
  const { spec, inputLines, outputLines } = row;

  // Ports: open belt/pipe ends on the designer boundary so Auto-Connect (R while placing) can link
  // them to other blueprints, as hand-made blueprints do. Inputs come in at -X, outputs leave at +X.
  const designerSize = b.requiredDesignerSize();
  const half = (designerSize * FOUNDATION) / 2;
  for (const port of ports) openPort(b, port, port.side === "input" ? -half : half);

  const recipeLabel = options.label ? ` ${options.label}` : options.recipe && !options.recipe.startsWith("/") ? ` ${options.recipe}` : "";
  const name = options.name ?? `${options.count}x ${capitalize(spec.key)}${recipeLabel}`;
  const describe = (l: Line) => {
    const height = l.level === 0 ? "ground level" : `+${(l.level * LEVEL_HEIGHT) / 100} m`;
    return `${l.port.label} at ${height} (${l.port.kind} Mk${l.tiers.end})`;
  };
  // Rotate so the flow runs along the blueprint's forward arrow: inputs at the back, products out the front.
  return b.build(name, {
    description: `${options.count} ${spec.key}(s)${recipeLabel}. Inputs enter at the back: ${inputLines.map(describe).join(", ")}. `
      + `Products leave at the front, in the direction of the placement arrow: ${outputLines.map(describe).join(", ")}. Use Auto-Connect (R) to link it to neighboring blueprints.`,
    designerSize,
    yaw: FLOW_TO_FRONT_YAW,
  });
}

/** Extends a row port straight along X to `edgeX`, ending in an open belt/pipe end. */
export function openPort(b: BlueprintBuilder, port: Port, edgeX: number): void {
  const edge = vec(edgeX, port.point.position.y, port.point.position.z);
  if (port.kind === "belt") {
    if (port.side === "input") b.belt(beltType(port.tier), { position: edge }, port.point);
    else b.belt(beltType(port.tier), port.point, { position: edge });
  } else if (port.side === "input") {
    b.pipe(pipeType(port.tier), { position: edge }, port.point, vec(1, 0, 0));
  } else {
    b.pipe(pipeType(port.tier), port.point, { position: edge }, vec(1, 0, 0));
  }
}

interface RowContext {
  b: BlueprintBuilder;
  machines: Placed[];
  xOf: (i: number) => number;
  /** Y of the machines' input and output faces in the layout frame. */
  inFace: number;
  outFace: number;
  inStacked: boolean;
  outStacked: boolean;
  /** Input lines are fed from the east end and carry their flow westward. */
  fromEast: boolean;
}

/** Where a line meets the outside world: the free end of its first (input) or last (output) attachment. */
export interface Port {
  side: "input" | "output";
  kind: LineKind;
  tier: number;
  point: ConnectorRef & { position: Vec3 };
}

const inputLineY = (ctx: RowContext) => ctx.inFace - (ctx.inStacked ? STACKED_MANIFOLD_SETBACK : FEEDER_LENGTH + ATTACHMENT_RADIUS);
const outputLineY = (ctx: RowContext) => ctx.outFace + (ctx.outStacked ? STACKED_MANIFOLD_SETBACK : FEEDER_LENGTH + ATTACHMENT_RADIUS);

/** Splitter manifold; level 0 is on the ground, higher levels drop into the machines through lifts. */
function beltInputLine(ctx: RowContext, line: Line): Port {
  const { b, machines, xOf } = ctx;
  const { tiers, offset } = line;
  const lineY = inputLineY(ctx);
  const lineZ = BELT_HEIGHT + line.level * LEVEL_HEIGHT;

  // Fed from the east, splitters are turned 180°: their machine-facing side output is then Output3.
  const yaw = ctx.fromEast ? 180 : 0;
  const at = (center: Vec3, name: string) => attachmentPoint(SPLITTER, center, name, yaw);
  const side = ctx.fromEast ? "Output3" : "Output2";
  const splitters = machines.map((machine, i) => {
    const center = vec(xOf(i) + offset.x, lineY, lineZ);
    const splitter = b.place(SPLITTER, transform(center, yaw));
    const sideOutput = { building: splitter, name: side, position: at(center, side) };
    const machineInput = { building: machine, name: line.connector.name, position: b.worldPoint(machine, line.connector.offset) };
    if (line.level === 0) {
      b.belt(beltType(tiers.feeders[i]), sideOutput, machineInput);
    } else {
      // Splitter -> lift top, lift drops the items to belt height, short belt into the machine.
      const top = vec(machineInput.position.x, machineInput.position.y - LIFT_SETBACK, lineZ);
      const { lift, output } = b.liftDown(liftType(tiers.feeders[i]), top, lineZ - BELT_HEIGHT, 90);
      b.belt(beltType(tiers.feeders[i]), sideOutput, { building: lift, name: "ConveyorAny0", position: top });
      b.belt(beltType(tiers.feeders[i]), { building: lift, name: "ConveyorAny1", position: output }, machineInput);
    }
    return { splitter, center };
  });
  for (let i = 1; i < splitters.length; i++) {
    // Items move from "upstream" to "downstream": west to east by default, east to west when fed from the east.
    const [up, down] = ctx.fromEast ? [splitters[i], splitters[i - 1]] : [splitters[i - 1], splitters[i]];
    b.belt(beltType(tiers.chain[i - 1]),
      { building: up.splitter, name: "Output1", position: at(up.center, "Output1") },
      { building: down.splitter, name: "Input1", position: at(down.center, "Input1") });
  }
  const first = ctx.fromEast ? splitters[splitters.length - 1] : splitters[0];
  return { side: "input", kind: "belt", tier: tiers.end, point: { building: first.splitter, name: "Input1", position: at(first.center, "Input1") } };
}

/** Merger manifold on the ground collecting from the machines' output face. */
function beltOutputLine(ctx: RowContext, line: Line): Port {
  const { b, machines, xOf } = ctx;
  const { tiers, offset } = line;
  const lineY = outputLineY(ctx);
  const sideInput = connector(MERGER, "Input3"); // faces -Y, toward the machines
  const mergers = machines.map((machine, i) => {
    const center = vec(xOf(i) + offset.x, lineY, BELT_HEIGHT);
    const merger = b.place(MERGER, transform(center));
    b.belt(beltType(tiers.feeders[i]),
      { building: machine, name: line.connector.name, position: b.worldPoint(machine, line.connector.offset) },
      { building: merger, name: sideInput.name, position: add(center, sideInput.offset) });
    return { merger, center };
  });
  for (let i = 1; i < mergers.length; i++) {
    const prev = mergers[i - 1];
    const next = mergers[i];
    b.belt(beltType(tiers.chain[i - 1]),
      { building: prev.merger, name: "Output1", position: attachmentPoint(MERGER, prev.center, "Output1") },
      { building: next.merger, name: "Input1", position: attachmentPoint(MERGER, next.center, "Input1") });
  }
  const last = mergers[mergers.length - 1];
  return { side: "output", kind: "belt", tier: tiers.end, point: { building: last.merger, name: "Output1", position: attachmentPoint(MERGER, last.center, "Output1") } };
}

/** Junction Cross connectors: 0 at -X, 1 at +X, 2 at +Y, 3 at -Y (learned from real blueprints). */
const junctionPoint = (center: Vec3, name: "Connection0" | "Connection1" | "Connection2" | "Connection3") => attachmentPoint(JUNCTION, center, name);

/**
 * Pipe manifold feeding the machines: Junction Crosses in series, each sending fluid toward its
 * machine. Upper levels reach the machine through an S-curved pipe (fluid flows down freely). With
 * 3 or more machines a loopback pipe joins the feed to the far end so flow does not drop there.
 */
function pipeInputLine(ctx: RowContext, line: Line): Port {
  const { b, machines, xOf } = ctx;
  const { tiers, offset } = line;
  const lineY = inputLineY(ctx);
  const lineZ = line.connector.offset.z + line.level * LEVEL_HEIGHT;
  const along = vec(1, 0, 0);

  const junctions = machines.map((machine, i) => {
    const center = vec(xOf(i) + offset.x, lineY, lineZ);
    const junction = b.place(JUNCTION, transform(center));
    b.pipe(pipeType(tiers.feeders[i]),
      { building: junction, name: "Connection2", position: junctionPoint(center, "Connection2") },
      { building: machine, name: line.connector.name, position: b.worldPoint(machine, line.connector.offset) },
      vec(0, 1, 0));
    return { junction, center };
  });
  // Fluid enters at the upstream end (west by default, east when fed from the east) and spreads
  // downstream: each junction passes it on through its downstream side.
  type J = { junction: Placed; center: Vec3 };
  type Side = "Connection0" | "Connection1";
  const upSide: Side = ctx.fromEast ? "Connection1" : "Connection0";
  const downSide: Side = ctx.fromEast ? "Connection0" : "Connection1";
  const downstream = ctx.fromEast ? vec(-1, 0, 0) : along;
  const ordered = ctx.fromEast ? [...junctions].reverse() : junctions;
  const segmentTier = (i: number) => tiers.chain[ctx.fromEast ? junctions.length - 2 - i : i];
  const chain = (from: J, to: J, tier: number) =>
    b.pipe(pipeType(tier),
      { building: from.junction, name: downSide, position: junctionPoint(from.center, downSide) },
      { building: to.junction, name: upSide, position: junctionPoint(to.center, upSide) }, downstream);
  for (let i = 1; i < ordered.length; i++) chain(ordered[i - 1], ordered[i], segmentTier(i - 1));

  let entry = ordered[0];
  if (machines.length >= LOOPBACK_MIN_MACHINES) {
    // feed -> start junction -> manifold -> end junction, plus start -> corner -> corner -> end outside the row.
    const place = (center: Vec3) => ({ junction: b.place(JUNCTION, transform(center)), center });
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const start = place(vec(first.center.x - downstream.x * LOOPBACK_OFFSET, lineY, lineZ));
    const end = place(vec(last.center.x + downstream.x * LOOPBACK_OFFSET, lineY, lineZ));
    const cornerA = place(vec(start.center.x, lineY - LOOPBACK_OFFSET, lineZ));
    const cornerB = place(vec(end.center.x, lineY - LOOPBACK_OFFSET, lineZ));
    chain(start, first, tiers.end);
    chain(last, end, tiers.feeders[ctx.fromEast ? 0 : tiers.feeders.length - 1]);
    const link = (a: J, aName: string, z: J, zName: string, dir: Vec3) =>
      b.pipe(pipeType(tiers.end), { building: a.junction, name: aName, position: junctionPoint(a.center, aName as any) }, { building: z.junction, name: zName, position: junctionPoint(z.center, zName as any) }, dir);
    link(start, "Connection3", cornerA, "Connection2", vec(0, -1, 0));
    link(cornerA, downSide, cornerB, upSide, downstream);
    link(cornerB, "Connection2", end, "Connection3", vec(0, 1, 0));
    entry = start;
  }
  return { side: "input", kind: "pipe", tier: tiers.end, point: { building: entry.junction, name: upSide, position: junctionPoint(entry.center, upSide) } };
}

/** Pipe manifold collecting from the machines; upper levels rise from the machine (machines push 10 m of head lift). */
function pipeOutputLine(ctx: RowContext, line: Line): Port {
  const { b, machines, xOf } = ctx;
  const { tiers, offset } = line;
  const lineY = outputLineY(ctx);
  const lineZ = line.connector.offset.z + line.level * LEVEL_HEIGHT;
  const junctions = machines.map((machine, i) => {
    const center = vec(xOf(i) + offset.x, lineY, lineZ);
    const junction = b.place(JUNCTION, transform(center));
    b.pipe(pipeType(tiers.feeders[i]),
      { building: machine, name: line.connector.name, position: b.worldPoint(machine, line.connector.offset) },
      { building: junction, name: "Connection3", position: junctionPoint(center, "Connection3") },
      vec(0, 1, 0));
    return { junction, center };
  });
  for (let i = 1; i < junctions.length; i++) {
    const prev = junctions[i - 1];
    const next = junctions[i];
    b.pipe(pipeType(tiers.chain[i - 1]),
      { building: prev.junction, name: "Connection1", position: junctionPoint(prev.center, "Connection1") },
      { building: next.junction, name: "Connection0", position: junctionPoint(next.center, "Connection0") }, vec(1, 0, 0));
  }
  const last = junctions[junctions.length - 1];
  return { side: "output", kind: "pipe", tier: tiers.end, point: { building: last.junction, name: "Connection1", position: junctionPoint(last.center, "Connection1") } };
}

/** Connector position of a splitter/merger/junction placed at `center`, optionally turned by `yaw` degrees. */
export function attachmentPoint(type: string, center: Vec3, name: string, yaw = 0): Vec3 {
  return add(center, rotate(yawQuat(yaw), connector(type, name).offset));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
