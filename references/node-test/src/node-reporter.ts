/** 将原生 TestEvent 无损输出为可校验的 JSON Lines 流。 */
export default async function* reporter(
  events: AsyncIterable<unknown>,
): AsyncGenerator<string, void> {
  for await (const event of events) {
    yield `${JSON.stringify(event)}\n`;
  }
}
