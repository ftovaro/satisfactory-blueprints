/**
 * Sign icon IDs (the game's icon library) for items, by display name.
 *
 * The game files available to us do not list these IDs, so they were learned from real blueprints:
 * signs whose text names an item, and blueprints whose icon is their main product. IDs run in game
 * order (e.g. Iron Ore 193, Iron Ingot 194, Iron Plate 195). Items not listed get a sign without an
 * item icon.
 */
const ICONS: Record<string, number> = {
  "Iron Ore": 193,
  "Iron Ingot": 194,
  "Iron Plate": 195,
  "Copper Ore": 198,
  "Bauxite": 199,
  "Caterium Ore": 200,
  "Crude Oil": 202,
  "Sulfur": 203,
  "Limestone": 204,
  "Coal": 205,
  "Raw Quartz": 206,
  "Concrete": 211,
  "Quartz Crystal": 218,
  "Steel Beam": 219,
  "Encased Industrial Beam": 221,
  "Rubber": 222,
  "Plastic": 224,
  "Heavy Modular Frame": 225,
  "High-Speed Connector": 226,
  "Rotor": 232,
  "Water": 242,
  "Stator": 247,
  "Steel Pipe": 256,
  "Crystal Oscillator": 270,
  "Quickwire": 274,
  "Silica": 275,
};

export function iconFor(itemName: string): number | undefined {
  return ICONS[itemName];
}
