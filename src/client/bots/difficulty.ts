// Difficulty = the same brain with different settings. Every bot sees and acts exactly
// like a player (the snapshot in, input messages out); a level only changes how quickly
// and how well it uses that.

export type Difficulty = 'easy' | 'normal' | 'hard';

export type BotProfile = {
  /** How often it re-decides what to do (target, behavior). Path following is every step. */
  thinkMs: number;
  /** After lining up on a target, how long before it fires (min, max; drawn per shot). */
  reactionMs: [number, number];
  /** How closely it lines up (distance off the target's center) before it fires. A bullet
   * hits within the player radius (0.5) of the center, so this trades hits for speed. */
  alignTolerance: number;
  /** Chance it sidesteps a bullet heading at it (decided once per bullet). */
  dodgeChance: number;
  /** Chance it steps out of an enemy's firing line when it can't shoot first. */
  evadeChance: number;
  /** Who it goes after: the nearest; the nearest it can shoot now; or whoever it can line up on soonest. */
  targeting: 'nearest' | 'shootable' | 'exposed';
};

export const DIFFICULTY: Record<Difficulty, BotProfile> = {
  easy: { thinkMs: 300, reactionMs: [400, 700], alignTolerance: 0.45, dodgeChance: 0, evadeChance: 0, targeting: 'nearest' },
  normal: { thinkMs: 150, reactionMs: [200, 350], alignTolerance: 0.3, dodgeChance: 0.5, evadeChance: 0.3, targeting: 'shootable' },
  hard: { thinkMs: 60, reactionMs: [80, 150], alignTolerance: 0.2, dodgeChance: 0.9, evadeChance: 0.7, targeting: 'exposed' },
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
