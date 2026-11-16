// Keep redirected output and NO_COLOR terminals free of escape sequences.
export function colorsEnabled(isTTY = !!process.stdout.isTTY, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb';
}

export function terminalStyle(color = colorsEnabled()) {
  const wrap = (open: number, close: number) => (text: string): string => color ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    strong: wrap(1, 22),
    muted: wrap(90, 39),
    success: wrap(32, 39),
    warning: wrap(33, 39),
    error: wrap(31, 39),
    info: wrap(36, 39),
  };
}
