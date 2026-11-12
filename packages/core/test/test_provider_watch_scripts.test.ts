// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_provider_watch_scripts.py

// Offline checks for the upstream `scripts/provider-watch` tooling.
//
// Upstream, `inventory.py` must keep finding every provider service and its
// default model as the services tree evolves; `digest.py` must render whatever
// frontmatter the researcher agents write; `probe.py` must refuse to run without
// credentials instead of failing later with a provider error. None of these
// touch the network.
//
// DIVERGENCE: these are Python repository-maintenance scripts (they scan the
// Python `src/pipecat` tree, read `pyproject.toml` extras, drive `git`/`gh` and
// spawn `python scripts/provider-watch/*.py`). They are not library modules, so
// they are not part of the port; pipedog's own tooling lives in `tools/`.
// Every test is skipped, naming the script it covers. Names and
// parametrizations are kept so the suites can be diffed.

import { describe, test } from "bun:test";

const INVENTORY = "scripts/provider-watch/inventory.py";
const PLAN = "scripts/provider-watch/plan.py";
const DIGEST = "scripts/provider-watch/digest.py";
const PROBE = "scripts/provider-watch/probe.py";
const PUBLISH = "scripts/provider-watch/publish.py";

function skipped(name: string, ...modules: string[]): void {
  test.skip(`${name} (Python repo tooling: ${modules.join(", ")})`, () => {});
}

describe("TestInventory", () => {
  skipped("test_covers_the_services_tree", INVENTORY);
  skipped("test_unit_ids_are_unique_and_sorted", INVENTORY);

  for (const [unitId, className, expectModel] of [
    ["openai/llm", "OpenAILLMService", true],
    ["openai/responses-llm", "OpenAIResponsesLLMService", true],
    ["openai/realtime", "OpenAIRealtimeLLMService", true],
    ["cartesia/tts", "CartesiaTTSService", true],
    ["deepgram/stt", "DeepgramSTTService", true],
    ["google/realtime", "GeminiLiveLLMService", true],
    ["openai/live-realtime", "OpenAILiveLLMService", true],
    ["azure/voice_live-realtime", "AzureVoiceLiveLLMService", true],
    ["groq/llm", "GroqLLMService", true],
    ["azure/tts", "AzureTTSService", false],
  ] as const) {
    skipped(
      `test_known_units[${unitId}-${className}-${expectModel ? "True" : "False"}]`,
      INVENTORY,
    );
  }

  skipped("test_every_settings_model_literal_is_captured", INVENTORY);
  skipped("test_thin_wrappers_are_flagged", INVENTORY);
  skipped("test_base_classes_and_shims_are_excluded", INVENTORY);
  skipped("test_joins", INVENTORY);
  skipped("test_select_and_cli", INVENTORY);
});

describe("TestPlan", () => {
  // plan.py slices the inventory into matrix groups.
  skipped("test_groups_cover_every_unit_once_in_order", PLAN, INVENTORY);
  skipped("test_group_names_are_unique_and_artifact_safe", PLAN, INVENTORY);
  skipped("test_cli_emits_the_matrix_json", PLAN);
});

describe("TestDigest", () => {
  skipped("test_render_sections", DIGEST);
  skipped("test_cli_writes_file", DIGEST);
});

describe("TestProbe", () => {
  skipped("test_missing_credentials_exit_2_and_name_only", PROBE);
  skipped("test_research_only_types_exit_3", PROBE);
  skipped("test_unknown_provider_catalogue_exit_3", PROBE);
  skipped("test_merge_probe_results_medians", PROBE);
  skipped("test_setting_values_parse_json_and_scalars", PROBE);
  skipped("test_too_many_models_rejected", PROBE);
  skipped("test_settings_reach_services_that_forward_kwargs", PROBE, INVENTORY);
});

describe("TestPublish", () => {
  // publish.py against a fake git/gh so nothing leaves the machine.
  skipped("test_opens_and_adopts", PUBLISH);
  skipped("test_multi_commit_branch_stitches_pr", PUBLISH);
  skipped("test_renames_changelog_fragments_to_pr_number", PUBLISH);
  skipped("test_renames_only_fragments_the_pr_adds", PUBLISH);
  skipped("test_sweep_leaves_correct_and_non_bot_prs_alone", PUBLISH);
  skipped("test_second_pass_is_a_no_op", PUBLISH);
  skipped("test_ensure_digest_keeps_the_rendered_digest", PUBLISH);
  skipped("test_ensure_digest_renders_plain_when_missing", PUBLISH, DIGEST);
  skipped("test_worth_an_issue", PUBLISH);
  skipped("test_missing_branch_is_skipped", PUBLISH);
});

describe("TestSdkVersions", () => {
  // probe.py sdk-versions: SDK derivation from pyproject, no network.
  skipped("test_sdk_requirements_come_from_pyproject_extras", PROBE, INVENTORY);
  skipped("test_thin_wrappers_fall_back_to_openai", PROBE, INVENTORY);
});
