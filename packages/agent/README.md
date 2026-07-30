# Agent integration requirements

`mastraDecisionModel()` supplies Mastra with an account-scoped memory resource and a stable activity thread for every triage generation. Construct the supplied Mastra `Agent` with an owned `Memory` instance configured with `options.observationalMemory: true`; the adapter intentionally does not inspect, correct, or reset that memory.

The account resource is `account:<account UUID>` and the thread is `activity:<activity UUID>`. Do not substitute email addresses or shared global resources.
