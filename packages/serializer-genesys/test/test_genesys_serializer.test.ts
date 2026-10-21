// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/genesys/test_genesys_serializer.py

/**
 * Tests for the Genesys AudioHook serializer.
 *
 * The pytest fixtures of upstream's tests/genesys/conftest.py are the
 * functions below, each returning a fresh message.
 */

import { describe, expect, test } from "bun:test";

import { InputDTMFFrame, OutputTransportMessageUrgentFrame } from "@pipedog/core/frames/frames";

import { AudioHookChannel, GenesysAudioHookSerializer } from "../src/genesys.ts";

type Any = any;

// ==================== Fixtures (tests/genesys/conftest.py) ====================

/** Sample AudioHook open message from Genesys. */
function sampleOpenMessage(): Any {
  return {
    version: "2",
    type: "open",
    seq: 1,
    id: "test-session-123",
    parameters: {
      conversationId: "conv-456",
      participant: {
        ani: "+1234567890",
        dnis: "+0987654321",
      },
      media: [
        {
          type: "audio",
          format: "PCMU",
          channels: ["external"],
          rate: 8000,
        },
      ],
    },
  };
}

/** Sample AudioHook open message with custom inputVariables from Genesys. */
function sampleOpenMessageWithInputVariables(): Any {
  const message = sampleOpenMessage();
  message.parameters.inputVariables = {
    customer_id: "cust-789",
    queue_name: "billing",
    priority: "high",
    language: "es-ES",
  };
  return message;
}

/** Sample AudioHook ping message. */
function samplePingMessage(): Any {
  return { version: "2", type: "ping", seq: 5, id: "test-session-123", position: "PT10.5S" };
}

/** Sample AudioHook close message from Genesys. */
function sampleCloseMessage(): Any {
  return {
    version: "2",
    type: "close",
    seq: 10,
    id: "test-session-123",
    position: "PT30.0S",
    parameters: { reason: "disconnect" },
  };
}

/** Sample AudioHook pause message. */
function samplePauseMessage(): Any {
  return {
    version: "2",
    type: "pause",
    seq: 7,
    id: "test-session-123",
    position: "PT15.0S",
    parameters: { reason: "hold" },
  };
}

/** Sample AudioHook update message. */
function sampleUpdateMessage(): Any {
  return {
    version: "2",
    type: "update",
    seq: 8,
    id: "test-session-123",
    position: "PT20.0S",
    parameters: {
      participant: {
        ani: "+1234567890",
        dnis: "+0987654321",
        name: "John Doe",
      },
    },
  };
}

/** Sample AudioHook error message. */
function sampleErrorMessage(): Any {
  return {
    version: "2",
    type: "error",
    seq: 9,
    id: "test-session-123",
    parameters: { code: 500, message: "Internal server error" },
  };
}

/** Sample AudioHook DTMF message with the given digit. */
function sampleDtmfMessage(digit = "5"): Any {
  return {
    version: "2",
    type: "dtmf",
    seq: 6,
    id: "test-session-123",
    position: "PT12.0S",
    parameters: { digit },
  };
}

/** Protected state the upstream tests set directly (`serializer._is_open = True`). */
function internals(serializer: GenesysAudioHookSerializer): {
  _isOpen: boolean;
  _isPaused: boolean;
} {
  return serializer as unknown as { _isOpen: boolean; _isPaused: boolean };
}

