// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/turn/smart_turn/http_smart_turn.py

/**
 * HTTP-based smart turn analyzer for remote ML inference.
 *
 * Sends audio data to a remote HTTP endpoint for ML-based end-of-turn
 * detection. Runs on Bun, Node, Deno and Cloudflare Workers: it only needs
 * `fetch`.
 *
 * PORTING NOTES:
 * - DIVERGENCE: upstream takes an `aiohttp.ClientSession`. Here the optional
 *   `fetch` option takes any `fetch`-compatible function (default: the global
 *   `fetch`).
 * - The request body is a NumPy `.npy` (format 1.0) file written by hand
 *   (`np.save`): a little-endian float32 vector, as upstream sends.
 * - Upstream's `_predict_endpoint` catches every exception (including
 *   `SmartTurnTimeoutException`) and returns an incomplete prediction; so does this.
 */

import { currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  BaseSmartTurn,
  type BaseSmartTurnOptions,
  type SmartTurnPrediction,
  SmartTurnTimeoutException,
} from "@pipedog/core/audio/turn/smart_turn/base_smart_turn";
import { logger } from "@pipedog/core/utils/logger";

export interface HttpSmartTurnAnalyzerOptions extends BaseSmartTurnOptions {
  /** HTTP endpoint URL for the smart turn ML service. */
  url: string;
  /** Optional HTTP headers to include in requests. */
  headers?: Record<string, string> | null;
  /** A `fetch`-compatible function (default: the global `fetch`). */
  fetch?: typeof fetch | null;
}

/**
 * Serialize an audio array as a NumPy `.npy` file (format 1.0, `<f4`, 1-D).
 *
 * Equivalent to `np.save(buffer, audio_array)` for a float32 vector.
 */
export function serializeNpy(audioArray: Float32Array): Uint8Array {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${audioArray.length},), }`;
  // magic (6) + version (2) + header length (2) + header + "\n", padded to 64 bytes.
  const unpadded = 10 + header.length + 1;
  const padding = (64 - (unpadded % 64)) % 64;
  const headerText = `${header}${" ".repeat(padding)}\n`;
  const out = new Uint8Array(10 + headerText.length + audioArray.length * 4);
  const view = new DataView(out.buffer);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]); // "\x93NUMPY", version 1.0
  view.setUint16(8, headerText.length, true);
  for (let i = 0; i < headerText.length; i++) out[10 + i] = headerText.charCodeAt(i);
  const dataStart = 10 + headerText.length;
  for (let i = 0; i < audioArray.length; i++) {
    view.setFloat32(dataStart + i * 4, audioArray[i] as number, true);
  }
  return out;
}

/**
 * Smart turn analyzer using HTTP-based ML inference.
 *
 * Sends audio data to remote HTTP endpoints for ML-based end-of-turn
 * prediction. Handles serialization, HTTP communication, and error recovery.
 */
export class HttpSmartTurnAnalyzer extends BaseSmartTurn {
  #url: string;
  #headers: Record<string, string>;
  #fetch: typeof fetch;

  /**
   * @param options Analyzer options. `url` is the endpoint; `headers` are extra
   *   request headers; `fetch` replaces the global `fetch`; the rest goes to BaseSmartTurn.
   */
  constructor(options: HttpSmartTurnAnalyzerOptions) {
    super(options);
    this.#url = options.url;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** Serialize the audio array to bytes for HTTP transmission. */
  protected _serializeArray(audioArray: Float32Array): Uint8Array {
    logger.trace("Serializing NumPy array to bytes...");
    const serialized = serializeNpy(audioArray);
    logger.trace(`Serialized size: ${serialized.length} bytes`);
    return serialized;
  }

  /** Send raw audio data to the HTTP endpoint for prediction. */
  protected async _sendRawRequest(dataBytes: Uint8Array): Promise<SmartTurnPrediction> {
    const headers = { "Content-Type": "application/octet-stream", ...this.#headers };
    const totalSecs = this._params.stopSecs;
    const timeoutSignal = AbortSignal.timeout(totalSecs * 1000);
    const signal = AbortSignal.any([currentSignal(), timeoutSignal]);

    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        body: dataBytes as BodyInit,
        headers,
        signal,
      });
      logger.trace("\n--- Response ---");
      logger.trace(`Status Code: ${response.status}`);

      // Check if successful
      if (response.status !== 200) {
        const errorText = await response.text();
        logger.trace("Response Content (Error):");
        logger.trace(errorText);

        if (response.status === 500) {
          logger.warning(`Smart turn service returned 500 error: ${errorText}`);
          throw new Error(`Server returned HTTP 500: ${errorText}`);
        }
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorText}`);
      }

      // Process successful response
      const text = await response.text();
      try {
        const jsonData = JSON.parse(text) as SmartTurnPrediction;
        logger.trace("Response JSON:");
        logger.trace(text);
        return jsonData;
      } catch (e) {
        rethrowIfCancelled(e);
        // Non-JSON response
        logger.trace("Response Content (non-JSON):");
        logger.trace(text);
        throw new Error(`Non-JSON response: ${text}`);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (timeoutSignal.aborted && !currentSignal().aborted) {
        logger.error(`Request timed out after ${totalSecs} seconds`);
        throw new SmartTurnTimeoutException(`Request exceeded ${totalSecs} seconds.`);
      }
      if (e instanceof TypeError) {
        // fetch rejects with a TypeError on network failure (aiohttp.ClientError).
        logger.error(`Failed to send raw request to Daily Smart Turn: ${e}`);
        throw new Error("Failed to send raw request to Daily Smart Turn.");
      }
      throw e;
    }
  }

  /** Predict end-of-turn using the remote HTTP ML service. */
  protected override async _predictEndpoint(
    audioArray: Float32Array,
  ): Promise<SmartTurnPrediction> {
    try {
      const serializedArray = this._serializeArray(audioArray);
      return await this._sendRawRequest(serializedArray);
    } catch (e) {
      rethrowIfCancelled(e);
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
