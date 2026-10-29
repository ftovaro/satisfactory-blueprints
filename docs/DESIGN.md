# Design

How the generator turns a request such as "a Motor factory at 10/min" into a blueprint that works on the first placement. Each section lists the rules the code must follow and where they come from.

## 1. Sources of truth

| Source | What we take from it |
|--------|----------------------|
| `CommunityResources/Docs/en-US.json` in the game install | Recipes (inputs, outputs, duration, machine), item forms (solid/liquid/gas), belt and lift speeds, pipe flow limits, machine power and Power Shard slots, exact recipe and building class paths |
| [Official wiki](https://satisfactory.wiki.gg/) | Mechanics the data file does not describe: head lift, manifold behavior, pipe sloshing, layout conventions |
| Blueprints on the player's machine | Connector positions (`data/connectors.json`) and object templates (`data/templates.json`) |

The data file is read from the player's own game install (`sbp import-game-data`) and is not committed, because it belongs to Coffee Stain Studios. Every number in the planner comes from it; nothing is hand-typed except where noted.

Useful constants from the data file (Satisfactory 1.x):

| Thing | Raw value | Meaning |
|-------|-----------|---------|
| Belt / lift Mk1-Mk6 `mSpeed` | 120, 240, 540, 960, 1560, 2400 | 60, 120, 270, 480, 780, 1200 items/min (`mSpeed / 2`) |
| Pipeline Mk1 / Mk2 `mFlowLimit` | 5, 10 m³/s | 300, 600 m³/min |
| Machine power | `mPowerConsumption`, exponent 1.321929 | Power at clock *c* = base × c^1.321929 |

## 2. Planner (runs before any file is written)

Input: target item, target rate, optional recipe choices (alternates), optional raw inputs the player will provide.

Output: a plan that is printed and can be reviewed before generating:

- Production tree: one step per (recipe, machine type).
- Per step: machine count, clock speeds, input and output rates.
- Per belt or pipe: required throughput and the tier chosen.
- Power total.
- Warnings: belt tier exceeded, Power Shards needed, head lift problems (section 5).

### Machine count and clock speed

Every machine in a step runs at 100% except the last one, which takes the remainder:

```
machines   = ceil(rate / ratePerMachine)
lastClock  = (rate - (machines - 1) * ratePerMachine) / ratePerMachine
```

Example: 45 Iron Plates/min with 20/min per Constructor gives 3 machines: 100%, 100%, 25%. Never spread an odd clock across all machines. Overclocking (more than 100%) only happens when explicitly requested, because it needs Power Shards.

### Belt tier

The smallest tier whose speed is at least the flow on that segment. In a manifold the main line carries the full flow and the side belts carry one machine's flow. If even Mk6 (1200/min) is not enough, the planner splits the row into parallel manifolds or uses an injected manifold.

## 3. Layout

### Manifolds (not balancers)

Manifolds: splitters or mergers in series next to the machines. They are compact and need no exact math because full machines stop accepting items. Supported variants:

| Variant | Description |
|---------|-------------|
| `standard` | Input on one end, output leaves back toward the input end |
| `mirrored` | Output leaves from the opposite end (default) |
| `double` | Two rows of machines facing a shared merger line |
| `injected` | Additional supply belts merged mid-line (Smart Splitter set to overflow before each merge) when one belt cannot carry the full input |

The output direction is chosen per request.

### Multi-input machines and vertical stacking

Assemblers, Foundries and Manufacturers have 2 to 4 inputs on the same side, so flat manifolds would cross. Each extra input manifold runs on a higher level and drops into its machine input through a Conveyor Lift. Factories are built upward as well: one production step per floor, connected with lifts, to keep the footprint small.

### Orientation and ports

- A blueprint's front is the side where the Blueprint Designer's terminal was. While placing, the game draws a white arrow pointing that way. In blueprint coordinates the front is **-Y**.
- Generated layouts are rotated so that inputs enter at the back (+Y edge) and the product leaves at the front (-Y edge), following the arrow.
- Every port is an **open belt end lying exactly on the designer boundary**, which is what hand-made blueprints do. The game's Auto-Connect mode (press R while placing) only links open belt, pipe, railway and vehicle-path ends, up to 16 m away, preferring the best-aligned one. The free side of a splitter or merger is not an open end.

### Modules

A module is a self-contained block with typed ports:

- One input port per resource type and one output port, each with a rate and a belt tier.
- Ports sit on the foundation grid at fixed positions on the module's walls (inputs on one face, output on the opposite face), so the output of an Iron Ingot module lines up with the input of an Iron Plate module.
- Each port is labeled with a sign showing the item, rate and direction.

A "complete" factory is a chain of modules wired together inside one blueprint, exposing only the raw-resource inputs and the final output.

### Architecture and style

Blueprints may include a shell: foundations, walls with windows, roof, railings, stairs, lighting, and signs. Colors use the Customizer (swatches and custom colors stored in `mCustomizationData`). Styles are presets (palette plus shell pieces) chosen per request; the factory layout never depends on the style.

## 4. Building blocks in code

| Module | Responsibility |
|--------|----------------|
| `templates.ts` | Building templates per save version (one version per blueprint, never mixed) |
| `connectors.ts` | Learned connector positions |
| `builder.ts` | Place buildings, belts, power, recipes and clock speeds |
| `gamedata/` | Import and query `en-US.json` (planned) |
| `planner/` | Rates, machine counts, belt tiers (planned) |
| `layout/` | Manifold variants, floors, modules, ports (planned) |
| `fluids/` | Everything about pipes (planned, section 5) |
| `style/` | Shells, colors, signs (planned) |

## 5. Fluids

Fluids follow different rules than items, so they live in their own module (`src/fluids/`) with their own validation and debug output.

### Rules

- Pipelines carry one fluid at a time: Mk1 300 m³/min, Mk2 600 m³/min. They have no fixed direction.
- **Liquids need head lift; gases do not** (Nitrogen Gas, Rocket Fuel, Ionized Fuel, Excited Photonic Matter, Dark Matter Residue).
- Head lift sources (recommended values): Pipeline Pump Mk1 20 m, Mk2 50 m; Water Extractor, Oil Extractor, Refinery, Packager, Resource Well Extractor and Blender 10 m. Exceeding the recommended value by more than about 1-2 m stops the flow.
- Only the elevation difference matters, measured from the source's base to the highest point the fluid must reach; the pipe's shape does not matter. A full horizontal pipe shows about 1.3 m.
- Splitting a pipe keeps the same head lift on each branch; joining pipes uses the highest head lift.
- A powered pump resets head lift to its own value; an unpowered pump acts as a one-way valve. Space pumps vertically, never several close together.
- Pipeline manifolds (Junction Crosses in series) need a **loopback pipe** from the feed to the far end, otherwise flow drops and sloshing appears.
- Avoid chaining Fluid Buffers in series; attach them to the side through a junction.
- Prefer building junctions, pumps and valves first and connecting pipes to them (pipes placed through a junction can throttle flow).

### Planner checks

For each pipe network:

1. Total flow per segment ≤ pipe capacity, picking Mk1 or Mk2.
2. For liquids: the highest point of every consumer minus the source base must be ≤ the available head lift; otherwise insert pumps with ≥ 2 m margin.
3. Manifolds get a loopback pipe.

### Debugging

`sbp fluids check <blueprint>` (planned) prints every pipe network as a graph: fluid, sources, consumers, flow per segment versus capacity, the highest point versus available head lift, and the margin. Problems are listed with the exact pipe or junction involved, so a fluid issue can be traced without loading the game.

## 6. Validation before writing

`sbp check <blueprint>` (planned), also run automatically after `generate`:

- Every belt connector is linked on both ends.
- Belt throughput is at least the planned flow.
- Every machine is connected to power.
- Fluid checks from section 5.
- All templates come from one save version.
