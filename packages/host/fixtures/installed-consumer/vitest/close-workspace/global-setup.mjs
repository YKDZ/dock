export default async function setup() {
  return () => {
    throw new Error("Vitest global teardown failed");
  };
}
