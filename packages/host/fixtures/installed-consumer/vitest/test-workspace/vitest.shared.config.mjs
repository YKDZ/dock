export default {
  test: {
    include: ["test/**/*.test.mts"],
    retry: 1,
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
};
