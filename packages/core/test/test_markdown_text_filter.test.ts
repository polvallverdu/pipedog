// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_markdown_text_filter.py

import { beforeEach, describe, expect, test } from "bun:test";

import { MarkdownTextFilter } from "../src/utils/text/markdown_text_filter.ts";

describe("TestMarkdownTextFilter", () => {
  let filter: MarkdownTextFilter;

  beforeEach(() => {
    filter = new MarkdownTextFilter();
  });

  test("test_basic_markdown_removal", async () => {
    // Test removal of basic Markdown formatting while preserving content.
    const inputText = `
            **Bold text** and *italic text*
            1. Numbered list item
            - Bullet point
            Some \`inline code\` here\n\n## Subtitle
        `;

    const expectedText = `
            Bold text and italic text
            1. Numbered list item
            - Bullet point
            Some inline code here\nSubtitle
        `;

    const result = await filter.filter(inputText);
    expect(result.trim()).toEqual(expectedText.trim());
  });

  test("test_space_preservation", async () => {
    // Test preservation of leading and trailing spaces (for word-by-word
    // streaming in bot-tts-text).
    const inputText = [
      "  Leading spaces",
      "Trailing spaces  ",
      "  Both ends  ",
      "  Multiple  spaces  between  words  ",
    ];

    for (const text of inputText) {
      const result = await filter.filter(text);
      expect(result.length, `Space preservation failed for: '${text}'\nGot: '${result}'`).toEqual(
        text.length,
      );
      // Check if spaces are in the same positions
      for (let i = 0; i < text.length; i++) {
        if (text[i] === " ") {
          expect(result[i], `Space at position ${i} was not preserved in: '${text}'`).toEqual(" ");
        }
      }
    }
  });

  test("test_repeated_character_removal", async () => {
    // Test removal of repeated character sequences (5 or more).
    const testCases: Record<string, string> = {
      "Hello!!!!!World": "HelloWorld", // 5 exclamations removed
      "Test####ing": "Test####ing", // 4 hashes preserved
      "Normal text": "Normal text", // No repeated chars
      "!!!!!": "", // All repeated chars removed
      "Mixed!!!!!...../////": "Mixed", // Multiple repeated sequences
      "Text^^^^test": "Text^^^^test", // 4 carets preserved
      "Text^^^^^test": "Texttest", // 5 carets removed
      "Dots....here": "Dots....here", // 4 dots preserved
      "Dots.....here": "Dotshere", // 5 dots removed
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(
        result,
        `Failed to handle repeated characters in: '${inputText}'\nExpected: '${expected}'\nGot: '${result}'`,
      ).toEqual(expected);
    }
  });

  test("test_preserve_repeated_characters", async () => {
    // Test preservation of repeated characters (5 or more).
    const filter = new MarkdownTextFilter({
      params: new MarkdownTextFilter.InputParams({ filterRepeatedSequences: false }),
    });
    const repeatedSequence = "55555";

    const result = await filter.filter(repeatedSequence);

    expect(
      result,
      `Preserve repeated sequences failed.\nExpected:\n${repeatedSequence}\nGot:\n${result}`,
    ).toEqual(repeatedSequence);
  });

  test("test_numbered_list_preservation", async () => {
    // Test that numbered lists are preserved correctly.
    const inputText = `1. First item
        2. Second item
        3. Third item with **bold**`;

    const expected = `1. First item
        2. Second item
        3. Third item with bold`;

    const result = await filter.filter(inputText);
    expect(
      result.trim(),
      `Numbered list preservation failed.\nExpected:\n${expected}\nGot:\n${result}`,
    ).toEqual(expected.trim());
  });

  test("test_html_entity_conversion", async () => {
    // Test conversion of HTML entities to their plain text equivalents.
    const testCases: Record<string, string> = {
      "This &amp; that": "This & that",
      "1 &lt; 2": "1 < 2",
      "2 &gt; 1": "2 > 1",
      "Line&nbsp;break": "Line break",
      "Mixed &amp; &lt;entities&gt;": "Mixed & <entities>",
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(result, `HTML entity conversion failed for: '${inputText}'`).toEqual(expected);
    }
  });

  test("test_asterisk_removal", async () => {
    // Test removal of Markdown asterisk formatting.
    const testCases: Record<string, string> = {
      "**bold text**": "bold text", // Double asterisks
      "*italic text*": "italic text", // Single asterisks
      "**bold** and *italic*": "bold and italic", // Mixed
      "multiple**bold**words": "multipleboldwords", // No spaces
      "edge**cases***here*": "edgecaseshere", // Adjacent asterisks
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(result, `Asterisk removal failed for: '${inputText}'`).toEqual(expected);
    }
  });

  test("test_newline_handling", async () => {
    // Test handling of empty and whitespace-only lines.
    const testCases: Record<string, string> = {
      "Line 1\n\nLine 2": "Line 1\n Line 2", // Empty line becomes space
      "Line 1\n   \nLine 2": "Line 1\n Line 2", // Whitespace line becomes single space
      "Text\n\n\nMore": "Text\n More", // Multiple empty lines become spaces
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(result, `Newline handling failed for:\n${inputText}\nGot:\n${result}`).toEqual(
        expected,
      );
    }
  });

  test("test_links_cleaning", async () => {
    // Test cleaning of links and URLs, i.e. https?:// is removed.
    const testCases: Record<string, string> = {
      "Please check http://example.com": "Please check example.com",
      "Visit https://www.google.com for more": "Visit www.google.com for more",
      "No link here": "No link here", // No link to clean
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(result, `Link cleaning failed for: '${inputText}'`).toEqual(expected);
    }
  });

  test("test_numbered_list_marker_handling", async () => {
    // Test handling of numbered lists with the special §NUM§ marker.
    const testCases: Record<string, string> = {
      "1. First\n2. Second": "1. First\n2. Second", // Basic numbered list
      "  1. Indented": "  1. Indented", // Indented numbered list
      "1. Item\nText\n2. Item": "1. Item\nText\n2. Item", // Text between items
      "1.No space": "1.No space", // Not a list item (no space)
      "12. Large number": "12. Large number", // Multi-digit numbers
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(result, `Numbered list handling failed for:\n${inputText}\nGot:\n${result}`).toEqual(
        expected,
      );
    }
  });

  test("test_inline_code_handling", async () => {
    // Test handling of inline code with backticks.
    const testCases: Record<string, string> = {
      "`code`": "code", // Basic inline code
      "Text `code` more": "Text code more", // Inline code within text
      "``nested`code``": "nested`code", // Nested backticks
      "`code1` and `code2`": "code1 and code2", // Multiple inline codes
      "No``space``between": "Nospacebetween", // No spaces around backticks
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(result, `Inline code handling failed for: '${inputText}'`).toEqual(expected);
    }
  });

  test("test_simple_table_removal", async () => {
    // Test removal of a simple markdown table.
    const filter = new MarkdownTextFilter({
      params: new MarkdownTextFilter.InputParams({ filterTables: true }),
    });

    const inputText = "| Column 1 | Column 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |";

    const expected = "";

    const result = await filter.filter(inputText);
    expect(
      result.trim(),
      `Simple table removal failed.\nExpected:\n${expected}\nGot:\n${result}`,
    ).toEqual(expected.trim());
  });

  test("test_feature_toggles", async () => {
    // Test enabling/disabling specific filter features.
    // Create a filter with all features disabled
    const filter = new MarkdownTextFilter({
      params: new MarkdownTextFilter.InputParams({
        enableTextFilter: false,
        filterCode: false,
        filterTables: false,
      }),
    });

    // Test with text filtering disabled
    const textWithMarkdown = "**bold** and *italic* with `code`";
    expect(await filter.filter(textWithMarkdown), "Disabled filter should not modify text").toEqual(
      textWithMarkdown,
    );

    // Enable just text filtering
    await filter.updateSettings({ enable_text_filter: true });
    expect(await filter.filter(textWithMarkdown), "Enabled filter should remove markdown").toEqual(
      "bold and italic with code",
    );
  });

  test("test_settings_update", async () => {
    // Test that filter settings can be updated at runtime.
    const filter = new MarkdownTextFilter();

    // Initial state - formatting should be removed
    const inputText = "**bold** and *italic*";
    expect(await filter.filter(inputText)).toEqual("bold and italic");

    // Disable text filtering
    await filter.updateSettings({ enable_text_filter: false });
    expect(await filter.filter(inputText), "Text filtering should be disabled").toEqual(inputText);

    // Re-enable text filtering
    await filter.updateSettings({ enable_text_filter: true });
    expect(await filter.filter(inputText), "Text filtering should be re-enabled").toEqual(
      "bold and italic",
    );
  });

  test("test_header_stripping", async () => {
    // Test that markdown headers are stripped to plain text.
    const inputText = "# Title\n" + "\n" + "## Subtitle\n";
    const expected = "Title\n" + "Subtitle";

    const result = await filter.filter(inputText);

    expect(
      result.trim(),
      `Header stripping failed.\nInput:\n${inputText}\nExpected:\n${expected}\nGot:\n${result.trim()}`,
    ).toEqual(expected);
  });

  test("test_closed_atx_header_stripping", async () => {
    // Test that closed ATX headers (## Title ##) strip both markers.
    const testCases: Record<string, string> = {
      "## Subtitle ##": "Subtitle", // Symmetric closing run
      "### Deep ###": "Deep",
      "## Done ###": "Done", // Asymmetric closing run
      "# Title\n\n## Subtitle ##": "Title\nSubtitle", // Closed header after a blank line
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(
        result.trim(),
        `Closed ATX header stripping failed for: ${JSON.stringify(inputText)}\nGot: ${JSON.stringify(result)}`,
      ).toEqual(expected);
    }
  });

  test("test_header_trailing_space_preserved", async () => {
    // Test that open headers keep trailing whitespace.
    //
    // Trailing spaces matter for word-by-word streaming in bot-tts-text, so
    // only a closing marker's surrounding spaces are absorbed.
    const result = await filter.filter("## Trailing   ");
    expect(result, `Header trailing space not preserved.\nGot: ${JSON.stringify(result)}`).toEqual(
      "Trailing   ",
    );
  });

  test("test_header_levels", async () => {
    // Test that all six ATX header levels are reduced to their text.
    for (let n = 1; n < 7; n++) {
      const inputText = `${"#".repeat(n)} Heading`;
      const result = await filter.filter(inputText);
      expect(result.trim(), `h${n} header failed.\nGot: ${JSON.stringify(result)}`).toEqual(
        "Heading",
      );
    }
  });

  test("test_hash_in_content_not_treated_as_header", async () => {
    // Test that a '#' that isn't a leading ATX marker is left in the text.
    const testCases: Record<string, string> = {
      "C# is great": "C# is great", // No leading marker
      "## Issue #42 today": "Issue #42 today", // '#' mid-content, not a closing run
      "## C# matters": "C# matters", // Content starts with a hash word
    };

    for (const [inputText, expected] of Object.entries(testCases)) {
      const result = await filter.filter(inputText);
      expect(
        result.trim(),
        `Hash-in-content handling failed for: ${JSON.stringify(inputText)}\nGot: ${JSON.stringify(result)}`,
      ).toEqual(expected);
    }
  });
});
