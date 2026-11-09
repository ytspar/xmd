/** Pair deterministic DNS with tests that replace global fetch; never used by the CLI. */
import dns from "node:dns/promises";
import { mock } from "node:test";
mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
