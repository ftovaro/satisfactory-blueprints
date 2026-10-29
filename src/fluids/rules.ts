/**
 * Fluid mechanics rules, from the official wiki (Head lift, Pipelines, Fluids, Pipeline manifold).
 * Everything the fluids module decides is based on these constants, so a wrong behavior in-game
 * should be traced back to one of them.
 */

/** Head lift (meters) a building gives to the fluid it pushes out, measured from its own base. */
export const HEAD_LIFT_SOURCES: Record<string, { recommended: number; maximum: number }> = {
  Build_PipelinePump_C: { recommended: 20, maximum: 22 },
  Build_PipelinePumpMk2_C: { recommended: 50, maximum: 55 },
  Build_WaterPump_C: { recommended: 10, maximum: 12 },
  Build_OilPump_C: { recommended: 10, maximum: 12 },
  Build_FrackingExtractor_C: { recommended: 10, maximum: 11 },
  Build_OilRefinery_C: { recommended: 10, maximum: 11 },
  Build_Packager_C: { recommended: 10, maximum: 11 },
  Build_Blender_C: { recommended: 10, maximum: 11 },
};

/** A full horizontal pipe shows about this much head lift (meters) even with no pump. */
export const HORIZONTAL_PIPE_HEAD_LIFT = 1.3;

/** Margin (meters) to keep below a source's recommended head lift when planning. */
export const HEAD_LIFT_MARGIN = 2;

/** Buildings whose pipe connectors only ever produce fluid (extractors) or only consume it (generators). */
export const PRODUCER_BUILDINGS = /Build_(WaterPump|OilPump|FrackingExtractor)_C$/;
export const CONSUMER_BUILDINGS = /Build_(GeneratorFuel|GeneratorCoal|GeneratorNuclear)_C$/;

/** Pipe buildings that only route fluid. */
export const PIPE_BUILDINGS = /Build_Pipeline(MK2)?(_NoIndicator)?_C$/;
export const JUNCTION_BUILDINGS = /Build_PipelineJunction_Cross_C$|Build_PipelineJunction_T_C$/;
export const PUMP_BUILDINGS = /Build_PipelinePump(Mk2)?_C$/;
export const VALVE_BUILDINGS = /Build_Valve_C$/;
export const BUFFER_BUILDINGS = /Build_PipeStorageTank_C$|Build_IndustrialTank_C$/;

/** Machines feeding this many junctions or more should have a loopback pipe (wiki: Pipeline manifold). */
export const LOOPBACK_MIN_JUNCTIONS = 3;
