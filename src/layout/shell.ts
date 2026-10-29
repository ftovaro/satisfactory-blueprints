import { BlueprintBuilder, Placed } from "../builder.js";
import { Vec3, transform, vec } from "../geometry.js";

/**
 * The building around a factory: walls standing on the ground it is placed on, windows, a door, a
 * flat roof, holes where belts and pipes cross the walls, and a wall-mounted power inlet.
 *
 * Geometry learned from real blueprints:
 * - an 8 m x 4 m wall has its origin at the bottom center; it spans its local Y (8 m) and Z (4 m),
 *   and its local +X points away from the foundation it stands on (outward);
 * - a conveyor wall panel passes its belt through its middle, 1 m above its base;
 * - wall accessories (Conveyor Wall Hole, Pipeline Wall Support, Wall Power Pole) sit in the wall
 *   plane with their +X along the wall's normal;
 * - a 1 m foundation's top is 50 cm above its origin.
 *
 * Template versions differ (1.0 has other window walls and no Conveyor Wall Hole), so every piece
 * is picked from a preference list among the types the blueprint's version has.
 */

const WALL_WIDTH = 800;
const WALL_HEIGHT = 400;
const FOUNDATION = 800;

export interface Opening {
  /** Where a belt or pipe crosses the envelope (on one of its sides). */
  at: Vec3;
  kind: "belt" | "pipe";
}

export interface ShellOptions {
  envelope: { minX: number; maxX: number; minY: number; maxY: number };
  /** Height of the ground the walls stand on. */
  floorZ: number;
  /** Height of the roof's underside (whole 4 m walls above the floor). */
  roofZ: number;
  openings: Opening[];
  /** Whether a door at ground level, at `at` on the wall and opening along `inward`, would be clear. */
  doorway?: (at: Vec3, inward: Vec3) => boolean;
}

export interface Shell {
  /** Wall power pole on the outside of the back wall: connect the factory to your grid here. */
  inlet?: { pole: Placed; position: Vec3 };
  pieces: number;
}

