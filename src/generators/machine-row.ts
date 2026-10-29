import { Blueprint } from "@etothepii/satisfactory-file-parser";
import { BlueprintBuilder, Placed } from "../builder.js";
import { connector, connectorsOf } from "../connectors.js";
import { Vec3, add, transform, vec } from "../geometry.js";
import { findMachine, findRecipe } from "../data/machines.js";
import { selectLibrary } from "../templates.js";

/**
 * A row of identical machines with a splitter manifold feeding the inputs and a merger manifold
 * collecting the outputs, all powered by a chain of power poles.
 *
 *        merger --- merger --- merger ---> output (right end)
 *          |          |          |
 *       [machine] [machine] [machine]          (row runs along +X)
 *          |          |          |
 *  input -> splitter - splitter - splitter
 *
 * The input belt attaches to the left end of the splitter line; the output leaves the right end of
 * the merger line. Everything is centered on the blueprint origin.
 */

export interface MachineRowOptions {
  machine: string;
  count: number;
  recipe?: string;
  /** Conveyor tier 1-5. */
  belt?: number;
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
/** Approximate height (cm) where wires attach to a power pole. */
const POLE_HEIGHT = 400;

export function generateMachineRow(options: MachineRowOptions): Blueprint {
  const spec = findMachine(options.machine);
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("count must be a positive integer.");
  const beltType = `Build_ConveyorBeltMk${options.belt ?? 1}_C`;
  const poleType = `Build_PowerPoleMk${options.pole ?? 1}_C`;

  const inputs = connectorsOf(spec.type).filter((c) => c.kind === "belt" && /^input/i.test(c.name));
  const outputs = connectorsOf(spec.type).filter((c) => c.kind === "belt" && /^output/i.test(c.name));
  if (inputs.length !== 1 || outputs.length !== 1) {
    throw new Error(`${spec.key} has ${inputs.length} belt inputs and ${outputs.length} outputs; this generator supports exactly one of each.`);
  }
  const input = inputs[0];
  const output = outputs[0];

  const splitterType = "Build_ConveyorAttachmentSplitter_C";
  const mergerType = "Build_ConveyorAttachmentMerger_C";
  const b = new BlueprintBuilder(selectLibrary([spec.type, beltType, poleType, splitterType, mergerType, "Build_PowerLine_C"]));
  const rowLength = (options.count - 1) * spec.pitch;
  const xOf = (i: number) => i * spec.pitch - rowLength / 2;

  // Machines face +Y: inputs on the -Y side, outputs on the +Y side (that is how the game models them).
  const machines: Placed[] = [];
  for (let i = 0; i < options.count; i++) {
    const machine = b.place(spec.type, transform(vec(xOf(i), 0, 0)));
    if (options.recipe) b.setRecipe(machine, findRecipe(spec, options.recipe));
    machines.push(machine);
  }

  // Splitter line: each splitter sits in front of a machine input; its +Y side output feeds the machine.
  const splitterY = input.offset.y - FEEDER_LENGTH - ATTACHMENT_RADIUS;
  const splitters = machines.map((machine, i) => {
    const center = vec(xOf(i) + input.offset.x, splitterY, BELT_HEIGHT);
    const splitter = b.place(splitterType, transform(center));
    b.belt(beltType,
      { building: splitter, name: "Output2", position: attachmentPoint(splitterType, center, "Output2") },
      { building: machine, name: input.name, position: b.worldPoint(machine, input.offset) });
    return { splitter, center };
  });
  for (let i = 1; i < splitters.length; i++) {
    const prev = splitters[i - 1];
    const next = splitters[i];
    b.belt(beltType,
      { building: prev.splitter, name: "Output1", position: attachmentPoint(splitterType, prev.center, "Output1") },
      { building: next.splitter, name: "Input1", position: attachmentPoint(splitterType, next.center, "Input1") });
  }

  // Merger line: each merger collects from the machine behind it through its -Y side input.
  const mergerY = output.offset.y + FEEDER_LENGTH + ATTACHMENT_RADIUS;
  const mergerSideInput = connector(mergerType, "Input3");
  const mergers = machines.map((machine, i) => {
    const center = vec(xOf(i) + output.offset.x, mergerY, BELT_HEIGHT);
    const merger = b.place(mergerType, transform(center));
    b.belt(beltType,
      { building: machine, name: output.name, position: b.worldPoint(machine, output.offset) },
      { building: merger, name: mergerSideInput.name, position: add(center, mergerSideInput.offset) });
    return { merger, center };
  });
  for (let i = 1; i < mergers.length; i++) {
    const prev = mergers[i - 1];
    const next = mergers[i];
    b.belt(beltType,
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

  const recipeLabel = options.recipe ? ` ${options.recipe}` : "";
  const name = options.name ?? `${options.count}x ${capitalize(spec.key)}${recipeLabel} Mk${options.belt ?? 1}`;
  return b.build(name, {
    description: `${options.count} ${spec.key}(s)${recipeLabel}. Input: left end of the splitter line. Output: right end of the merger line.`,
  });
}

function attachmentPoint(type: string, center: Vec3, name: string): Vec3 {
  return add(center, connector(type, name).offset);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
