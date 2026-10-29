// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_file_resolver.py

import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMContextConversionError } from "@pipedog/core/adapters/llm/base_llm_adapter";
import { OpenAILLMAdapter } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { FileResolver, FileResolverError } from "@pipedog/core/utils/file_resolver";
import { type FileStorage, LocalFileStorage } from "@pipedog/core/utils/file_storage";
import * as ssrf from "@pipedog/core/utils/security/ssrf";
import { IPNetwork, UrlReachability } from "@pipedog/core/utils/security/ssrf";
import { AWSBedrockLLMAdapter } from "../../aws/src/bedrock_adapter.ts";
import { GeminiLLMAdapter, GeminiVertexLLMAdapter } from "../../google/src/gemini_adapter.ts";
import { OpenAIRealtimeLLMAdapter } from "../../openai/src/open_ai_realtime_adapter.ts";
import { OpenAIResponsesLLMAdapter } from "../../openai/src/open_ai_responses_adapter.ts";
import { AnthropicLLMAdapter } from "../src/anthropic_adapter.ts";

const encoder = new TextEncoder();
const b = (s: string): Uint8Array => encoder.encode(s);

/** Test access to FileResolver's protected members. */
interface ResolverInternals {
  _allowedUrlNetworks: IPNetwork[];
  _reachabilityCache: Map<string, UrlReachability>;
  _fetchUncached: Mock<(url: string) => Promise<Uint8Array>>;
}
const internals = (resolver: FileResolver): ResolverInternals =>
  resolver as unknown as ResolverInternals;

/**
 * Fake `fetch` response whose body streams in several chunks (upstream: a
 * mock aiohttp response).
 */
function _mockHttpResponse(
  options: {
    status?: number;
    body?: Uint8Array;
    contentLength?: number | null;
    bodyError?: Error | null;
    chunkSize?: number;
  } = {},
) {
  const status = options.status ?? 200;
  const body = options.body ?? new Uint8Array();
  const chunkSize = options.chunkSize ?? 8;
  const headers = new Headers();
  if (options.contentLength != null) {
    headers.set("content-length", String(options.contentLength));
  }
  const bodyError = options.bodyError ?? null;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bodyError !== null) {
        throw bodyError;
      }
      if (offset >= body.length) {
        controller.close();
        return;
      }
      controller.enqueue(body.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 404 ? "Not Found" : "",
    type: "basic",
    headers,
    body: stream,
  } as unknown as Response;
}

/** Replace the global `fetch` (upstream: patching `aiohttp.ClientSession`). */
function _mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = mock(impl);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = globalThis.fetch;

