export default {
  test: {
    include: ["test/**/*.test.mts"],
    retry: 1,
    testNamePattern: /primary$/,
  },
};
