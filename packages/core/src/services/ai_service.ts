// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/ai_service.py

/**
 * Base AI service implementation.
 *
 * Provides the foundation for all AI services in the Pipecat framework,
 * including model management, settings handling, and frame processing
 * lifecycle methods.
 */

import { rethrowIfCancelled } from "@pipecat-ts/asyncio";
import {
  CancelFrame,
  EndFrame,
  ErrorFrame,
  type Frame,
  type ServiceMetadataFrame,
  ServiceSwitcherRequestMetadataFrame,
  StartFrame,
} from "../frames/frames.ts";
import { MetricsData } from "../metrics/metrics.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { logger } from "../utils/logger.ts";
import type { TracingContext } from "../utils/tracing/tracing_context.ts";
import { ServiceSettings } from "./settings.ts";

export interface AIServiceOptions extends FrameProcessorOptions {
  /** The runtime-updatable settings for the AI service. */
  settings?: ServiceSettings | null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Base class for all AI services.
 *
 * Provides common functionality for AI services including model management,
 * settings handling, session properties, and frame processing lifecycle.
 * Subclasses should implement specific AI functionality while leveraging
 * this base infrastructure.
 */
export class AIService extends FrameProcessor {
  protected _settings: ServiceSettings;
  protected _sessionProperties: Record<string, unknown> = {};
  protected _tracingEnabled = false;
  protected _tracingContext: TracingContext | null = null;

  /**
   * Initialize the AI service.
   *
   * @param options.settings The runtime-updatable settings for the AI service.
   *   Other options are passed to the parent FrameProcessor.
   */
  constructor(options: AIServiceOptions = {}) {
    super(options);
    this._settings =
      options.settings ||
      // Here in case subclass doesn't implement more specific settings
      // (which hopefully should be rare)
      new ServiceSettings();
    this._syncModelNameToMetrics();
  }

  /**
   * The service's current settings, for reading.
   *
   * Change them with a `ServiceUpdateSettingsFrame`, so the service applies
   * the change and its metrics keep the model in sync.
   */
  get settings(): ServiceSettings {
    return this._settings;
  }

  /**
   * Sync the current AI model name (in `this._settings.model`) for usage in
   * metrics.
   *
   * We don't store model name here because there's already a single source
   * of truth for it in `this._settings.model`. This method is just for
   * syncing the model name to the metrics data.
   */
  protected _syncModelNameToMetrics(): void {
    const model: unknown = this._settings.model;
    this.setCoreMetricsData(
      new MetricsData({ processor: this.name, model: typeof model === "string" ? model : "" }),
    );
  }

  /**
   * The metadata frame this service broadcasts at start, or null.
   *
   * Override to return a populated `ServiceMetadataFrame` (or a subtype such
   * as `STTMetadataFrame`) describing this service for downstream processors,
   * for example the `userTurnStrategies` an STT with server-side end-of-turn
   * detection recommends. Return null to broadcast nothing.
   *
   * @returns The metadata frame to broadcast, or null.
   */
  serviceMetadataFrame(): ServiceMetadataFrame | null {
    return null;
  }

  /** Broadcast this service's metadata frame, if any. */
  async broadcastServiceMetadata(): Promise<void> {
    const frame = this.serviceMetadataFrame();
    if (frame) {
      await this.broadcastFrameInstance(frame);
    }
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._tracingEnabled = setup.enableTracing;
    this._tracingContext = setup.tracingContext;
  }

  /**
   * Start the AI service.
   *
   * Called when the service should begin processing. Subclasses should
   * override this method to perform service-specific initialization.
   *
   * @param _frame The start frame containing initialization parameters.
   */
  async start(_frame: StartFrame): Promise<void> {
    this._settings.validateComplete();
  }

  /**
   * Stop the AI service on a graceful end (`EndFrame`).
   *
   * Runs in frame order, after pending frames drain. Override for graceful
   * shutdown behavior, such as flushing in-flight work before stopping.
   *
   * @param _frame The end frame.
   */
  async stop(_frame: EndFrame): Promise<void> {}

