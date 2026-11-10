// The kill screen: what the player screen can say when the DM shows it after a
// kill. The main process only lets these phrases through, so the player screen
// never shows text from anywhere else.
//
// Pure data and functions, no DOM or Node access.

export const KILL_PHRASES: readonly string[] = ['How do you want to do this?', 'FINISH IT!'];

export const isKillPhrase = (value: unknown): value is string =>
  typeof value === 'string' && KILL_PHRASES.includes(value);

/** A random phrase, other than the last one shown when there is a choice. */
export function pickKillPhrase(previous: string | null, random: () => number = Math.random): string {
  const choices =
    KILL_PHRASES.length > 1 ? KILL_PHRASES.filter((phrase) => phrase !== previous) : KILL_PHRASES;
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}
