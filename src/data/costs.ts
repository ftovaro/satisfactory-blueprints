/**
 * Build costs of the buildings the generators place, used for the blueprint header.
 * The game shows this total in the blueprint menu. Values follow Satisfactory 1.x and were
 * cross-checked against the costs stored in real blueprints.
 */

const part = (name: string) => `/Game/FactoryGame/Resource/Parts/${name}/Desc_${name}.Desc_${name}_C`;

const COSTS: Record<string, Record<string, number>> = {
  Build_ConstructorMk1_C: { IronPlateReinforced: 2, Cable: 8 },
  Build_SmelterMk1_C: { IronRod: 5, Wire: 8 },
  Build_AssemblerMk1_C: { IronPlateReinforced: 8, Rotor: 4, Cable: 10 },
  Build_FoundryMk1_C: { ModularFrame: 10, Rotor: 10, Cement: 20 },
  Build_ConveyorAttachmentSplitter_C: { IronPlate: 5, Cable: 5 },
  Build_ConveyorAttachmentMerger_C: { IronPlate: 2, IronRod: 2 },
  Build_PowerPoleMk1_C: { Wire: 3, IronRod: 1, Cement: 1 },
  Build_PowerPoleMk2_C: { HighSpeedWire: 6, IronRod: 2, Cement: 2 },
  Build_PowerLine_C: { Cable: 1 },
  // Belts: cost per 2 m segment.
  Build_ConveyorBeltMk1_C: { IronPlate: 1 },
  Build_ConveyorBeltMk2_C: { IronPlateReinforced: 1 },
  Build_ConveyorBeltMk3_C: { SteelPlate: 1 },
  Build_ConveyorBeltMk4_C: { SteelPlateReinforced: 1 },
  Build_ConveyorBeltMk5_C: { AluminumPlate: 1 },
};

/** Cost of one building (or one 2 m belt segment), keyed by item descriptor path. Unknown types cost nothing. */
export function costOf(typePath: string): Record<string, number> {
  const cost = COSTS[typePath.split(".").pop() ?? ""] ?? {};
  return Object.fromEntries(Object.entries(cost).map(([item, amount]) => [part(item), amount]));
}
