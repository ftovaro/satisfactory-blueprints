import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BlueprintBuilder, Placed } from "../builder.js";
import { connector, connectorsOf } from "../connectors.js";
import { Vec3, add, transform, vec } from "../geometry.js";
import { findMachine, findRecipe } from "../data/machines.js";
import { selectLibrary } from "../templates.js";
import type { ConnectorStats } from "../analysis/connectors.js";

/**
 * A row of identical machines with one splitter manifold per input and a merger manifold collecting
 * the output, powered by a chain of power poles. Seen from above (one input):
 *
 *        merger --- merger --- merger ---> output (right end)
 *          |          |          |
 *       [machine] [machine] [machine]          (row runs along +X)
 *          |          |          |
 *  input -> splitter - splitter - splitter
 *
 * Machines with several inputs (Assembler, Foundry, Manufacturer) have them all on the same face, so
 * flat manifolds would cross. Extra inputs get their own manifold stacked 4 m higher per level, and
 * each splitter drops its items into the machine through a Conveyor Lift. Seen from the side:
 *
 *   level 2  splitter --> lift ┐
 *   level 1  splitter --> lift ┤
 *   level 0  splitter ---------┴--> [machine]
 *
 * Every input line starts at the left end; the output leaves the right end of the merger line.
 */

export interface MachineRowOptions {
  machine: string;
  count: number;
  /** Short recipe name from the machine spec, or a full recipe path. */
  recipe?: string;
  /** Clock speed per machine (fraction, 1 = 100%); defaults to 100% for all. */
  clocks?: number[];
  /** Label used in the default name, e.g. "45 Iron Plate". */
  label?: string;
  /** Number of input connectors to feed (the recipe's ingredient count); defaults to all. */
  inputCount?: number;
  /** Item name per input connector (in machine connector order), shown in the description. */
  inputLabels?: string[];
  /** Force one conveyor tier (1-6) everywhere instead of sizing each segment. */
  belt?: number;
  /** Items/min each machine consumes per input connector (outer index) and produces; enables per-segment belt sizing. */
  inputPerMachine?: number[][];
  outputPerMachine?: number[];
  /** Items/min of belt Mk1..Mk6, from the game data. */
  beltSpeeds?: number[];
  /** Power pole tier 1-2. */
  pole?: number;
  name?: string;
}

/** Length (cm) of the short belts between a machine connector and its splitter/merger. */
const FEEDER_LENGTH = 200;
/** Distance (cm) from a splitter/merger center to its belt connectors. */
const ATTACHMENT_RADIUS = 100;
/** Belt height above the floor (cm); machine connectors sit at this height. */
const BELT_HEIGHT = 100;
/** Vertical distance (cm) between stacked input manifolds: one wall. */
const LEVEL_HEIGHT = 400;
/** Distance (cm) from a machine input to the lift that feeds it. */
const LIFT_SETBACK = 300;
/** Distance (cm) from a machine input to the stacked manifolds when there are several inputs. */
const STACKED_MANIFOLD_SETBACK = 700;
/** Approximate height (cm) where wires attach to a power pole. */
const POLE_HEIGHT = 400;

/**
 * Belt tiers of one manifold line.
 *
 * In steady state, a splitter line between splitter i and i+1 only carries what machines i+1..n
 * consume, and a merger line after merger i carries what machines 0..i produced. Segments get
 * slower belts toward the far end of an input line and faster ones toward the exit of the output line.
 */
export interface LineBelts {
  feeders: number[];
  /** chain[i] is the segment between attachment i and attachment i+1. */
  chain: number[];
  /** Tier of the belt entering (input line) or leaving (output line) the row. */
  end: number;
}

export interface BeltPlan {
  inputs: LineBelts[];
  output: LineBelts;
}

