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

### Generating blueprints

```bash
npm run sbp -- generate row --machine constructor --count 4 --recipe IronPlate --belt 2 --session "My Session"
npm run sbp -- generate row --machine smelter --count 6 --recipe IngotCopper --out-dir ./out
```

| Option      | Meaning                                                                 |
|-------------|-------------------------------------------------------------------------|
| `--machine` | `constructor` or `smelter`                                              |
| `--count`   | number of machines in the row                                           |
| `--recipe`  | optional recipe, e.g. `IronPlate`, `Screw`, `Wire`, `IngotIron` (or a full recipe path) |
| `--belt`    | conveyor tier 1-5 (default 1)                                           |
| `--pole`    | power pole tier 1-2 (default 1)                                         |
| `--session` | write straight into that session's blueprint folder                     |
| `--out-dir` | write to any folder instead                                             |
| `--name`    | blueprint name (default describes the contents)                         |
| `--force`   | overwrite an existing blueprint with the same name                      |

Layout: machines face the same direction, a line of splitters feeds their inputs and a line of mergers collects their outputs. Connect your supply belt to the left end of the splitter line and take the products from the right end of the merger line. Power poles sit between the machines; connect any of them to your grid. After placing the blueprint in-game, you can open it in the Blueprint Designer and re-save it so the game recalculates its cost.

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
3. Generate simple modules (a row of machines with input/output manifolds and power): first version done, in-game testing pending
4. Multi-input machines (assemblers, foundries, manufacturers) using conveyor lifts
5. Recipe and ratio calculator
6. Full production lines (for example Motors, Computers, Heavy Modular Frames) written straight into a session folder

## Safety notes

- Generated blueprints are plain files; back up your blueprint folder before experimenting.
- `.sbpcfg` files can contain the account ID of the last player who edited the blueprint. The `.gitignore` excludes `.sbp`, `.sbpcfg` and JSON dumps so you do not commit them by accident.

## Disclaimer

This is a fan project. It is not affiliated with or endorsed by Coffee Stain Studios. Satisfactory is a trademark of Coffee Stain Studios.

## License

[MIT](LICENSE)
