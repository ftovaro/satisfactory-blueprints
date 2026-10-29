import { BeltEnd, BlueprintBuilder, ConnectorRef, Placed } from "../builder.js";
import { Vec3, add, scale, transform, vec, yaw as yawQuat } from "../geometry.js";
import { attachmentPoint, beltType, liftType, pipeType } from "../generators/machine-row.js";
import { CELL, DIRS, Dir, Grid, LEVEL, Route, Step } from "./grid.js";

/**
 * Turns routed cell chains into buildings: straight belts or pipes, 90° turns of radius CELL / 2,
 * Conveyor Lifts (or vertical pipes with inline pumps for liquids) and splitters/junctions where a
 * branch leaves a trunk.
 *
 * Inside a cell, a line enters through the middle of one side and leaves through the middle of
 * another, at the cell's height. Straight cells in a row become one belt/pipe.
 */

export type LineKind = "belt" | "pipe";

const SPLITTER = "Build_ConveyorAttachmentSplitter_C";
const JUNCTION = "Build_PipelineJunction_Cross_C";
const PUMP = "Build_PipelinePump_C";
/** Rotation that points a pump's flow axis (+X) straight up, for pumps inside vertical pipes. */
const PUMP_UPRIGHT = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
/** A Mk1 pump gives 20 m of head lift; pumps on a rising pipe are this many levels apart (16 m). */
const PUMP_EVERY_LEVELS = 4;
const RADIUS = CELL / 2;
/** Hermite tangent length that approximates a circular quarter turn. */
const QUARTER = 1.657 * RADIUS;

export const dirVec = (d: Dir): Vec3 => vec(DIRS[d][0], DIRS[d][1], 0);
const yawOf = (d: Dir) => d * 90;

/** A branch leaving a straight cell of a route sideways (through a splitter or junction). */
export interface Branch {
  stepIndex: number;
  side: Dir;
  /** Builds the branch from the splitter/junction's side connector. */
  build: (start: BeltEnd) => void;
}

export interface LineSpec {
  kind: LineKind;
  /** Belt Mk or pipe Mk. */
  tier: number;
  liquid: boolean;
}

export interface BuildContext {
  b: BlueprintBuilder;
  grid: Grid;
  /** Called for every pump so it can be wired to power. */
  onPump: (pump: Placed, at: Vec3) => void;
}

/**
 * Builds one route. `from` is where the line arrives at the first cell's entry side (a connector or
 * an open end); returns the line's end at the last cell's exit side.
 */