describe("TestGenesysAudioHookSerializer", () => {
  // ==================== Initialization Tests ====================

  test("test_create_serializer_default_params", () => {
    // Test creating serializer with default parameters.
    const serializer = new GenesysAudioHookSerializer();

    // session_id is auto-generated as UUID
    expect(serializer.sessionId).not.toEqual("");
    expect(serializer.sessionId).toHaveLength(36); // UUID format
    expect(serializer.isOpen).toBe(false);
    expect(serializer.isPaused).toBe(false);
  });

  test("test_create_serializer_with_custom_params", () => {
    // Test creating serializer with custom parameters.
    const params = new GenesysAudioHookSerializer.InputParams({
      channel: AudioHookChannel.BOTH,
      sampleRate: 16000,
      supportedLanguages: ["es-ES", "en-US"],
      selectedLanguage: "es-ES",
      startPaused: true,
    });
    const serializer = new GenesysAudioHookSerializer({ params });

    expect(serializer.sessionId).not.toEqual("");
  });

  // ==================== Response Creation Tests ====================

  test("test_create_opened_response", () => {
    // Test creating an opened response message.
    const serializer = new GenesysAudioHookSerializer();

    const msg = serializer.createOpenedResponse();

    expect(msg.type).toEqual("opened");
    expect(msg.version).toEqual("2");
    expect(msg.id).toEqual(serializer.sessionId);
    expect(msg).toHaveProperty("parameters");
    expect(serializer.isOpen).toBe(true);
  });

  test("test_create_opened_response_with_languages", () => {
    // Test creating an opened response with language options.
    const serializer = new GenesysAudioHookSerializer();

    const msg = serializer.createOpenedResponse({
      supportedLanguages: ["es", "en", "fr"],
      selectedLanguage: "es",
    });

    expect(msg.parameters.supportedLanguages).toEqual(["es", "en", "fr"]);
    expect(msg.parameters.selectedLanguage).toEqual("es");
  });

  test("test_create_pong_response", () => {
    // Test creating a pong response message.
    const serializer = new GenesysAudioHookSerializer();

    const msg = serializer.createPongResponse();

    expect(msg.type).toEqual("pong");
    expect(msg.id).toEqual(serializer.sessionId);
    expect(msg.parameters).toEqual({});
  });

  test("test_create_closed_response", () => {
    // Test creating a closed response message.
    const serializer = new GenesysAudioHookSerializer();
    internals(serializer)._isOpen = true;

    const msg = serializer.createClosedResponse();

    expect(msg.type).toEqual("closed");
    expect(serializer.isOpen).toBe(false);
    expect(msg.parameters).toEqual({}); // Empty parameters when no output_variables
  });

  test("test_create_closed_response_with_output_variables", () => {
    // Test creating a closed response with custom output variables.
    const serializer = new GenesysAudioHookSerializer();
    internals(serializer)._isOpen = true;

    const msg = serializer.createClosedResponse({
      intent: "billing_inquiry",
      customer_verified: true,
      summary: "Customer asked about their bill",
    });

    expect(msg.type).toEqual("closed");
    expect(msg.parameters.outputVariables.intent).toEqual("billing_inquiry");
    expect(msg.parameters.outputVariables.customer_verified).toBe(true);
    expect(msg.parameters.outputVariables.summary).toEqual("Customer asked about their bill");
  });

  test("test_create_resumed_response", () => {
    // Test creating a resumed response message.
    const serializer = new GenesysAudioHookSerializer();
    internals(serializer)._isPaused = true;

    const msg = serializer.createResumedResponse();

    expect(msg.type).toEqual("resumed");
    expect(serializer.isPaused).toBe(false);
  });

  test("test_create_disconnect_message", () => {
    // Test creating a disconnect message.
    const serializer = new GenesysAudioHookSerializer();

    const msg = serializer.createDisconnectMessage({ reason: "completed", action: "transfer" });

    expect(msg.type).toEqual("disconnect");
    expect(msg.parameters.reason).toEqual("completed");
    expect(msg.parameters.outputVariables.action).toEqual("transfer");
  });

  test("test_create_disconnect_message_with_output_variables", () => {
    // Test creating a disconnect message with custom output variables.
    const serializer = new GenesysAudioHookSerializer();

    const msg = serializer.createDisconnectMessage({
      reason: "completed",
      action: "finished",
      outputVariables: { result: "success", code: "123" },
    });

    expect(msg.parameters.outputVariables.result).toEqual("success");
    expect(msg.parameters.outputVariables.code).toEqual("123");
  });

  test("test_create_error_message", () => {
    // Test creating an error message.
    const serializer = new GenesysAudioHookSerializer();

    const msg = serializer.createErrorMessage(500, "Internal error", true);

    expect(msg.type).toEqual("error");
    expect(msg.parameters.code).toEqual(500);
    expect(msg.parameters.message).toEqual("Internal error");
    expect(msg.parameters.retryable).toBe(true);
  });

  // ==================== Message Handling Tests ====================

  test("test_handle_open_message", async () => {
    // Test handling an open message returns opened frame.
    const serializer = new GenesysAudioHookSerializer();

    const result = await serializer.deserialize(JSON.stringify(sampleOpenMessage()));

    // Now returns OutputTransportMessageUrgentFrame with opened response
    expect(result).toBeInstanceOf(OutputTransportMessageUrgentFrame);
    expect((result as OutputTransportMessageUrgentFrame).message.type).toEqual("opened");
    expect(serializer.sessionId).toEqual("test-session-123");
    expect(serializer.conversationId).toEqual("conv-456");
  });

  test("test_handle_open_message_extracts_participant", async () => {
    // Test that open message extracts participant info.
    const serializer = new GenesysAudioHookSerializer();

    await serializer.deserialize(JSON.stringify(sampleOpenMessage()));

    expect(serializer.participant).not.toBeNull();
    expect(serializer.participant?.ani).toEqual("+1234567890");
    expect(serializer.participant?.dnis).toEqual("+0987654321");
  });

  test("test_handle_open_message_uses_params", async () => {
    // Test that open message uses InputParams for response.
    const params = new GenesysAudioHookSerializer.InputParams({
      supportedLanguages: ["es-ES", "en-US"],
      selectedLanguage: "es-ES",
      startPaused: true,
    });
    const serializer = new GenesysAudioHookSerializer({ params });

    const result = await serializer.deserialize(JSON.stringify(sampleOpenMessage()));

    expect(result).toBeInstanceOf(OutputTransportMessageUrgentFrame);
    const message = (result as OutputTransportMessageUrgentFrame).message;
    expect(message.parameters.supportedLanguages).toEqual(["es-ES", "en-US"]);
    expect(message.parameters.selectedLanguage).toEqual("es-ES");
    expect(message.parameters.startPaused).toBe(true);
  });

  test("test_handle_open_message_extracts_input_variables", async () => {
    // Test that open message extracts inputVariables from Genesys.
    const serializer = new GenesysAudioHookSerializer();

    await serializer.deserialize(JSON.stringify(sampleOpenMessageWithInputVariables()));

    expect(serializer.inputVariables).not.toBeNull();
    expect(serializer.inputVariables?.customer_id).toEqual("cust-789");
    expect(serializer.inputVariables?.queue_name).toEqual("billing");
    expect(serializer.inputVariables?.priority).toEqual("high");
    expect(serializer.inputVariables?.language).toEqual("es-ES");
  });

  test("test_handle_ping_message", async () => {
    // Test handling a ping message returns pong frame.
    const serializer = new GenesysAudioHookSerializer();

    const result = await serializer.deserialize(JSON.stringify(samplePingMessage()));

    expect(result).toBeInstanceOf(OutputTransportMessageUrgentFrame);
    expect((result as OutputTransportMessageUrgentFrame).message.type).toEqual("pong");
  });

  test("test_handle_close_message", async () => {
    // Test handling a close message returns closed frame.
    const serializer = new GenesysAudioHookSerializer();
    internals(serializer)._isOpen = true;

    const result = await serializer.deserialize(JSON.stringify(sampleCloseMessage()));

    expect(result).toBeInstanceOf(OutputTransportMessageUrgentFrame);
    expect((result as OutputTransportMessageUrgentFrame).message.type).toEqual("closed");
    expect(serializer.isOpen).toBe(false);
  });

  test("test_handle_close_message_includes_output_variables", async () => {
    // Test that close response includes output variables when set.
    const serializer = new GenesysAudioHookSerializer();
    internals(serializer)._isOpen = true;

    // Set output variables before close
    serializer.setOutputVariables({
      intent: "support",
      resolved: true,
      transfer_to: "agent_queue",
    });

    const result = await serializer.deserialize(JSON.stringify(sampleCloseMessage()));

    expect(result).toBeInstanceOf(OutputTransportMessageUrgentFrame);
    const message = (result as OutputTransportMessageUrgentFrame).message;
    expect(message.type).toEqual("closed");
    expect(message.parameters.outputVariables.intent).toEqual("support");
    expect(message.parameters.outputVariables.resolved).toBe(true);
    expect(message.parameters.outputVariables.transfer_to).toEqual("agent_queue");
  });

  // ==================== Output Variables Tests ====================

  test("test_set_output_variables", () => {
    // Test setting output variables.
    const serializer = new GenesysAudioHookSerializer();

    expect(serializer.outputVariables).toBeNull();

    serializer.setOutputVariables({ intent: "billing", score: 0.95 });

    expect(serializer.outputVariables).not.toBeNull();
    expect(serializer.outputVariables?.intent).toEqual("billing");
    expect(serializer.outputVariables?.score).toEqual(0.95);
  });

  test("test_set_output_variables_overwrites", () => {
    // Test that setting output variables overwrites previous values.
    const serializer = new GenesysAudioHookSerializer();

    serializer.setOutputVariables({ first: "value" });
    serializer.setOutputVariables({ second: "value" });

    expect(serializer.outputVariables).not.toHaveProperty("first");
    expect(serializer.outputVariables?.second).toEqual("value");
  });

  test("test_handle_pause_message", async () => {
    // Test handling a pause message.
    const serializer = new GenesysAudioHookSerializer();
    internals(serializer)._isOpen = true;

    const result = await serializer.deserialize(JSON.stringify(samplePauseMessage()));

    expect(result).toBeNull(); // Pause is handled internally
    expect(serializer.isPaused).toBe(true);
  });

  test("test_handle_update_message", async () => {
    // Test handling an update message.
    const serializer = new GenesysAudioHookSerializer();

    const result = await serializer.deserialize(JSON.stringify(sampleUpdateMessage()));

    expect(result).toBeNull(); // Update is handled internally
    expect(serializer.participant).not.toBeNull();
    expect(serializer.participant?.name).toEqual("John Doe");
  });

  test("test_handle_error_message", async () => {
    // Test handling an error message.
    const serializer = new GenesysAudioHookSerializer();

    const result = await serializer.deserialize(JSON.stringify(sampleErrorMessage()));

    expect(result).toBeNull(); // Error is logged but returns None
  });

  // ==================== DTMF Tests ====================

  test("test_handle_dtmf_digit", async () => {
    // Test handling a DTMF digit message.
    const serializer = new GenesysAudioHookSerializer();

    const result = await serializer.deserialize(JSON.stringify(sampleDtmfMessage("5")));

    expect(result).toBeInstanceOf(InputDTMFFrame);
    expect((result as InputDTMFFrame).button).toEqual("5");
  });

  test("test_handle_dtmf_star", async () => {
    // Test handling a DTMF star (*) message.
    const serializer = new GenesysAudioHookSerializer();

    const result = await serializer.deserialize(JSON.stringify(sampleDtmfMessage("*")));

    expect(result).toBeInstanceOf(InputDTMFFrame);
    expect((result as InputDTMFFrame).button).toEqual("*");
  });

  test("test_handle_dtmf_hash", async () => {
    // Test handling a DTMF hash (#) message.
    const serializer = new GenesysAudioHookSerializer();

    const result = await serializer.deserialize(JSON.stringify(sampleDtmfMessage("#")));

    expect(result).toBeInstanceOf(InputDTMFFrame);
    expect((result as InputDTMFFrame).button).toEqual("#");
  });

  test("test_handle_dtmf_empty_digit", async () => {
    // Test handling a DTMF message without digit.
    const serializer = new GenesysAudioHookSerializer();

    const dtmfMsg = {
      version: "2",
      type: "dtmf",
      seq: 6,
      id: "test-session-123",
      parameters: {},
    };

    const result = await serializer.deserialize(JSON.stringify(dtmfMsg));

    expect(result).toBeNull(); // No digit provided
  });

  // ==================== Sequence Number Tests ====================

  test("test_sequence_numbers_increment", () => {
    // Test that sequence numbers increment correctly.
    const serializer = new GenesysAudioHookSerializer();

    const response1 = serializer.createPongResponse();
    const response2 = serializer.createPongResponse();
    const response3 = serializer.createPongResponse();

    expect(response1.seq).toEqual(1);
    expect(response2.seq).toEqual(2);
    expect(response3.seq).toEqual(3);
  });
});