  /**
   * Cancel the AI service immediately (`CancelFrame`).
   *
   * Runs at once, ahead of any queued frames, to abort active work fast (for
   * example, stop producing audio now). Override only for that time-sensitive
   * subset.
   *
   * @param _frame The cancel frame.
   */
  async cancel(_frame: CancelFrame): Promise<void> {}

  /**
   * Apply a settings delta and return the changed fields.
   *
   * The delta is applied to `_settings` and a record mapping each changed
   * field name to its **pre-update** value is returned. The `model` field is
   * handled specially: when it changes, the model name is synced to metrics.
   *
   * Concrete services should override this method (calling `super`) to react
   * to specific changed fields (e.g. reconnect on voice change).
   *
   * @param delta A delta-mode settings object.
   * @returns Record mapping changed field names to their previous values.
   */
  protected async _updateSettings(delta: ServiceSettings): Promise<Record<string, unknown>> {
    const changed = this._settings.applyUpdate(delta);
    const changedFields = Object.keys(changed);

    if ("model" in changed) {
      this._syncModelNameToMetrics();
    }

    if (changedFields.length > 0) {
      logger.info(
        `${this.name}: updated settings fields: {${changedFields.map((f) => `'${f}'`).join(", ")}}`,
      );
      // New settings may be the ones that make the service work, so give
      // it another chance rather than leaving it permanently written off.
      await this.setUsable(true);
    }

    return changed;
  }

  /**
   * Log a warning for settings changes that won't take effect at runtime.
   *
   * Convenience helper for `_updateSettings` overrides. Accepts any iterable
   * of field names (an array, a set, a record's keys, etc.) or a record.
   *
   * @param unhandled Field names that changed but are not applied.
   */
  protected _warnUnhandledUpdatedSettings(
    unhandled: Iterable<string> | Record<string, unknown>,
  ): void {
    const names =
      typeof (unhandled as Iterable<string>)[Symbol.iterator] === "function"
        ? [...(unhandled as Iterable<string>)]
        : Object.keys(unhandled);
    if (names.length > 0) {
      // Python's sorted() on strings compares code points, like the default sort.
      const fields = names.sort().join(", ");
      logger.warning(`${this.name}: runtime update of [${fields}] is not currently supported`);
    }
  }

  /**
   * Push a frame and broadcast service metadata once the service starts.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await super.pushFrame(frame, direction);

    // Broadcast metadata after StartFrame goes downstream, so downstream sees
    // StartFrame first.
    if (frame instanceof StartFrame) {
      await this.broadcastServiceMetadata();
    }
  }

  /**
   * Process frames and handle service lifecycle.
   *
   * Automatically handles StartFrame, EndFrame, and CancelFrame by calling
   * the appropriate lifecycle methods.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this._start(frame);
    } else if (frame instanceof EndFrame) {
      await this._stop(frame);
    } else if (frame instanceof CancelFrame) {
      await this._cancel(frame);
    } else if (frame instanceof ServiceSwitcherRequestMetadataFrame) {
      await this.broadcastServiceMetadata();
    }
  }

  /**
   * Process frames from an async generator.
   *
   * Takes an async generator that yields frames and processes each one,
   * handling error frames specially by pushing them as errors.
   *
   * @param generator An async generator that yields Frame objects or null.
   */
  async processGenerator(generator: AsyncIterable<Frame | null | undefined>): Promise<void> {
    for await (const f of generator) {
      if (f) {
        if (f instanceof ErrorFrame) {
          await this.pushErrorFrame(f);
        } else {
          await this.pushFrame(f);
        }
      }
    }
  }

  protected async _start(frame: StartFrame): Promise<void> {
    try {
      await this.start(frame);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this}: exception processing ${frame}: ${errorMessage(e)}`);
    }
  }

  protected async _stop(frame: EndFrame): Promise<void> {
    try {
      await this.stop(frame);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this}: exception processing ${frame}: ${errorMessage(e)}`);
    }
  }

  protected async _cancel(frame: CancelFrame): Promise<void> {
    try {
      await this.cancel(frame);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this}: exception processing ${frame}: ${errorMessage(e)}`);
    }
  }
}
