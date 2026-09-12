export function emitError(message: string, useJson: boolean): void {
  if (useJson) {
    console.error(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(message);
  }
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