export function buildRoute(ctx: BuildContext, route: Route, spec: LineSpec, from: BeltEnd, branches: Branch[] = []): BeltEnd {
  const { b, grid } = ctx;
  const belt = spec.kind === "belt";
  const center = (s: Step) => grid.center(s.cell);
  const entryOf = (s: Step, d: Dir) => add(center(s), scale(dirVec(d), -RADIUS));
  const exitOf = (s: Step, d: Dir) => add(center(s), scale(dirVec(d), RADIUS));

  let prev = from;
  /** Straight cells are not built one by one: the next piece's start extends them in one go. */
  let runEnd: Vec3 | undefined;
  const runTo = (to: Vec3) => {
    runEnd = undefined;
    if (Math.hypot(to.x - prev.position.x, to.y - prev.position.y, to.z - prev.position.z) < 5) return;
    const d = vec(to.x - prev.position.x, to.y - prev.position.y, 0);
    const len = Math.hypot(d.x, d.y) || 1;
    const piece = belt
      ? b.belt(beltType(spec.tier), prev, { position: to })
      : b.pipe(pipeType(spec.tier), prev, { position: to }, vec(d.x / len, d.y / len, 0));
    prev = { building: piece, name: belt ? "ConveyorAny1" : "PipelineConnection1", position: to };
  };
  const curvePipe = (fromDir: Vec3, toDir: Vec3) => {
    const end = add(prev.position, add(scale(fromDir, RADIUS), scale(toDir, RADIUS)));
    const piece = b.pipeCurve(pipeType(spec.tier), prev, { position: end }, fromDir, toDir, QUARTER);
    prev = { building: piece, name: "PipelineConnection1", position: end };
  };
  const pump = (at: Vec3, rotation: { x: number; y: number; z: number; w: number }) => {
    runTo(at);
    const placed = b.place(PUMP, { rotation, translation: at, scale3d: vec(1, 1, 1) });
    if (prev.building) b.link({ building: placed, name: "Connection0" }, prev as ConnectorRef);
    ctx.onPump(placed, at);
    prev = { building: placed, name: "Connection1", position: at };
  };

  route.steps.forEach((step, index) => {
    if (step.kind === "straight") {
      const branch = branches.find((br) => br.stepIndex === index);
      if (!branch) {
        runEnd = exitOf(step, step.dir);
        return;
      }
      // Splitter or junction in the middle of the cell: the trunk goes through, the branch sideways.
      const c = center(step);
      const [type, yaw] = belt ? [SPLITTER, yawOf(step.dir)] : [JUNCTION, 0];
      const node = b.place(type, transform(c, yaw));
      const names = belt ? splitterNames(step.dir, branch.side) : junctionNames(step.dir, branch.side);
      runTo(attachmentPoint(type, c, names.input, yaw));
      b.link(prev as ConnectorRef, { building: node, name: names.input });
      prev = { building: node, name: names.through, position: attachmentPoint(type, c, names.through, yaw) };
      runEnd = exitOf(step, step.dir);
      branch.build({ building: node, name: names.side, position: attachmentPoint(type, c, names.side, yaw) });
      return;
    }
    if (step.kind === "turn") {
      runTo(entryOf(step, step.from));
      if (belt) prev = b.beltTurn(beltType(spec.tier), prev, dirVec(step.from), dirVec(step.to), RADIUS);
      else curvePipe(dirVec(step.from), dirVec(step.to));
      return;
    }
    // Vertical run from this cell to the one `levels` away, entered and left sideways.
    const rise = step.levels * LEVEL;
    if (belt) {
      runTo(center(step));
      const { lift, output } = b.lift(liftType(spec.tier), prev.position, rise, yawOf(step.from), yawOf(step.to));
      if (prev.building) b.link({ building: lift, name: "ConveyorAny0" }, prev as ConnectorRef);
      prev = { building: lift, name: "ConveyorAny1", position: output };
      runEnd = add(output, scale(dirVec(step.to), RADIUS));
      return;
    }
    const up = vec(0, 0, Math.sign(rise));
    const entry = entryOf(step, step.from);
    const pumped = spec.liquid && rise > 0;
    // A powered pump resets head lift to 20 m from where it sits: the first goes on the level stretch
    // right before the climb, the others inside the vertical pipe.
    if (pumped) pump(entry, yawQuat(yawOf(step.from)));
    else runTo(entry);
    curvePipe(dirVec(step.from), up);
    if (pumped) {
      for (let l = PUMP_EVERY_LEVELS; l < Math.abs(step.levels); l += PUMP_EVERY_LEVELS) pump(add(center(step), vec(0, 0, l * LEVEL)), PUMP_UPRIGHT);
    }
    runTo(add(center(step), vec(0, 0, rise - Math.sign(rise) * RADIUS)));
    curvePipe(up, dirVec(step.to));
  });
  if (runEnd) runTo(runEnd);
  return prev;
}

/** Splitter connector names when items travel along `dir` and the branch leaves toward `side`. */
function splitterNames(dir: Dir, side: Dir) {
  // A splitter turned to face `dir` has Output2 on its left (+90°) and Output3 on its right.
  return { input: "Input1", through: "Output1", side: side === (dir + 1) % 4 ? "Output2" : "Output3" };
}

/** Junction Cross connectors (unturned): 0 at -X, 1 at +X, 2 at +Y, 3 at -Y. */
function junctionNames(dir: Dir, side: Dir) {
  const at: Record<Dir, string> = { 0: "Connection1", 1: "Connection2", 2: "Connection0", 3: "Connection3" };
  return { input: at[((dir + 2) % 4) as Dir], through: at[dir], side: at[side] };
}
