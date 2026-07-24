#!/usr/bin/env node
import { assertSupportedNodeRuntime } from "./node-runtime.js";
import { runRealtimeCli } from "./cli.js";

assertSupportedNodeRuntime();
process.exitCode = await runRealtimeCli({ argv: process.argv.slice(2), env: process.env, writeStdout: (value) => process.stdout.write(value), writeStderr: (value) => process.stderr.write(value) });
