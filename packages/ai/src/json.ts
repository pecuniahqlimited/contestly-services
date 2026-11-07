/** The parsed value, or undefined when the text isn't JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}
