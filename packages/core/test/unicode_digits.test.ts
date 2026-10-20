// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Python's `\\d` matches any Unicode decimal digit and int()/float() parse them,
// so upstream's text transforms speak "٥٠" as "fifty". Expected outputs below
// were recorded by running upstream pipecat's transforms (Python) on these inputs.

import { describe, expect, test } from "bun:test";
import {
  expandCurrency,
  expandNumbers,
  expandPercentages,
  expandPhoneNumbers,
  expandUnits,
  normalizeDates,
} from "../src/utils/text/transforms/index.ts";
import { toAsciiDigits } from "../src/utils/text/unicode_digits.ts";

const UPSTREAM: Record<string, [string, string][]> = {
  numbers: [
    ["I have ٥٠ apples", "I have fifty apples"],
    ["Room ४२ and ১২৩৪", "Room forty-two and one thousand, two hundred and thirty-four"],
    ["٣.١٤ is pi", "three point one four is pi"],
    ["۱۲,۳۴۵ people", "۱ ۲ ۳ ۴ ۵ people"],
    ["mixed 4٥ and 12", "mixed forty-five and twelve"],
    ["year ٢٠٢٦", "year ٢ ٠ ٢ ٦"],
    ["plain 42 stays", "plain forty-two stays"],
  ],
  dates: [
    ["on ٢٠٢٦-١٠-٢٠ we ship", "on October 20th, two thousand and twenty-six we ship"],
    ["due ١٢/٣١/٢٠٢٥", "due December 31st, two thousand and twenty-five"],
    ["on 2026-10-20", "on October 20th, two thousand and twenty-six"],
    ["bad ٢٠٢٦-١٣-٤٠", "bad ٢٠٢٦-١٣-٤٠"],
  ],
  currency: [
    ["costs $٥٠", "costs fifty dollars"],
    ["€١٢.٥٠ total", "twelve euros and fifty cents total"],
    ["£1,٢٣٤", "one thousand, two hundred and thirty-four pounds"],
    ["$12.50", "twelve dollars and fifty cents"],
  ],
  percentages: [
    ["٥٠%", "fifty percent"],
    ["up ١٢.٥ %", "up twelve point five percent"],
    ["100%", "one hundred percent"],
  ],
  units: [
    ["١ km away", "١ kilometers away"],
    ["٥ kg", "٥ kilograms"],
    ["١٠km", "١٠ kilometers"],
    ["5 kg", "5 kilograms"],
  ],
  phone: [
    ["call ٥٥٥-١٢٣-٤٥٦٧", "call ٥ ٥ ٥ ١ ٢ ٣ ٤ ٥ ٦ ٧"],
    ["call (555) 123-4567", "call 5 5 5 1 2 3 4 5 6 7"],
    ["+1 ٥٥٥ ١٢٣ ٤٥٦٧", "1 ٥ ٥ ٥ ١ ٢ ٣ ٤ ٥ ٦ ٧"],
  ],
};

const transforms: Record<string, (text: string, textType: string) => Promise<string>> = {
  numbers: expandNumbers(),
  dates: normalizeDates,
  currency: expandCurrency,
  percentages: expandPercentages,
  units: expandUnits,
  phone: expandPhoneNumbers,
};

describe("Unicode digits behave like upstream (Python)", () => {
  for (const [name, cases] of Object.entries(UPSTREAM)) {
    for (const [input, expected] of cases) {
      test(`${name}: ${input}`, async () => {
        expect(
          await (transforms[name] as (t: string, ty: string) => Promise<string>)(input, "sentence"),
        ).toBe(expected);
      });
    }
  }
});

test("toAsciiDigits converts every Unicode decimal digit set", () => {
  expect(toAsciiDigits("٥٠ ४२ ১২৩৪ ۱۲ 7")).toBe("50 42 1234 12 7");
  expect(toAsciiDigits("𝟘𝟙𝟚")).toBe("012"); // mathematical digits (astral)
  expect(toAsciiDigits("abc ½ ²")).toBe("abc ½ ²"); // not decimal digits in Python either
});
