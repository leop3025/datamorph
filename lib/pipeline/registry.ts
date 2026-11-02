import type { StepDef } from "./types";
import { CLEAN_STEPS } from "./steps/clean";
import { TRANSFORM_STEPS } from "./steps/transform";

export const STEP_DEFS: StepDef[] = [...CLEAN_STEPS, ...TRANSFORM_STEPS];

const byType = new Map(STEP_DEFS.map((d) => [d.type, d]));

export function getStepDef(type: string): StepDef {
  const def = byType.get(type);
  if (!def) throw new Error(`Unknown step type: ${type}`);
  return def;
}
