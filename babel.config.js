module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    env: {
      // Jest can't execute native dynamic import(); transform it to require() so
      // service code that lazy-loads native modules (expo-notifications, etc.) is
      // testable. Does not affect the Metro/production build.
      test: {
        plugins: ["babel-plugin-dynamic-import-node"],
      },
    },
  };
};
