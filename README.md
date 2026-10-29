# satisfactory-blueprints

A command-line toolkit for working with [Satisfactory](https://www.satisfactorygame.com/) blueprint files (`.sbp` / `.sbpcfg`).

The long-term goal is to **generate blueprints automatically**: ask for "a motor factory at 10/min" and get a ready-to-use blueprint dropped into your game's blueprint folder. The first milestone is reading and understanding existing blueprints, which is what works today.

> Status: early development. Reading blueprints works, and the first generator (a row of machines) produces blueprints that still need in-game testing.

## Features

- `list`: show your save sessions and the blueprints inside each one
- `inspect`: readable summary of a blueprint (buildings, cost, dimensions, bounds)
- `dump`: full blueprint as JSON, for studying how buildings and connections are stored
- `roundtrip`: parse and re-serialize a blueprint to verify the writer produces identical content
- `scan`: parse every blueprint you own and report any that fail
- `connectors`: show where each building's belt/pipe connectors are, learned from real blueprints
- `learn`: rebuild the bundled building data from the blueprints on your machine
- `generate row`: create a row of constructors or smelters with a splitter manifold, a merger manifold and power

Parsing and serialization are powered by [`@etothepii/satisfactory-file-parser`](https://github.com/etothepii4/satisfactory-file-parser).

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- Satisfactory 1.0 or newer (older Update 8 blueprints also parse)

## Installation

```bash
git clone https://github.com/ftovaro/satisfactory-blueprints.git
cd satisfactory-blueprints
npm install
```

## Usage

```bash
npm run sbp -- list
npm run sbp -- list "My Session"
npm run sbp -- inspect "My Session/My Blueprint"
npm run sbp -- inspect "My Session/My Blueprint" --json
npm run sbp -- dump "My Session/My Blueprint" --out my-blueprint.dump.json
npm run sbp -- roundtrip "My Session/My Blueprint"
npm run sbp -- scan
```

A blueprint can be given as `Session/Name` (relative to the blueprint folder) or as a full path to an `.sbp` file.

### Game data and planning

The planner reads recipes, items and machines from your own game install (`CommunityResources/Docs/en-US.json`). Import them once, and again after game updates:

```bash
npm run sbp -- import-game-data            # add --game-dir <path> if the game is not in the default Steam folder
npm run sbp -- recipes "Screw"
npm run sbp -- plan "Motor" 10
npm run sbp -- plan "Reinforced Iron Plate" 15 --recipe "Screw=Steel Screws" --input "Steel Beam"
```

A plan lists every production step with its machine count and clock speeds (all machines at 100% except the last one), the belt or pipe tier each flow needs, byproducts, and total power.

### Generating blueprints

```bash
npm run sbp -- generate row --recipe "Iron Plate" --rate 45 --session "My Session"
npm run sbp -- generate row --machine smelter --count 6 --recipe IngotCopper --out-dir ./out
```

| Option      | Meaning                                                                 |
|-------------|-------------------------------------------------------------------------|
| `--rate`    | target output per minute; sizes the row with the planner (needs `--recipe`, any recipe name) |
| `--machine` | `constructor`, `smelter`, `assembler`, `foundry`, `manufacturer` or `refinery` (with `--count`) |
| `--count`   | number of machines in the row, all at 100%                              |
| `--recipe`  | recipe, e.g. `Iron Plate`, `Cast Screws`, `IngotIron` (or a full recipe path) |
| `--belt`    | conveyor tier 1-6 (default: the slowest tier that carries the flow with `--rate`, otherwise 1) |
| `--pole`    | power pole tier 1-2 (default 1)                                         |
| `--session` | write straight into that session's blueprint folder                     |
| `--out-dir` | write to any folder instead                                             |
| `--name`    | blueprint name (default describes the contents)                         |
| `--force`   | overwrite an existing blueprint with the same name                      |

Layout: machines face the same direction, a line of splitters feeds each input and a line of mergers collects the output. Connect your supply belts to the left end of the splitter lines and take the products from the right end of the merger line. Machines with several inputs (Assembler, Foundry, Manufacturer) get one manifold per input, stacked 4 m apart; the upper ones drop into the machines through Conveyor Lifts. With `--rate`, every belt segment gets the slowest tier that carries its flow: the input lines get slower toward their far end and the output line faster toward its exit. The command prints which belt tier each supply line needs. Power poles sit between the machines; connect any of them to your grid. After placing the blueprint in-game, you can open it in the Blueprint Designer and re-save it so the game recalculates its cost.

### Complete factories

```bash
npm run sbp -- generate factory "Reinforced Iron Plate" 5 --session "My Session"
npm run sbp -- generate factory "Steel Beam" 15 --recipe "Steel Ingot=Solid Steel Ingot" --out-dir ./out
```

The whole production chain goes into one blueprint, built upward:

- **Steps and floors:** one machine row per product (same manifolds as `generate row`), shared by every step that uses it. Steps fed only by raw materials are on the ground floor and every other step sits one floor above its highest solid ingredient. A step fed a fluid by another step stays on that step's floor when it can, so fluids rarely climb. Floors are 1 m concrete foundation slabs.
- **One input per raw material, one output per product:** each raw material enters through a single open belt or pipe end on the back edge at ground level. The final product, and any byproduct nothing inside uses (e.g. Heavy Oil Residue), leave through their own open ends on the front edge, in the direction of the placement arrow. Use Auto-Connect (R) to hook them up.
- **Connections between steps:** routed in a 3D grid of 4 m cells around and between the rows (`src/layout/grid.ts`). Each connection takes the shortest path made of straight runs, 90° turns and vertical runs. Belts climb with Conveyor Lifts; pipes climb vertically, with a Pipeline Pump every 16 m when the fluid is a liquid. A product or raw material used by several rows branches off through a splitter (junction for pipes) placed on its existing line.
- **No clashes by construction:** a grid cell holds one piece of one line, machines and slabs are blocked, and slabs only cover the rows so lines can rise in the gaps between them.
- **Power:** all rows and pumps share one grid; connect any pole.
- **Size:** large factories exceed the Blueprint Designer. The game still places them, but they cannot be edited in a designer.
- **Not supported yet:** byproducts that are only partly used inside the factory (e.g. Silica in Aluminum production), because their surplus would need a Smart Splitter on overflow.

Every generated blueprint is checked automatically (`sbp check` runs the same checks on any blueprint):
- links stored on both sides;
- belt ends exactly on their connectors;
- belts entering lifts the right way;
- no belts, lifts or pipes clipping each other;
- pole connection limits;
- every machine powered.

### Fluids

Recipes with fluids (for example `Plastic`, `Rubber`, `Fuel`) get pipe manifolds made of Junction Crosses, with a loopback pipe when there are 3 or more machines. To inspect the pipe networks of any blueprint, generated or hand-made:

```bash
npm run sbp -- fluids check "My Session/My Blueprint"
```

It lists each network's fluid, consumers and producers with their m³/min, elevations and open ports. It reports mixed fluids, pipes that are too slow, head lift that is too low (liquids only; gases ignore it), and manifolds without a loopback. The rules come from the wiki and are in `src/fluids/rules.ts`; `docs/DESIGN.md` explains them.

### How generation works

The save format does not describe where a machine's connectors are, so the tool learns it: belts are splines whose end points sit exactly on the connectors they attach to, so measuring those end points across many real blueprints gives each connector's position (`data/connectors.json`). New buildings are cloned from real objects (`data/templates.json`) and only their names, positions and connections are changed, so they keep exactly the structure the game expects. Run `npm run sbp -- learn` to rebuild both files from the blueprints on your own machine.

### Where blueprints live

On Windows, Satisfactory stores blueprints at:

```
%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\blueprints\<SessionName>\
```

Each subfolder is a save session. A blueprint is only visible in-game for the session whose folder it is in. Each blueprint is made of two files:

| File      | Contents                                                         |
|-----------|------------------------------------------------------------------|
| `.sbp`    | Header (versions, designer size, item cost, recipes) plus compressed building data |
| `.sbpcfg` | Description, icon and color shown in the in-game blueprint menu  |

To use a different folder (Linux/Proton, dedicated servers, a test copy), pass `--dir <path>` or set the `SATISFACTORY_BLUEPRINT_DIR` environment variable.

## Example output

```
Blueprint:   8 Smelters, 2 input belts (Mk 3), 2 output belts (Mk 3), 2 power buses
Version:     save 33, build 208250
Designer:    4 x 4 x 4 (foundations)
Objects:     340

Buildings:
     8  SmelterMk1
     8  ConveyorAttachmentSplitter
     8  ConveyorAttachmentMerger
    12  ConveyorBeltMk3
    ...
```

## Roadmap

1. ~~Read, inspect and round-trip blueprints~~
2. ~~Learn connector positions from real blueprints~~
3. ~~Generate simple modules (a row of machines with input/output manifolds and power)~~ (verified in-game)
4. ~~Recipe and ratio planner from the game's own data~~
5. ~~Multi-input machines (assemblers, foundries, manufacturers) using conveyor lifts~~ (verified in-game)
6. ~~Full production lines stacked in floors, one input per raw material, fluids with pumps~~ (in-game testing pending)
7. Building shells, colors and signs

## Safety notes

- Generated blueprints are plain files; back up your blueprint folder before experimenting.
- `.sbpcfg` files can contain the account ID of the last player who edited the blueprint. The `.gitignore` excludes `.sbp`, `.sbpcfg` and JSON dumps so you do not commit them by accident.

## Disclaimer

This is a fan project. It is not affiliated with or endorsed by Coffee Stain Studios. Satisfactory is a trademark of Coffee Stain Studios.

## License

[MIT](LICENSE)
