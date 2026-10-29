import { Plan, Rate, fmt } from "./plan.js";
import { GameData } from "../gamedata/index.js";

const unit = (r: Rate) => (r.item.form === "solid" ? "/min" : " m³/min");
const transportName = (r: Rate) => r.transport?.name ?? "TOO FAST FOR ONE LINE";
const rateText = (r: Rate) => `${fmt(r.perMinute)}${unit(r)} ${r.item.name}`;
const clockText = (clocks: number[]) => {
  const full = clocks.filter((c) => Math.abs(c - 1) < 1e-6).length;
  const rest = clocks.filter((c) => Math.abs(c - 1) >= 1e-6).map((c) => `1 @ ${fmt(c * 100)}%`);
  return [full > 0 ? `${full} @ 100%` : "", ...rest].filter(Boolean).join(" + ");
};

export function formatPlan(plan: Plan, data: GameData): string {
  const lines: string[] = [];
  lines.push(`PLAN: ${rateText(plan.target)}  (output on ${transportName(plan.target)})`, "");

  lines.push("Inputs:");
  for (const r of plan.inputs) lines.push(`  ${rateText(r).padEnd(44)} ${transportName(r)}`);
  lines.push("");

  plan.steps.forEach((step, i) => {
    const machine = data.machines[step.recipe.machine];
    lines.push(`${i + 1}. ${step.product.name}${step.recipe.name === step.product.name ? "" : ` (recipe: ${step.recipe.name})`}`);
    lines.push(`   ${machine.name}: ${step.clocks.length} (${clockText(step.clocks)}), ${fmt(step.productPerMachine)}${unit(step.outputs[0])} each at 100%, ${fmt(step.power)} MW`);
    for (const r of step.inputs) lines.push(`   in   ${rateText(r).padEnd(40)} ${transportName(r)}`);
    for (const r of step.outputs) lines.push(`   out  ${rateText(r).padEnd(40)} ${transportName(r)}`);
    lines.push("");
  });

  if (plan.byproducts.length > 0) {
    lines.push("Byproducts (leave the factory):");
    for (const r of plan.byproducts) lines.push(`  ${rateText(r).padEnd(44)} ${transportName(r)}`);
    lines.push("");
  }

  const machineCount = plan.steps.reduce((n, s) => n + s.clocks.length, 0);
  lines.push(`Total: ${machineCount} machines, ${fmt(plan.power)} MW`);
  for (const w of plan.warnings) lines.push(`Warning: ${w}`);
  return lines.join("\n");
}