export function planBelts(
  count: number,
  inputCount: number,
  options: Pick<MachineRowOptions, "belt" | "inputPerMachine" | "outputPerMachine" | "beltSpeeds">,
): BeltPlan {
  const { inputPerMachine: ins, outputPerMachine: outs, beltSpeeds: speeds } = options;
  if (options.belt !== undefined || !ins || !outs || !speeds) {
    const tier = options.belt ?? 1;
    const fixed = (): LineBelts => ({ feeders: new Array(count).fill(tier), chain: new Array(Math.max(0, count - 1)).fill(tier), end: tier });
    return { inputs: Array.from({ length: inputCount }, fixed), output: fixed() };
  }
  const tier = (flow: number) => {
    const index = speeds.findIndex((s) => s + 1e-9 >= flow);
    if (index < 0) throw new Error(`${flow.toFixed(2)}/min is more than the fastest belt carries; split the row.`);
    return index + 1;
  };
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const splitLine = (perMachine: number[]): LineBelts => ({
    feeders: perMachine.map(tier),
    chain: perMachine.slice(1).map((_, i) => tier(sum(perMachine.slice(i + 1)))),
    end: tier(sum(perMachine)),
  });
  return {
    inputs: ins.map(splitLine),
    output: {
      feeders: outs.map(tier),
      chain: outs.slice(1).map((_, i) => tier(sum(outs.slice(0, i + 1)))),
      end: tier(sum(outs)),
    },
  };
}

export function generateMachineRow(options: MachineRowOptions): Blueprint {
  const spec = findMachine(options.machine);
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("count must be a positive integer.");

  // Machines accept any ingredient on any input, so a recipe with fewer ingredients uses the first connectors only.
  const inputs = connectorsOf(spec.type).filter((c) => c.kind === "belt" && /^input/i.test(c.name)).slice(0, options.inputCount);
  const outputs = connectorsOf(spec.type).filter((c) => c.kind === "belt" && /^output/i.test(c.name));
  if (inputs.length < 1 || outputs.length !== 1) {
    throw new Error(`${spec.key} has ${inputs.length} belt inputs and ${outputs.length} belt outputs; rows need at least one input and exactly one output.`);
  }
  if (connectorsOf(spec.type).some((c) => c.kind === "pipe")) throw new Error(`${spec.key} uses pipes; fluid machines are handled by the fluids module.`);
  const output = outputs[0];
  const stacked = inputs.length > 1;

  const belts = planBelts(options.count, inputs.length, options);
  const beltType = (tier: number) => `Build_ConveyorBeltMk${tier}_C`;
  const liftType = (tier: number) => `Build_ConveyorLiftMk${tier}_C`;
  const allTiers = [...belts.inputs.flatMap((l) => [...l.feeders, ...l.chain]), ...belts.output.feeders, ...belts.output.chain];
  const liftTiers = stacked ? belts.inputs.slice(1).flatMap((l) => l.feeders) : [];
  const splitterType = "Build_ConveyorAttachmentSplitter_C";
  const mergerType = "Build_ConveyorAttachmentMerger_C";
  const poleType = `Build_PowerPoleMk${options.pole ?? 1}_C`;
  const b = new BlueprintBuilder(selectLibrary([
    spec.type, splitterType, mergerType, poleType, "Build_PowerLine_C",
    ...new Set(allTiers.map(beltType)), ...new Set(liftTiers.map(liftType)),
  ]));

  const rowLength = (options.count - 1) * spec.pitch;
  const xOf = (i: number) => i * spec.pitch - rowLength / 2;

  // Machines face +Y: inputs on the -Y side, outputs on the +Y side (that is how the game models them).
  const machines: Placed[] = [];
  for (let i = 0; i < options.count; i++) {
    const machine = b.place(spec.type, transform(vec(xOf(i), 0, 0)));
    if (options.recipe) b.setRecipe(machine, findRecipe(spec, options.recipe));
    const clock = options.clocks?.[i] ?? 1;
    if (Math.abs(clock - 1) > 1e-6) b.setClock(machine, clock);
    machines.push(machine);
  }

  inputs.forEach((input, level) => buildInputLine(b, machines, input, level, stacked, belts.inputs[level], xOf, { beltType, liftType, splitterType }));

  // Merger line: each merger collects from the machine behind it through its -Y side input.
  const mergerY = output.offset.y + FEEDER_LENGTH + ATTACHMENT_RADIUS;
  const mergerSideInput = connector(mergerType, "Input3");
  const mergers = machines.map((machine, i) => {
    const center = vec(xOf(i) + output.offset.x, mergerY, BELT_HEIGHT);
    const merger = b.place(mergerType, transform(center));
    b.belt(beltType(belts.output.feeders[i]),
      { building: machine, name: output.name, position: b.worldPoint(machine, output.offset) },
      { building: merger, name: mergerSideInput.name, position: add(center, mergerSideInput.offset) });
    return { merger, center };
  });
  for (let i = 1; i < mergers.length; i++) {
    const prev = mergers[i - 1];
    const next = mergers[i];
    b.belt(beltType(belts.output.chain[i - 1]),
      { building: prev.merger, name: "Output1", position: attachmentPoint(mergerType, prev.center, "Output1") },
      { building: next.merger, name: "Input1", position: attachmentPoint(mergerType, next.center, "Input1") });
  }

  // Power: one pole in the gap between each pair of machines, powering both of them, chained to the
  // next pole (4 connections at most, which a Mk1 pole supports). An odd last machine gets its pole on the right.
  let previousTop: { pole: Placed; position: Vec3 } | undefined;
  for (let i = 0; i < machines.length; i += 2) {
    const pair = machines.slice(i, i + 2);
    const position = vec(xOf(i) + spec.pitch / 2, 0, 0);
    const pole = b.place(poleType, transform(position));
    const top = add(position, vec(0, 0, POLE_HEIGHT));
    for (const machine of pair) {
      b.wire({ building: pole, name: b.powerConnector(pole), position: top }, { building: machine, name: b.powerConnector(machine), position: b.worldPoint(machine, vec(0, 0, 200)) });
    }
    if (previousTop) b.wire({ building: previousTop.pole, name: b.powerConnector(previousTop.pole), position: previousTop.position }, { building: pole, name: b.powerConnector(pole), position: top });
    previousTop = { pole, position: top };
  }

  const recipeLabel = options.label ? ` ${options.label}` : options.recipe && !options.recipe.startsWith("/") ? ` ${options.recipe}` : "";
  const name = options.name ?? `${options.count}x ${capitalize(spec.key)}${recipeLabel}`;
  const inputText = inputs
    .map((_, level) => `${options.inputLabels?.[level] ?? `input ${level + 1}`} at ${level === 0 ? "ground level" : `+${(level * LEVEL_HEIGHT) / 100} m`} (belt Mk${belts.inputs[level].end})`)
    .join(", ");
  return b.build(name, {
    description: `${options.count} ${spec.key}(s)${recipeLabel}. Inputs enter at the left end: ${inputText}. Output leaves the right end of the merger line (belt Mk${belts.output.end}).`,
  });
}

