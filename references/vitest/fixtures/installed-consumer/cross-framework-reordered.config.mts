import configuration from "./cross-framework.config.mts";

export default {
  ...configuration,
  plugins: [...configuration.plugins].reverse(),
};
