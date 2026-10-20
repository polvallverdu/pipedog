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
// These are Python repository-maintenance scripts (they scan the Python
// `src/pipecat` tree, read `pyproject.toml` extras, drive `git`/`gh` and spawn
// `python scripts/provider-watch/*.py`). They are not library modules and have
// no pipedog counterpart yet, so every test is a `test.todo` naming the
// unported script. Names and parametrizations are kept so the suites can be
// diffed.

import { describe, test } from "bun:test";

const INVENTORY = "scripts/provider-watch/inventory.py";
const PLAN = "scripts/provider-watch/plan.py";
const DIGEST = "scripts/provider-watch/digest.py";
const PROBE = "scripts/provider-watch/probe.py";
const PUBLISH = "scripts/provider-watch/publish.py";

function todo(name: string, ...modules: string[]): void {
  test.todo(`${name} (needs ${modules.join(", ")}, not ported)`);
}

describe("TestInventory", () => {
  todo("test_covers_the_services_tree", INVENTORY);
  todo("test_unit_ids_are_unique_and_sorted", INVENTORY);

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
    todo(`test_known_units[${unitId}-${className}-${expectModel ? "True" : "False"}]`, INVENTORY);
  }

  todo("test_every_settings_model_literal_is_captured", INVENTORY);
  todo("test_thin_wrappers_are_flagged", INVENTORY);
  todo("test_base_classes_and_shims_are_excluded", INVENTORY);
  todo("test_joins", INVENTORY);
  todo("test_select_and_cli", INVENTORY);
});

describe("TestPlan", () => {
  // plan.py slices the inventory into matrix groups.
  todo("test_groups_cover_every_unit_once_in_order", PLAN, INVENTORY);
  todo("test_group_names_are_unique_and_artifact_safe", PLAN, INVENTORY);
  todo("test_cli_emits_the_matrix_json", PLAN);
});

describe("TestDigest", () => {
  todo("test_render_sections", DIGEST);
  todo("test_cli_writes_file", DIGEST);
});

describe("TestProbe", () => {
  todo("test_missing_credentials_exit_2_and_name_only", PROBE);
  todo("test_research_only_types_exit_3", PROBE);
  todo("test_unknown_provider_catalogue_exit_3", PROBE);
  todo("test_merge_probe_results_medians", PROBE);
  todo("test_setting_values_parse_json_and_scalars", PROBE);
  todo("test_too_many_models_rejected", PROBE);
  todo("test_settings_reach_services_that_forward_kwargs", PROBE, INVENTORY);
});

describe("TestPublish", () => {
  // publish.py against a fake git/gh so nothing leaves the machine.
  todo("test_opens_and_adopts", PUBLISH);
  todo("test_multi_commit_branch_stitches_pr", PUBLISH);
  todo("test_renames_changelog_fragments_to_pr_number", PUBLISH);
  todo("test_sweep_leaves_correct_and_non_bot_prs_alone", PUBLISH);
  todo("test_second_pass_is_a_no_op", PUBLISH);
  todo("test_ensure_digest_keeps_the_rendered_digest", PUBLISH);
  todo("test_ensure_digest_renders_plain_when_missing", PUBLISH, DIGEST);
  todo("test_worth_an_issue", PUBLISH);
  todo("test_missing_branch_is_skipped", PUBLISH);
});

describe("TestSdkVersions", () => {
  // probe.py sdk-versions: SDK derivation from pyproject, no network.
  todo("test_sdk_requirements_come_from_pyproject_extras", PROBE, INVENTORY);
  todo("test_thin_wrappers_fall_back_to_openai", PROBE, INVENTORY);
});
