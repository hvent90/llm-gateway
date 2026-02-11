import { describe, expect, test } from "bun:test";
import { createGeneratorHarness } from "../../harness/providers/zen";
import { createRlmHarness } from "../harness";
import type { HarnessEvent } from "../../types";

/**
 * Collect events, logging each REPL iteration as it happens.
 * Prints: iteration number, code submitted, stdout/error returned.
 */
async function collectEventsVerbose(
  iterable: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  let iteration = 0;

  for await (const event of iterable) {
    events.push(event);

    if (event.type === "tool_call" && event.name === "repl_execute") {
      iteration++;
      const code = (event.input as { code: string }).code;
      console.log(`\n── iteration ${iteration} ──`);
      console.log(`code:\n${code}`);
    }

    if (event.type === "tool_result" && event.name === "repl_execute") {
      const out = event.output as { stdout?: string; error?: string };
      if (out.stdout) console.log(`stdout: ${out.stdout.slice(0, 500)}`);
      if (out.error) console.log(`error: ${out.error}`);
    }

    if (event.type === "text") {
      console.log(`\n── final answer ──\n${(event as { content: string }).content}`);
    }
  }

  return events;
}

/**
 * Build a haystack of key=value lines where values are random integers.
 * Returns the full haystack string and the row name with the largest value.
 */
function buildKeyValueHaystack(n: number): { haystack: string; expectedRow: string } {
  let maxVal = -Infinity;
  let maxRow = "";
  const lines: string[] = [];

  for (let i = 0; i < n; i++) {
    const row = `row_${String(i).padStart(5, "0")}`;
    const val = Math.floor(Math.random() * 1_000_000_000);
    lines.push(`${row}=${val}`);
    if (val > maxVal) {
      maxVal = val;
      maxRow = row;
    }
  }

  return { haystack: lines.join("\n"), expectedRow: maxRow };
}

/**
 * Convert an integer to English words (e.g., 742 → "seven hundred forty two").
 * Supports 0 to 999,999.
 */
function numberToWords(n: number): string {
  if (n === 0) return "zero";
  const ones = [
    "",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

  function below1000(x: number): string {
    if (x < 20) return ones[x];
    if (x < 100) return tens[Math.floor(x / 10)] + (x % 10 ? " " + ones[x % 10] : "");
    return ones[Math.floor(x / 100)] + " hundred" + (x % 100 ? " " + below1000(x % 100) : "");
  }

  if (n < 1000) return below1000(n);
  return below1000(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + below1000(n % 1000) : "");
}

/**
 * Build a haystack where values are English number words.
 * The model cannot parseInt() or sort -n — it must use LLM calls to interpret values.
 */
function buildEnglishNumberHaystack(n: number): { haystack: string; expectedRow: string } {
  let maxVal = -Infinity;
  let maxRow = "";
  const lines: string[] = [];

  for (let i = 0; i < n; i++) {
    const row = `row_${String(i).padStart(5, "0")}`;
    const val = Math.floor(Math.random() * 1_000_000);
    lines.push(`${row}=${numberToWords(val)}`);
    if (val > maxVal) {
      maxVal = val;
      maxRow = row;
    }
  }

  return { haystack: lines.join("\n"), expectedRow: maxRow };
}

describe(
  "RLM integration",
  () => {
    // test(
    //   "needle-in-haystack: finds row with largest value in 100K numeric key=value pairs",
    //   async () => {
    //     if (!process.env.ZEN_API_KEY) {
    //       console.log("Skipping: ZEN_API_KEY not set");
    //       return;
    //     }
    //
    //     const { haystack, expectedRow } = buildKeyValueHaystack(100_000);
    //     console.log(`haystack: ${haystack.length} chars, expected: ${expectedRow}`);
    //
    //     const rlm = createRlmHarness({
    //       rootHarness: createGeneratorHarness(),
    //       config: { maxIterations: 15, maxStdoutLength: 4000, metadataPrefixLength: 200 },
    //     });
    //
    //     const events = await collectEventsVerbose(
    //       rlm.invoke({
    //         model: "glm-4.7",
    //         context: haystack,
    //         messages: [{ role: "user", content: "What is the row name with the largest value?" }],
    //       }),
    //     );
    //
    //     const textEvents = events.filter((e) => e.type === "text");
    //     const output = textEvents.map((e) => (e as { content: string }).content).join("");
    //     expect(output).toContain(expectedRow);
    //   },
    //   { timeout: 120_000 },
    // );

    test(
      "recursive: finds largest value when values are English words (requires llm_query chunking)",
      async () => {
        if (!process.env.ZEN_API_KEY) {
          console.log("Skipping: ZEN_API_KEY not set");
          return;
        }

        // 1000 rows with English-word values — can't be parsed with parseInt or sort -n.
        // The model must use llm_query to interpret/compare values across chunks.
        const { haystack, expectedRow } = buildEnglishNumberHaystack(1000);
        console.log(`haystack: ${haystack.length} chars, expected: ${expectedRow}`);

        const rlm = createRlmHarness({
          rootHarness: createGeneratorHarness(),
          config: {
            maxIterations: 25,
            maxStdoutLength: 4000,
            metadataPrefixLength: 300,
            subCharBudget: 16000,
          },
        });

        const events = await collectEventsVerbose(
          rlm.invoke({
            model: "glm-4.7",
            context: haystack,
            messages: [
              {
                role: "user",
                content:
                  "Each line has format row_XXXXX=<value in English words> (e.g. 'seven hundred forty two'). " +
                  "Find the row whose English-word value represents the largest number. " +
                  "The values are written as English words — they cannot be parsed with parseInt() or Number(). " +
                  "Use llm_query() to interpret the values. " +
                  "What is the row ID that contains the highest number (not the row ID, but the number associated with the row id)?",
              },
            ],
          }),
        );

        // Verify the model used llm_query calls (recursive processing)
        const llmQueryCalls = events.filter(
          (e) => e.type === "tool_progress" && (e as { name?: string }).name === "llm_query",
        );
        console.log(`llm_query calls: ${llmQueryCalls.length}`);
        expect(llmQueryCalls.length).toBeGreaterThan(1);

        const textEvents = events.filter((e) => e.type === "text");
        const output = textEvents.map((e) => (e as { content: string }).content).join("");
        expect(output).toContain(expectedRow);
      },
      { timeout: 300_000 },
    );
  },
  { timeout: 300_000 },
);
