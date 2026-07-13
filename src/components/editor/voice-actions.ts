// Shared catalog of one-click voice / prose actions for the drafting editor.
// Consumed by both the floating BubbleMenu and the sidecar quick actions.

import type { LucideIcon } from 'lucide-react';
import {
  Wand2,
  Feather,
  Scissors,
  BookText,
  Scale,
  GraduationCap,
  Sparkles,
  Quote,
} from 'lucide-react';

export type VoiceAction = {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  instruction: string;
};

export const VOICE_ACTIONS: VoiceAction[] = [
  {
    key: 'improve',
    label: 'Improve',
    hint: 'Clarity + flow, meaning preserved',
    icon: Wand2,
    instruction:
      'Improve the clarity, precision, and flow of this passage without changing its meaning. Keep every substantive point and any citations intact.',
  },
  {
    key: 'tighten',
    label: 'Tighten',
    hint: 'Shorter, sharper',
    icon: Scissors,
    instruction:
      'Make this passage more concise while preserving every substantive point. Cut hedges and duplicated language; keep any citations intact.',
  },
  {
    key: 'formalize',
    label: 'Formalize',
    hint: 'Elevated litigation register',
    icon: GraduationCap,
    instruction:
      'Rewrite this passage in a more formal, polished litigation register suitable for a federal court filing. Preserve meaning and any citations.',
  },
  {
    key: 'plain',
    label: 'Plain English',
    hint: 'Explain simply',
    icon: BookText,
    instruction:
      'Rewrite this passage in plain English at roughly an 8th-grade reading level, without losing any substantive point. Preserve any citations verbatim.',
  },
  {
    key: 'persuasive',
    label: 'Persuasive',
    hint: 'Advocacy tone',
    icon: Feather,
    instruction:
      'Rewrite this passage in a more persuasive advocacy voice suitable for a plaintiffs’ brief. Keep every fact, citation, and pin cite exactly as written.',
  },
  {
    key: 'neutral',
    label: 'Neutral',
    hint: 'Balanced tone',
    icon: Scale,
    instruction:
      'Rewrite this passage in a neutral, non-argumentative voice suitable for a joint status report. Preserve every fact and citation.',
  },
  {
    key: 'bluebook',
    label: 'Bluebook',
    hint: 'Normalize citations',
    icon: Quote,
    instruction:
      'Normalize any citations in this passage to Bluebook short-form for record orders (e.g., "PTO-12, at 4"), using *Id.* on immediate repeats. Do not change any non-citation prose.',
  },
  {
    key: 'expand',
    label: 'Expand',
    hint: 'Add supporting detail',
    icon: Sparkles,
    instruction:
      'Expand this passage with appropriate detail and supporting reasoning, matching the surrounding style. Do not invent facts or citations.',
  },
];
