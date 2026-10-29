// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/expressive/instructions.py

/**
 * The instruction that teaches an LLM to take part in expressive conversation.
 *
 * Part of expressive conversation (alpha). The instruction has three parts: how
 * to read what was perceived of how the user spoke, built from a perception
 * producer's `PerceptionCapabilities`; the tags the active TTS service can
 * perform, by their universal names, built from its `ExpressionCapabilities`;
 * and the developer's guidance on how to answer, from an `ExpressionPolicy`.
 *
 * **Alpha.** The tag syntax and these types are likely to change between releases.
 */

import {
  CORE_DELIVERY,
  CORE_SOUNDS,
  type ExpressionCapabilities,
  ExpressionTerm,
  NEUTRAL_DELIVERY,
  SLOW_DELIVERY,
} from "./expression.ts";
import {
  formatPerception,
  type PerceptionCapabilities,
  PerceptionSignal,
  type PerceptionTerm,
} from "./perception.ts";
import { ExpressionGuidance, ExpressionPolicy } from "./policy.ts";

export interface ExpressionInstructionsOptions {
  /** The signals perceived of how the user spoke, or null when nothing is perceived. */
  perception?: PerceptionCapabilities | null;
}

/**
 * Build the instruction for an LLM in an expressive conversation.
 *
 * @param capabilities What the TTS service that speaks the LLM's replies can
 *   perform, or null for nothing.
 * @param policy Which tags to offer, and guidance on how to answer.
 * @returns The instruction, or null when nothing is perceived and the TTS
 *   service can perform none of the tags offered.
 */
