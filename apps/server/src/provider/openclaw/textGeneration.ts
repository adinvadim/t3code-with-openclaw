import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "OpenClaw does not generate commit, PR, branch, or title text in v1.",
    }),
  );

export const makeOpenClawTextGeneration = (): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
