import { defineVitestObservation } from "@dock/reference-vitest";

export const settings = defineVitestObservation("group-settings", {
  mode: "auto",
  revision: 0,
});
export const steps = defineVitestObservation("group-steps", [
  "parse",
  "render",
]);
