import { defineVitestObservation } from "@ykdz/dock/vitest";

export const settings = defineVitestObservation("preview-settings", {
  mode: "auto",
  revision: 1,
});
export const steps = defineVitestObservation("render-steps", [
  "parse",
  "render",
]);
