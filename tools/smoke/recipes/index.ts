import type { Recipe } from "../recipe.ts";
import { abbUsu42 } from "./abb-usu-4.2.ts";

// The registry the runner enumerates. Add one entry per proven device; the runner branches only
// on what each recipe declares (see docs/e2e-smoke-framework.md).
export const RECIPES: Recipe[] = [abbUsu42];