describe("TestFileResolverFetch", () => {
  let classifyMock: Mock<typeof ssrf.classifyUrlReachability>;
  const tmpdirs: string[] = [];

  function temporaryDirectory(): string {
    const dir = mkdtempSync(join(tmpdir(), "pipedog-file-resolver-"));
    tmpdirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    // Default http(s) reachability to "public" so tests exercising the
    // fetch itself don't depend on real DNS. Policy tests override this.
    classifyMock = spyOn(ssrf, "classifyUrlReachability").mockImplementation(
      async () => UrlReachability.PUBLIC,
    );
  });

  afterEach(() => {
    classifyMock.mockRestore();
    globalThis.fetch = originalFetch;
    for (const dir of tmpdirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -- data: URLs -------------------------------------------------------------

  test("test_data_url_is_decoded", async () => {
    const raw = b("%PDF-1.4 fake content");
    const b64 = bytesToBase64(raw);
    const resolver = new FileResolver();
    const result = await resolver.fetch(`data:application/pdf;base64,${b64}`);
    expect(result).toEqual(raw);
  });

  test("test_malformed_data_url_raises", async () => {
    const resolver = new FileResolver();
    await expect(resolver.fetch("data:application/pdf;base64")).rejects.toThrow(FileResolverError);
  });

  // -- http(s) URLs -----------------------------------------------------------

  test("test_http_fetch_returns_bytes", async () => {
    const raw = b("%PDF-1.4 fetched content");
    _mockFetch(async () => _mockHttpResponse({ body: raw }));
    const resolver = new FileResolver();
    const result = await resolver.fetch("https://example.com/doc.pdf");
    expect(result).toEqual(raw);
  });

  test("test_http_blocked_raises_without_fetching", async () => {
    classifyMock.mockImplementation(async () => UrlReachability.BLOCKED);
    const fetchMock = _mockFetch(async () => _mockHttpResponse());
    const resolver = new FileResolver();
    await expect(resolver.fetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      FileResolverError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("test_http_allowed_network_is_fetched", async () => {
    classifyMock.mockImplementation(async () => UrlReachability.ALLOWED);
    const raw = b("internal file");
    _mockFetch(async () => _mockHttpResponse({ body: raw }));
    const resolver = new FileResolver({ allowedUrlNetworks: ["10.0.0.0/8"] });
    const result = await resolver.fetch("https://internal.example.com/private.pdf");
    expect(result).toEqual(raw);
  });

  test("test_allowed_url_networks_passed_to_classification", async () => {
    const resolver = new FileResolver({ allowedUrlNetworks: ["10.0.0.0/8"] });
    await resolver.classify("https://internal.example.com/private.pdf");
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(classifyMock).toHaveBeenCalledWith("https://internal.example.com/private.pdf", [
      new IPNetwork("10.0.0.0/8"),
    ]);
  });

  test("test_allowed_url_networks_defaults_from_env_var", async () => {
    const previous = process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS;
    process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS = "10.0.0.0/8";
    let resolver: FileResolver;
    try {
      resolver = new FileResolver();
    } finally {
      if (previous === undefined) delete process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS;
      else process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS = previous;
    }
    expect(internals(resolver)._allowedUrlNetworks).toEqual([new IPNetwork("10.0.0.0/8")]);
  });

  test("test_allowed_url_networks_argument_overrides_env_var", async () => {
    const previous = process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS;
    process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS = "10.0.0.0/8";
    let resolver: FileResolver;
    try {
      resolver = new FileResolver({ allowedUrlNetworks: [] });
    } finally {
      if (previous === undefined) delete process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS;
      else process.env.PIPECAT_ALLOWED_FILE_URL_NETWORKS = previous;
    }
    expect(internals(resolver)._allowedUrlNetworks).toEqual([]);
  });

  test("test_http_redirect_is_refused", async () => {
    const fetchMock = _mockFetch(async () => _mockHttpResponse({ status: 302 }));
    const resolver = new FileResolver();
    const error = await resolver.fetch("https://example.com/redirects.pdf").catch((e) => e);
    expect(error).toBeInstanceOf(FileResolverError);
    expect(String(error.message)).toContain("redirect");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Upstream asserts `allow_redirects` is False; fetch's equivalent is a
    // redirect mode other than "follow".
    expect(fetchMock.mock.calls[0]?.[1]?.redirect ?? "follow").not.toEqual("follow");
  });

  test("test_http_error_raises", async () => {
    _mockFetch(async () => _mockHttpResponse({ status: 404 }));
    const resolver = new FileResolver();
    await expect(resolver.fetch("https://example.com/missing.pdf")).rejects.toThrow(
      FileResolverError,
    );
  });

  test("test_http_timeout_raises", async () => {
    _mockFetch(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const resolver = new FileResolver();
    const error = await resolver.fetch("https://slow.example.com/file.pdf").catch((e) => e);
    expect(error).toBeInstanceOf(FileResolverError);
    expect(String(error.message)).toContain("Timed out");
  });

  test("test_http_oversized_stream_raises", async () => {
    // A body that only reveals its size while streaming is cut off at the cap.
    _mockFetch(async () => _mockHttpResponse({ body: b("x".repeat(11)), chunkSize: 4 }));
    const resolver = new FileResolver({ maxFetchBytes: 10 });
    const error = await resolver.fetch("https://example.com/huge.pdf").catch((e) => e);
    expect(error).toBeInstanceOf(FileResolverError);
    expect(String(error.message)).toContain("byte limit");
  });

  test("test_http_oversized_content_length_rejected_before_reading", async () => {
    // A Content-Length over the cap is rejected without reading the body.
    _mockFetch(async () =>
      _mockHttpResponse({
        body: b("irrelevant"),
        contentLength: 11,
        bodyError: new Error("body should not be read"),
      }),
    );
    const resolver = new FileResolver({ maxFetchBytes: 10 });
    const error = await resolver.fetch("https://example.com/huge.pdf").catch((e) => e);
    expect(error).toBeInstanceOf(FileResolverError);
    expect(String(error.message)).toContain("byte limit");
  });

  // -- storage-minted URLs ------------------------------------------------------

  test("test_storage_url_loads_from_storage", async () => {
    const raw = b("%PDF-1.4 uploaded content");
    const dir = temporaryDirectory();
    const storage = new LocalFileStorage({ folder: dir, fs });
    const fileUrl = await storage.save("doc.pdf", raw);
    const resolver = new FileResolver({ fileStorage: storage });
    const result = await resolver.fetch(fileUrl);
    expect(result).toEqual(raw);
  });

  test("test_forget_forces_a_refetch", async () => {
    // An application that knows a URL's content changed can drop the cache.
    const rawV1 = b("version 1");
    const rawV2 = b("version 2");
    const resolver = new FileResolver();
    const values = [rawV1, rawV2];
    internals(resolver)._fetchUncached = mock(async (_url: string) => values.shift()!);

    expect(await resolver.fetch("https://example.com/live.pdf")).toEqual(rawV1);
    expect(await resolver.fetch("https://example.com/live.pdf")).toEqual(rawV1);

    resolver.forget("https://example.com/live.pdf");

    expect(await resolver.fetch("https://example.com/live.pdf")).toEqual(rawV2);
    expect(resolver.cachedDataUrl("https://example.com/live.pdf")).toBeNull();
  });

  test("test_local_storage_upload_deleted_after_load", async () => {
    // LocalFileStorage owns its uploads: a consumed file is removed from disk,
    // and the resolver's cache becomes the surviving copy.
    const raw = b("%PDF-1.4 uploaded content");
    const dir = temporaryDirectory();
    const storage = new LocalFileStorage({ folder: dir, fs });
    const fileUrl = await storage.save("doc.pdf", raw);
    const resolver = new FileResolver({ fileStorage: storage });
    expect(await resolver.fetch(fileUrl)).toEqual(raw);

    expect(readdirSync(dir)).toEqual([]);
    // Deleted from disk, but still resolvable from the cache.
    expect(await resolver.fetch(fileUrl)).toEqual(raw);
  });

  test("test_storage_without_delete_after_load_keeps_the_file", async () => {
    // A backend that doesn't own its URLs (deleteAfterLoad false) is never deleted from.
    const storage = {
      deleteAfterLoad: false,
      save: mock(async () => ""),
      load: mock(async (_url: string) => b("shared object")),
      delete: mock(async (_url: string) => {}),
    };

    const resolver = new FileResolver({ fileStorage: storage as unknown as FileStorage });
    const result = await resolver.fetch("s3://bucket/shared/report.pdf");

    expect(result).toEqual(b("shared object"));
    expect(storage.delete).not.toHaveBeenCalled();
  });

  test("test_storage_url_missing_file_raises", async () => {
    const dir = temporaryDirectory();
    const resolver = new FileResolver({ fileStorage: new LocalFileStorage({ folder: dir, fs }) });
    const error = await resolver.fetch(`pipecat:${"0".repeat(32)}`).catch((e) => e);
    expect(error).toBeInstanceOf(FileResolverError);
    expect(String(error.message)).toContain("not found");
  });

  test("test_storage_url_path_traversal_raises", async () => {
    const dir = temporaryDirectory();
    const resolver = new FileResolver({ fileStorage: new LocalFileStorage({ folder: dir, fs }) });
    await expect(resolver.fetch("pipecat:../../../etc/passwd")).rejects.toThrow(FileResolverError);
  });

  test("test_unresolvable_scheme_without_storage_raises", async () => {
    const resolver = new FileResolver();
    await expect(resolver.fetch(`pipecat:${"0".repeat(32)}`)).rejects.toThrow(FileResolverError);
  });

  test("test_unresolvable_scheme_gs_without_storage_raises", async () => {
    const resolver = new FileResolver();
    await expect(resolver.fetch("gs://bucket/key.pdf")).rejects.toThrow(FileResolverError);
  });
});

describe("TestAdapterSupportsFileUrl", () => {
  test("test_openai_supports_http_images_only", () => {
    const adapter = new OpenAILLMAdapter();
    expect(adapter.supportsFileUrl("https://x.com/a.png", "image/png")).toBe(true);
    expect(adapter.supportsFileUrl("https://x.com/a.pdf", "application/pdf")).toBe(false);
    expect(adapter.supportsFileUrl("s3://bucket/a.png", "image/png")).toBe(false);
  });

  test("test_openai_responses_supports_http", () => {
    const adapter = new OpenAIResponsesLLMAdapter();
    expect(adapter.supportsFileUrl("https://x.com/a.pdf", "application/pdf")).toBe(true);
    expect(adapter.supportsFileUrl("https://x.com/a.png", "image/png")).toBe(true);
    expect(adapter.supportsFileUrl("gs://bucket/a.pdf", "application/pdf")).toBe(false);
  });

  test("test_anthropic_supports_http_images_and_pdfs", () => {
    const adapter = new AnthropicLLMAdapter();
    expect(adapter.supportsFileUrl("https://x.com/a.png", "image/png")).toBe(true);
    expect(adapter.supportsFileUrl("https://x.com/a.pdf", "application/pdf")).toBe(true);
    expect(adapter.supportsFileUrl("https://x.com/a.mp4", "video/mp4")).toBe(false);
    expect(adapter.supportsFileUrl("s3://bucket/a.pdf", "application/pdf")).toBe(false);
  });

  test("test_bedrock_supports_s3_only", () => {
    const adapter = new AWSBedrockLLMAdapter();
    expect(adapter.supportsFileUrl("s3://bucket/a.pdf", "application/pdf")).toBe(true);
    expect(adapter.supportsFileUrl("https://x.com/a.pdf", "application/pdf")).toBe(false);
  });

  test("test_gemini_supports_own_file_api_but_not_gs", () => {
    // The developer API needs a gs:// URI registered with the Files API first,
    // so only registered Files API URIs pass through; gs:// gets fetched and inlined.
    const adapter = new GeminiLLMAdapter();
    expect(adapter.supportsFileUrl("gs://bucket/a.pdf", "application/pdf")).toBe(false);
    expect(
      adapter.supportsFileUrl(
        "https://generativelanguage.googleapis.com/v1beta/files/abc",
        "application/pdf",
      ),
    ).toBe(true);
    expect(adapter.supportsFileUrl("https://x.com/a.pdf", "application/pdf")).toBe(false);
    expect(adapter.supportsFileUrl("s3://bucket/a.pdf", "application/pdf")).toBe(false);
  });

  test("test_gemini_vertex_additionally_supports_gs", () => {
    const adapter = new GeminiVertexLLMAdapter();
    expect(adapter.supportsFileUrl("gs://bucket/a.pdf", "application/pdf")).toBe(true);
    expect(
      adapter.supportsFileUrl(
        "https://generativelanguage.googleapis.com/v1beta/files/abc",
        "application/pdf",
      ),
    ).toBe(true);
    expect(adapter.supportsFileUrl("https://x.com/a.pdf", "application/pdf")).toBe(false);
  });
});

/**
 * The resolution pass: pass through what the provider can consume, fetch the
 * rest into the resolver's caches — never touching the context itself.
 */
describe("TestResolveFileItems", () => {
  const RAW = b("%PDF-1.4 fetched");

  /**
   * A real resolver with the network edge stubbed out: _fetchUncached is
   * mocked, so fetch() still populates the caches.
   */
  function _resolver(): FileResolver {
    const resolver = new FileResolver();
    internals(resolver)._fetchUncached = mock(async (_url: string) => RAW);
    return resolver;
  }

  function _seedReachability(resolver: FileResolver, url: string, verdict: UrlReachability) {
    internals(resolver)._reachabilityCache.set(url, verdict);
  }

  function _fileUrlContext(url: string, mime = "application/pdf", filename = "doc.pdf") {
    const message = LLMContext.createFileUrlMessage({ format: mime, url, filename });
    return new LLMContext({ messages: [message] });
  }

  function _snapshot(context: LLMContext) {
    return structuredClone(context.getMessages());
  }

  const fetchUncached = (resolver: FileResolver) => internals(resolver)._fetchUncached;

  test("test_supported_public_url_passes_through_untouched", async () => {
    const context = _fileUrlContext("https://example.com/a.png", "image/png");
    const before = _snapshot(context);
    const resolver = _resolver();
    _seedReachability(resolver, "https://example.com/a.png", UrlReachability.PUBLIC);

    const adapter = new OpenAILLMAdapter();
    adapter.fileResolver = resolver;
    await adapter.prepareFileContent(context);

    expect(fetchUncached(resolver)).not.toHaveBeenCalled();
    expect(context.getMessages()).toEqual(before);
  });

  test("test_unsupported_url_is_fetched_and_inlined_at_conversion", async () => {
    const context = _fileUrlContext("https://example.com/a.pdf");
    const before = _snapshot(context);
    const resolver = _resolver();

    const adapter = new OpenAILLMAdapter();
    adapter.fileResolver = resolver;
    const params = await adapter.getLlmInvocationParams(context, {
      convertDeveloperToUser: false,
    });

    expect(fetchUncached(resolver)).toHaveBeenCalledTimes(1);
    expect(fetchUncached(resolver)).toHaveBeenCalledWith("https://example.com/a.pdf");
    // The provider request carries the inlined bytes...
    const content = (params.messages[0] as unknown as { content: Record<string, unknown>[] })
      .content;
    const item = content[content.length - 1] as { type: string; file: { file_data: string } };
    const expectedB64 = bytesToBase64(RAW);
    expect(item.type).toEqual("file");
    expect(item.file.file_data).toEqual(`data:application/pdf;base64,${expectedB64}`);
    // ...while the canonical context still holds the URL, untouched.
    expect(context.getMessages()).toEqual(before);
  });

  test("test_supported_url_on_private_allowed_network_is_fetched", async () => {
    const context = _fileUrlContext("https://internal.example.com/a.pdf");
    const resolver = _resolver();
    _seedReachability(resolver, "https://internal.example.com/a.pdf", UrlReachability.ALLOWED);

    const adapter = new AnthropicLLMAdapter();
    adapter.fileResolver = resolver;
    await adapter.prepareFileContent(context);

    expect(fetchUncached(resolver)).toHaveBeenCalledTimes(1);
    expect(resolver.cachedDataUrl("https://internal.example.com/a.pdf")).not.toBeNull();
  });

  test("test_cloud_uri_passes_through_without_reachability_check", async () => {
    const context = _fileUrlContext("s3://bucket/a.pdf");
    const resolver = _resolver();

    const classifyMock = spyOn(ssrf, "classifyUrlReachability").mockImplementation(
      async () => UrlReachability.PUBLIC,
    );
    try {
      const adapter = new AWSBedrockLLMAdapter();
      adapter.fileResolver = resolver;
      await adapter.prepareFileContent(context);

      expect(classifyMock).not.toHaveBeenCalled();
      expect(fetchUncached(resolver)).not.toHaveBeenCalled();
    } finally {
      classifyMock.mockRestore();
    }
  });

  test("test_reachability_classified_once_per_url", async () => {
    // DNS classification is cached on the resolver, so repeated resolution
    // passes — and other adapters sharing the resolver — don't re-resolve.
    const context = _fileUrlContext("https://example.com/a.png", "image/png");
    const resolver = _resolver();

    const classifyMock = spyOn(ssrf, "classifyUrlReachability").mockImplementation(
      async () => UrlReachability.PUBLIC,
    );
    try {
      const adapter = new OpenAILLMAdapter();
      adapter.fileResolver = resolver;
      await adapter.prepareFileContent(context);
      await adapter.prepareFileContent(context);
      const otherAdapter = new OpenAIResponsesLLMAdapter();
      otherAdapter.fileResolver = resolver;
      await otherAdapter.prepareFileContent(context);

      expect(classifyMock).toHaveBeenCalledTimes(1);
    } finally {
      classifyMock.mockRestore();
    }
  });

  test("test_switching_adapters_shares_the_download", async () => {
    // A URL one provider passes through gets fetched when another can't
    // consume it — and adapters sharing the resolver download it only once.
    const context = _fileUrlContext("gs://bucket/a.pdf");
    const before = _snapshot(context);
    const resolver = _resolver();

    const vertex = new GeminiVertexLLMAdapter();
    vertex.fileResolver = resolver;
    await vertex.prepareFileContent(context);
    expect(fetchUncached(resolver)).not.toHaveBeenCalled();

    const anthropic = new AnthropicLLMAdapter();
    anthropic.fileResolver = resolver;
    await anthropic.prepareFileContent(context);
    expect(fetchUncached(resolver)).toHaveBeenCalledTimes(1);
    expect(fetchUncached(resolver)).toHaveBeenCalledWith("gs://bucket/a.pdf");

    // A third provider (raw-bytes consumer) reuses the cached download.
    const bedrock = new AWSBedrockLLMAdapter();
    bedrock.fileResolver = resolver;
    await bedrock.prepareFileContent(context);
    expect(fetchUncached(resolver)).toHaveBeenCalledTimes(1);
    expect(resolver.cachedBytes("gs://bucket/a.pdf")).toEqual(RAW);

    expect(context.getMessages()).toEqual(before);
  });

  test("test_data_url_form_prepared_for_base64_consumers", async () => {
    const context = _fileUrlContext("https://example.com/a.pdf");
    const resolver = _resolver();
    _seedReachability(resolver, "https://example.com/a.pdf", UrlReachability.ALLOWED);

    const adapter = new AnthropicLLMAdapter();
    adapter.fileResolver = resolver;
    await adapter.prepareFileContent(context);

    const expectedB64 = bytesToBase64(RAW);
    expect(resolver.cachedDataUrl("https://example.com/a.pdf")).toEqual(
      `data:application/pdf;base64,${expectedB64}`,
    );
  });

  test("test_inline_base64_decoded_once_for_adapters_that_prefer_raw_bytes", async () => {
    const raw = b("inline content");
    const b64 = bytesToBase64(raw);
    const dataUrl = `data:application/pdf;base64,${b64}`;
    const message = await LLMContext.createFileMessage({
      type: "bytes",
      format: "application/pdf",
      file: dataUrl,
    });
    const context = new LLMContext({ messages: [message] });
    const before = _snapshot(context);
    const resolver = new FileResolver();

    const adapter = new AWSBedrockLLMAdapter();
    adapter.fileResolver = resolver;
    await adapter.prepareFileContent(context);

    expect(resolver.cachedBytes(dataUrl)).toEqual(raw);
    expect(context.getMessages()).toEqual(before);
  });

  test("test_logging_conversion_reads_the_same_caches", async () => {
    // getMessagesForLogging converts the context too; a resolved file
    // must not blow it up just because that path doesn't run resolution.
    const context = _fileUrlContext("https://example.com/a.pdf");
    const resolver = _resolver();
    _seedReachability(resolver, "https://example.com/a.pdf", UrlReachability.ALLOWED);

    const adapter = new AWSBedrockLLMAdapter();
    adapter.fileResolver = resolver;
    await adapter.getLlmInvocationParams(context);

    const messages = adapter.getMessagesForLogging(context);
    expect(messages.length).toEqual(1);
  });

  test("test_fetch_failure_raises_conversion_error", async () => {
    const context = _fileUrlContext("https://example.com/a.pdf");
    const resolver = _resolver();
    internals(resolver)._fetchUncached = mock(async (_url: string): Promise<Uint8Array> => {
      throw new FileResolverError("nope");
    });

    const adapter = new OpenAILLMAdapter();
    adapter.fileResolver = resolver;
    await expect(adapter.prepareFileContent(context)).rejects.toThrow(LLMContextConversionError);
  });

  test("test_adapter_for_provider_without_files_fetches_nothing", async () => {
    const context = _fileUrlContext("https://example.com/a.pdf");
    const resolver = _resolver();

    const adapter = new OpenAIRealtimeLLMAdapter();
    adapter.fileResolver = resolver;
    await adapter.getLlmInvocationParams(context);

    expect(fetchUncached(resolver)).not.toHaveBeenCalled();
  });

  test("test_text_only_context_is_untouched", async () => {
    const context = new LLMContext({ messages: [{ role: "user", content: "hello" }] });
    const resolver = _resolver();
    const adapter = new OpenAILLMAdapter();
    adapter.fileResolver = resolver;
    await adapter.prepareFileContent(context);
    expect(fetchUncached(resolver)).not.toHaveBeenCalled();
  });
});
