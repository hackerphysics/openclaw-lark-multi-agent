/** An authoritative terminal result of one generation-pinned, admitted executor run.
 * Admission, terminal result and platform delivery receipts are separate facts. */
export type GoExecutorResult = {
  sessionKey: string;
  sessionId: string;
  runId: string;
  disposition: "visible" | "silent" | "empty" | "error";
  text: string;
  error?: string;
};
