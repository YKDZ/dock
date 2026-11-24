/** Emit raw native TestEvent records as a verifiable JSON Lines stream. */
export default async function* reporter(
  events: AsyncIterable<unknown>,
): AsyncGenerator<string, void> {
  for await (const event of events) {
    yield `${JSON.stringify(event)}\n`;
  }
}