interface LineTypes {
  beltType: (tier: number) => string;
  liftType: (tier: number) => string;
  splitterType: string;
}

/** Builds the splitter manifold for one machine input; level 0 is on the ground, higher levels drop through lifts. */
function buildInputLine(
  b: BlueprintBuilder,
  machines: Placed[],
  input: ConnectorStats,
  level: number,
  stacked: boolean,
  belts: LineBelts,
  xOf: (i: number) => number,
  types: LineTypes,
): void {
  const { beltType, liftType, splitterType } = types;
  const lineY = stacked ? input.offset.y - STACKED_MANIFOLD_SETBACK : input.offset.y - FEEDER_LENGTH - ATTACHMENT_RADIUS;
  const lineZ = BELT_HEIGHT + level * LEVEL_HEIGHT;

  const splitters = machines.map((machine, i) => {
    const center = vec(xOf(i) + input.offset.x, lineY, lineZ);
    const splitter = b.place(splitterType, transform(center));
    const sideOutput = { building: splitter, name: "Output2", position: attachmentPoint(splitterType, center, "Output2") };
    const machineInput = { building: machine, name: input.name, position: b.worldPoint(machine, input.offset) };
    if (level === 0) {
      b.belt(beltType(belts.feeders[i]), sideOutput, machineInput);
    } else {
      // Splitter -> lift top, lift drops the items to belt height, short belt into the machine.
      const top = vec(machineInput.position.x, machineInput.position.y - LIFT_SETBACK, lineZ);
      const { lift, output } = b.liftDown(liftType(belts.feeders[i]), top, lineZ - BELT_HEIGHT, 90);
      b.belt(beltType(belts.feeders[i]), sideOutput, { building: lift, name: "ConveyorAny0", position: top });
      b.belt(beltType(belts.feeders[i]), { building: lift, name: "ConveyorAny1", position: output }, machineInput);
    }
    return { splitter, center };
  });
  for (let i = 1; i < splitters.length; i++) {
    const prev = splitters[i - 1];
    const next = splitters[i];
    b.belt(beltType(belts.chain[i - 1]),
      { building: prev.splitter, name: "Output1", position: attachmentPoint(splitterType, prev.center, "Output1") },
      { building: next.splitter, name: "Input1", position: attachmentPoint(splitterType, next.center, "Input1") });
  }
}

function attachmentPoint(type: string, center: Vec3, name: string): Vec3 {
  return add(center, connector(type, name).offset);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
