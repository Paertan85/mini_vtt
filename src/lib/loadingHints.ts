// Loading hints: short D&D 5e (2024 rules) reminders the player screen can show
// along the bottom of the slideshow or blackout while the DM gets the next map
// ready. Like the kill screen, the main process only lets these lines through,
// so the player screen never shows text from anywhere else.
//
// Each hint is short enough to read across the table on a TV laid flat.
//
// Pure data and functions, no DOM or Node access.

export const LOADING_HINTS: readonly string[] = [
  // Actions
  'Dodge: attacks against you have Disadvantage, and you make Dex saves with Advantage.',
  'Disengage: your movement provokes no Opportunity Attacks for the rest of the turn.',
  'Help: an ally’s next attack against an enemy within 5 ft of you has Advantage.',
  'Ready: pick a trigger and an action. When it happens, you act with your Reaction.',
  'A readied spell needs Concentration until it is released.',
  'Hide: a DC 15 Dex (Stealth) check, out of sight and behind cover. Success makes you Invisible.',
  'Study: an Intelligence check to recall what you know about a creature, place or object.',
  'Bonus Actions only come from a feature, spell or item that gives you one.',
  'Drinking a Potion of Healing, or giving it to someone within 5 ft, is a Bonus Action.',
  'One free object interaction each turn: draw a sword, open a door, pick up a torch.',
  'You can draw or stow one weapon with each attack you make with the Attack action.',

  // Movement
  'You can split your movement: move, act, then move the rest of the way.',
  'Difficult Terrain: every foot costs 1 extra foot of movement.',
  'Standing up from Prone costs half your Speed.',
  'You can move through an ally’s space, but you can’t end your move there.',
  'Opportunity Attack: when a creature you can see leaves your reach, make one melee attack with your Reaction.',
  'Your Reaction comes back at the start of your turn.',
  'Long jump: your Strength score in feet with a 10 ft run-up, half that standing still.',
  'High jump: 3 + your Strength modifier in feet with a 10 ft run-up, half that standing still.',
  'Falling: 1d6 Bludgeoning per 10 ft fallen (max 20d6), and you land Prone.',

  // Attacks
  'A natural 20 on an attack roll always hits and is a Critical Hit.',
  'A natural 1 on an attack roll always misses.',
  'Critical Hit: roll the attack’s damage dice twice, then add modifiers once.',
  'Advantage and Disadvantage don’t stack. One of each cancels out.',
  'A ranged attack with an enemy within 5 ft of you is made at Disadvantage.',
  'Shooting past normal range, out to long range, gives Disadvantage.',
  'Half cover: +2 to AC and Dex saves. Three-quarters cover: +5.',
  'Grapple and Shove are Unarmed Strikes: the target makes a Str or Dex save against your DC.',
  'Grappled? Use your action for an Athletics or Acrobatics check against the escape DC.',
  'Light weapons: after attacking with one, attack with another Light weapon as a Bonus Action.',

  // Conditions
  'Prone: attacks from within 5 ft have Advantage against you, from farther away Disadvantage.',
  'Unconscious or Paralyzed: any hit from within 5 ft is a Critical Hit.',
  'Restrained: Speed 0, Disadvantage on your attacks and Dex saves, attacks against you have Advantage.',
  'Frightened: Disadvantage on checks and attacks while you can see the source, and you can’t move closer.',
  'Poisoned: Disadvantage on attack rolls and ability checks.',
  'Exhaustion: each level is −2 to every d20 Test and −5 ft of Speed. A Long Rest removes one.',
  'Invisible: your attacks have Advantage, attacks against you have Disadvantage.',
  'Darkvision sees darkness as Dim Light, so Perception by sight still has Disadvantage there.',

  // Spells
  'You can spend only one spell slot on spells each turn. Cantrips are still fine.',
  'Concentration: take damage, make a Con save, DC 10 or half the damage, whichever is higher.',
  'Casting a new Concentration spell ends the one you were concentrating on.',
  'Ritual spells can be cast without a slot by taking 10 minutes longer.',
  'Damage cantrips grow stronger at levels 5, 11 and 17.',

  // Hit points and resting
  'Death saves: DC 10. Three successes and you are stable, three failures and you die.',
  'A natural 20 on a death save: you regain 1 Hit Point. A natural 1 counts as two failures.',
  'Any healing at 0 Hit Points wakes you up, though you are still Prone.',
  'Temporary Hit Points don’t stack. Keep the larger amount.',
  'Resistance halves damage, Vulnerability doubles it.',
  'Short Rest: one hour, and you can spend Hit Dice to heal.',
  'Long Rest: regain all Hit Points and all spent Hit Dice.',
  'Heroic Inspiration: reroll any one die right after rolling it, and use the new roll.',
  'Surprised creatures roll Initiative with Disadvantage.',
];

export const isLoadingHint = (value: unknown): value is string =>
  typeof value === 'string' && LOADING_HINTS.includes(value);

/** A random hint, other than the last one shown when there is a choice. */
export function pickLoadingHint(previous: string | null, random: () => number = Math.random): string {
  const choices =
    LOADING_HINTS.length > 1 ? LOADING_HINTS.filter((hint) => hint !== previous) : LOADING_HINTS;
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}
