// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Smart Turn v2 on Workers AI (`@cf/pipecat-ai/smart-turn-v2`).
 *
 * A turn analyzer like core's `HttpSmartTurnAnalyzer`, whose model runs on
 * Workers AI: the base class buffers the user's audio and, when the VAD sees
 * a pause, sends the last segment (at most `maxDurationSecs`) as float32
 * samples. Workers AI answers `{ is_complete, probability }`.
 *
 * Smart Turn v2 was trained on 16 kHz audio, so run the pipeline input at
 * 16 kHz. The newer Smart Turn v3.2 runs locally (also on Workers) with
 * `createLocalSmartTurnAnalyzerV3` from `@pipedog/audio-smart-turn`.
 */

import { currentSignal, rethrowIfCancelled, TimeoutError, waitFor } from "@pipedog/asyncio";
import {
  BaseSmartTurn,
  type BaseSmartTurnOptions,
  type SmartTurnPrediction,
  SmartTurnTimeoutException,
} from "@pipedog/core/audio/turn/smart_turn/base_smart_turn";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import {
  splitConnectionOptions,
  type WorkersAIClient,
  type WorkersAIConnectionOptions,
} from "./client.ts";

/** The Smart Turn model on Workers AI. */
export const WORKERS_AI_SMART_TURN_MODEL = "@cf/pipecat-ai/smart-turn-v2";

/** The sample rate Smart Turn v2 was trained on. */
export const SMART_TURN_V2_SAMPLE_RATE = 16000;

export interface WorkersAISmartTurnAnalyzerOptions
  extends BaseSmartTurnOptions,
    WorkersAIConnectionOptions {
  /** The Workers AI model ID. Defaults to `"@cf/pipecat-ai/smart-turn-v2"`. */
  model?: string;
}

/** Float32 samples as little-endian bytes. */
function float32Bytes(audio: Float32Array): Uint8Array {
  const out = new Uint8Array(audio.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < audio.length; i++) view.setFloat32(i * 4, audio[i] as number, true);
  return out;
}

/**
 * End-of-turn detection with Smart Turn v2 on Workers AI.
 *
 * Use it as a turn analyzer, as you would `HttpSmartTurnAnalyzer`. A request
 * that takes longer than `params.stopSecs` counts as the end of the turn; a
 * failed request counts as "not complete", so the silence timeout ends the turn.
 *
 * @example
 * const turnAnalyzer = new WorkersAISmartTurnAnalyzer({ ai: env.AI });
 */
export class WorkersAISmartTurnAnalyzer extends BaseSmartTurn {
  protected _workersAI: WorkersAIClient;
  protected _model: string;
  #warnedSampleRate = false;

  constructor(options: WorkersAISmartTurnAnalyzerOptions) {
    const [client, { model, ...rest }] = splitConnectionOptions(options);
    super(rest);
    this._workersAI = client;
    this._model = model ?? WORKERS_AI_SMART_TURN_MODEL;
  }

  /** The client the analyzer reaches Workers AI with. */
  get workersAI(): WorkersAIClient {
    return this._workersAI;
  }

  /** Ask Workers AI whether the turn is complete. */
  protected async _sendRequest(audioArray: Float32Array): Promise<SmartTurnPrediction> {
    const totalSecs = this._params.stopSecs;
    let result: Record<string, unknown>;
    try {
      result = await waitFor(
        () =>
          this._workersAI.run(this._model, {
            audio: bytesToBase64(float32Bytes(audioArray)),
            dtype: "float32",
          }),
        totalSecs,
      );
    } catch (e) {
      if (e instanceof TimeoutError && !currentSignal().aborted) {
        logger.error(`Request timed out after ${totalSecs} seconds`);
        throw new SmartTurnTimeoutException(`Request exceeded ${totalSecs} seconds.`);
      }
      throw e;
    }
    const isComplete = result.is_complete === true;
    const probability = typeof result.probability === "number" ? result.probability : 0.0;
    return { prediction: isComplete ? 1 : 0, probability, result };
  }

  /** Predict end-of-turn with the model on Workers AI. */
  protected override async _predictEndpoint(
    audioArray: Float32Array,
  ): Promise<SmartTurnPrediction> {
    if (this.sampleRate !== SMART_TURN_V2_SAMPLE_RATE && !this.#warnedSampleRate) {
      this.#warnedSampleRate = true;
      logger.warning(
        `${this.constructor.name}: Smart Turn v2 expects ${SMART_TURN_V2_SAMPLE_RATE} Hz audio, ` +
          `got ${this.sampleRate} Hz`,
      );
    }
    try {
      return await this._sendRequest(audioArray);
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof SmartTurnTimeoutException) throw e;
      logger.error(`Smart turn prediction failed: ${e instanceof Error ? e.message : String(e)}`);
      // Return an incomplete prediction when a failure occurs
      return {
        prediction: 0,
        probability: 0.0,
        metrics: { inference_time: 0.0, total_time: 0.0 },
      };
    }
  }
}
