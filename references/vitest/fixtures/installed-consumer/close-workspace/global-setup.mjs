export default async function setup() {
  return () => {
    throw new Error("Vitest 全局收尾失败");
  };
}