export function buildShell(b: BlueprintBuilder, options: ShellOptions): Shell {
  const { envelope: e, floorZ, roofZ, openings } = options;
  const solid = b.pick("Build_Wall_8x4_01_C", "Build_Wall_Concrete_8x4_C");
  const window = b.pick("Build_Wall_Window_8x4_01_C", "Build_Wall_Window_8x4_03_C", "Build_Wall_Window_Thin_8x4_01_C", "Build_Wall_Concrete_8x4_Window_02_C") ?? solid;
  const door = b.pick("Build_Wall_Door_8x4_01_C", "Build_Wall_Door_8x4_01_Steel_C", "Build_Wall_Concrete_SDoor_8x4_C") ?? solid;
  // A belt crossing the middle of a panel uses a wall with a conveyor opening (the belt runs 1 m
  // above the panel's base, in its middle); elsewhere a Conveyor Wall Hole on a plain wall.
  const beltPanel = b.pick("Build_Wall_Conveyor_8x4_03_C", "Build_Wall_Conveyor_8x4_03_Steel_C", "Build_Wall_Concrete_8x4_ConveyorHole_01_C");
  const beltHole = b.pick("Build_ConveyorWallHole_C");
  const pipeHole = b.pick("Build_PipelineSupportWallHole_C");
  const roof = b.pick("Build_Foundation_Concrete_8x1_C", "Build_Foundation_8x1_01_C");
  const wallPole = b.pick("Build_PowerPoleWall_C");
  if (!solid) return { pieces: 0 };

  let pieces = 0;
  const courses = Math.round((roofZ - floorZ) / WALL_HEIGHT);
  const inwardOf = (yaw: number) => vec(-Math.round(Math.cos((yaw * Math.PI) / 180)), -Math.round(Math.sin((yaw * Math.PI) / 180)), 0);
  // Sides: [fixed coordinate, along axis range, outward yaw]; a wall's +X points outward.
  const sides = [
    { name: "back", x: e.minX, y: undefined, from: e.minY, to: e.maxY, yaw: 180 },
    { name: "front", x: e.maxX, y: undefined, from: e.minY, to: e.maxY, yaw: 0 },
    { name: "right", x: undefined, y: e.minY, from: e.minX, to: e.maxX, yaw: -90 },
    { name: "left", x: undefined, y: e.maxY, from: e.minX, to: e.maxX, yaw: 90 },
  ] as const;

  // Every panel: which openings cross it and where.
  const panels = sides.flatMap((side) => {
    const segments = Math.round((side.to - side.from) / WALL_WIDTH);
    const onSide = openings.filter((o) => (side.x !== undefined ? Math.abs(o.at.x - side.x) < 50 : Math.abs(o.at.y - side.y!) < 50));
    return Array.from({ length: segments }, (_, s) => {
      const along = side.from + (s + 0.5) * WALL_WIDTH;
      const at = (z: number) => (side.x !== undefined ? vec(side.x, along, z) : vec(along, side.y!, z));
      return Array.from({ length: courses }, (_, c) => {
        const z = floorZ + c * WALL_HEIGHT;
        const here = onSide.filter((o) => {
          const pos = side.x !== undefined ? o.at.y : o.at.x;
          return Math.abs(pos - along) <= WALL_WIDTH / 2 && o.at.z >= z && o.at.z < z + WALL_HEIGHT;
        });
        return { side, s, segments, c, z, at: at(z), here };
      });
    }).flat();
  });

  // The door: on the ground course, in a panel no line crosses, preferring the right side and the
  // middle of a side, where the way in is clear.
  const order = ["right", "left", "front", "back"];
  const fromMiddle = (p: { s: number; segments: number }) => Math.abs(p.s - (p.segments - 1) / 2);
  const candidates = panels
    .filter((p) => p.c === 0 && p.here.length === 0)
    .sort((a, c) => order.indexOf(a.side.name) - order.indexOf(c.side.name) || fromMiddle(a) - fromMiddle(c));
  const doorPanel = candidates.find((p) => options.doorway?.(p.at, inwardOf(p.side.yaw)) ?? true) ?? candidates[0];

  for (const p of panels) {
    const { side, c, here } = p;
    const centered = here.length === 1 && here[0].kind === "belt" && beltPanel
      && Math.abs((side.x !== undefined ? here[0].at.y - p.at.y : here[0].at.x - p.at.x)) < 1 && Math.abs(here[0].at.z - p.z - 100) < 1;
    // Openings without a matching hole piece leave the panel out.
    if (!centered && here.some((o) => !(o.kind === "belt" ? beltHole : pipeHole))) continue;
    // Windows on the middle courses of every other panel.
    const type = centered ? beltPanel : p === doorPanel ? door : c > 0 && c < courses - 1 && p.s % 2 === 1 ? window : solid;
    b.place(type!, transform(p.at, side.yaw));
    pieces++;
    if (centered) continue;
    for (const o of here) {
      b.place((o.kind === "belt" ? beltHole : pipeHole)!, transform(o.at, side.yaw));
      pieces++;
    }
  }

  // Flat roof of 1 m foundations resting on the walls.
  if (roof) {
    for (let x = e.minX; x < e.maxX; x += FOUNDATION) {
      for (let y = e.minY; y < e.maxY; y += FOUNDATION) {
        b.place(roof, transform(vec(x + FOUNDATION / 2, y + FOUNDATION / 2, roofZ + 50)));
        pieces++;
      }
    }
  }

  // Power inlet: a wall pole on the outside of the back wall, at head height.
  let inlet: Shell["inlet"];
  if (wallPole) {
    const position = vec(e.minX, e.minY + WALL_WIDTH / 2, floorZ + 250);
    const pole = b.place(wallPole, transform(position, 180));
    inlet = { pole, position };
    pieces++;
  }
  return { inlet, pieces };
}

