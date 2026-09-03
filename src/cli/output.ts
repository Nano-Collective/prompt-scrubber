export function emitError(message: string, useJson: boolean): void {
  if (useJson) {
    console.error(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(message);
  }
}