export function expressionInstructions(
  capabilities: ExpressionCapabilities | null,
  policy: ExpressionPolicy | null = null,
  options: ExpressionInstructionsOptions = {},
): string | null {
  const resolvedPolicy = policy ?? new ExpressionPolicy();
  const tags = tagsSection(capabilities, resolvedPolicy);
  const parts = [perceptionSection(options.perception ?? null), tags].filter(
    (part): part is string => Boolean(part),
  );
  if (parts.length === 0) {
    return null;
  }
  // The presets are about tags, so an LLM taught none isn't given them.
  const guidance = resolvedPolicy.guidance.filter(
    (line) => tags || !(line instanceof ExpressionGuidance),
  );
  if (guidance.length > 0) {
    parts.push(guidance.map((line) => String(line)).join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Tell what an expression policy asks for that a TTS service can't perform.
 *
 * @param capabilities What the TTS service can perform, or null for nothing.
 * @param policy Which tags to offer, and guidance on how to answer.
 * @returns The warning, or null when there's no policy or the service can
 *   perform every tag it offers.
 */
export function expressionPolicyWarning(
  capabilities: ExpressionCapabilities | null,
  policy: ExpressionPolicy | null,
): string | null {
  if (policy === null) {
    return null;
  }
  if (capabilities === null || tagsSection(capabilities, policy) === null) {
    return (
      "the TTS service performs none of the expression policy's tags, so they " +
      "and its guidance presets aren't taught"
    );
  }
  const left = leftOut(capabilities, policy);
  if (left.length > 0) {
    return (
      `the TTS service can't perform ${left.join(", ")} from the expression ` +
      "policy, so they aren't offered"
    );
  }
  return null;
}

function perceptionSection(perception: PerceptionCapabilities | null): string | null {
  if (!perception || perception.signals.length === 0) {
    return null;
  }
  let suchAs = "";
  const example = perception.signals.find((term) => term.labels.length >= 2);
  if (example) {
    const labels: [string, number][] = [
      [example.labels[0] as string, 0.86],
      [example.labels[1] as string, 0.1],
    ];
    suchAs = ` such as ${formatPerception([new PerceptionSignal({ name: example.name, labels })])},`;
  }
  const signals = perception.signals.map((term) => signalLine(term)).join("\n");
  return (
    `A user message may start with how the user sounded, in parentheses,${suchAs} each ` +
    "signal with its likeliest labels and how sure the reading is, from 0 to 1, or with a " +
    "measure. The reading can be wrong, so weigh it against their words. A reading below " +
    `0.5 is a guess: don't act on it. Never write it yourself. The signals are:\n${signals}`
  );
}

function signalLine(term: PerceptionTerm): string {
  if (term.labels.length === 0) {
    return `- ${term.name}: ${(term.description || "a measure").replace(/\.+$/, "")}.`;
  }
  const line = `- ${term.name}: ${term.labels.join(", ")}.`;
  return term.description ? `${line} ${term.description}` : line;
}

function tagsSection(
  capabilities: ExpressionCapabilities | null,
  policy: ExpressionPolicy,
): string | null {
  if (capabilities === null) {
    return null;
  }
  const tags: string[] = [];
  const delivery = offered(
    policy.delivery,
    CORE_DELIVERY,
    (name) => capabilities.deliveryName(name),
    capabilities.delivery,
  )
    // Taught on its own, as the return to the voice's baseline.
    .filter((term) => term.name !== NEUTRAL_DELIVERY);
  if (delivery.length > 0) {
    tags.push(
      "- <<delivery>> at the start of a sentence speaks it, and the sentences after it, " +
        "with that delivery, until the next delivery tag. <<neutral>> returns to your " +
        "normal voice. " +
        choices("deliveries", delivery, (name) => `<<${name}>>`),
    );
    // A real span shows that its delivery comes before the colon and the
    // words to speak after it. Written with placeholders, a span reads as a
    // label and its value, as in <<delivery: sympathetic>>.
    const example = spanExample(delivery);
    tags.push(
      `- <<${example}: A B 7>> speaks just the words after the colon, A B 7, with the ` +
        `delivery before it, ${example}, on top of the delivery around them, and then goes ` +
        "back to it. Keep it to a few words.",
    );
  }
  // A breath is offered by default only to a policy that asks for breaths.
  const breathe = policy.guidance.some((line) => String(line) === ExpressionGuidance.BREATHE.value);
  const coreSounds = CORE_SOUNDS.filter((s) => s !== "breath" || breathe);
  const sounds = offered(
    policy.sounds,
    coreSounds,
    (name) => capabilities.soundName(name),
    capabilities.sounds,
  );
  if (sounds.length > 0) {
    tags.push(
      `- [[sound]] makes a sound at that point. ${choices("sounds", sounds, (name) => `[[${name}]]`)}`,
    );
  }
  if (capabilities.emphasis) {
    tags.push("- ^^word^^ stresses a word.");
  }
  if (capabilities.pauseRangeMs) {
    tags.push("- [[pause 500]] pauses for about that many milliseconds.");
  }
  if (tags.length === 0) {
    return null;
  }
  return `You can direct how your words are spoken with tags:\n${tags.join("\n")}`;
}

/** The policy's tags the service can't perform, each as it would be written. */
function leftOut(capabilities: ExpressionCapabilities, policy: ExpressionPolicy): string[] {
  const tags = (policy.delivery ?? [])
    // Every service returns to its baseline: neutral is taught on its own.
    .filter((name) => name !== NEUTRAL_DELIVERY && capabilities.deliveryName(name) === null)
    .map((name) => `<<${name}>>`);
  tags.push(
    ...(policy.sounds ?? [])
      .filter((name) => capabilities.soundName(name) === null)
      .map((name) => `[[${name}]]`),
  );
  return tags;
}

/**
 * The names to offer: the policy's, or the core ones, that the service performs.
 *
 * Each is offered with the description the service gives the name it performs it by.
 */
function offered(
  names: readonly string[] | null,
  core: readonly string[],
  performedName: (name: string) => string | null,
  declared: ExpressionTerm[],
): ExpressionTerm[] {
  const descriptions = new Map(declared.map((term) => [term.name, term.description]));
  const result: ExpressionTerm[] = [];
  for (const name of names === null ? core : names) {
    const performed = performedName(name);
    if (performed !== null) {
      result.push(new ExpressionTerm({ name, description: descriptions.get(performed) ?? "" }));
    }
  }
  return result;
}

/** The delivery a span is shown with: slow, for details, unless only others are listed. */
function spanExample(delivery: ExpressionTerm[]): string {
  const names = delivery.map((term) => term.name);
  return names.length > 0 && !names.includes(SLOW_DELIVERY) ? (names[0] as string) : SLOW_DELIVERY;
}

/** The terms offered, each written as its tag, as in `<<calm>>` or `[[laugh]]`. */
function choices(kind: string, terms: ExpressionTerm[], tag: (name: string) => string): string {
  const termText = (term: ExpressionTerm): string => {
    const name = tag(term.name);
    return term.description ? `${name} (${term.description})` : name;
  };
  const listed = terms.map((term) => termText(term)).join(", ");
  return (
    `Use only these ${kind}, written exactly as listed: ${listed}. ` +
    "Any other word in a tag is ignored, so if none fits, write no tag."
  );
}
