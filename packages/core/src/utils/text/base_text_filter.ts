// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/base_text_filter.py

/**
 * Base text filter interface for Pipecat text processing.
 *
 * This module defines the abstract base class for text filters that can
 * modify text content in the processing pipeline, including support for
 * settings updates and interruption handling.
 */

/**
 * Abstract base class for text filters in the Pipecat framework.
 *
 * Text filters are responsible for modifying text content as it flows through
 * the processing pipeline. They support dynamic settings updates and can
 * handle interruptions to reset their internal state.
 *
 * Subclasses must implement all abstract methods to define specific filtering
 * behavior, settings management, and interruption handling logic.
 */
export abstract class BaseTextFilter {
  // Accepted (and ignored) so subclasses can forward `**kwargs` as upstream does.
  constructor(_options: object = {}) {}

  /**
   * Update the filter's configuration settings.
   *
   * Subclasses should implement this method to handle dynamic configuration
   * updates during runtime, updating internal state as needed.
   *
   * @param settings Dictionary of setting names to values for configuration.
   */
  async updateSettings(_settings: Readonly<Record<string, unknown>>): Promise<void> {}

  /**
   * Apply filtering transformations to the input text.
   *
   * Subclasses must implement this method to define the specific text
   * transformations that should be applied to the input.
   *
   * @param text The input text to be filtered.
   * @returns The filtered text after applying transformations.
   */
  abstract filter(text: string): Promise<string>;

  /**
   * Handle interruption events in the processing pipeline.
   *
   * Subclasses should implement this method to reset internal state, clear
   * buffers, or perform other cleanup when an interruption occurs.
   */
  async handleInterruption(): Promise<void> {}

  /**
   * Reset the filter state after an interruption has been handled.
   *
   * Subclasses should implement this method to restore the filter to normal
   * operation after an interruption has been processed and resolved.
   */
  async resetInterruption(): Promise<void> {}
}
