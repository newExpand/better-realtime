#!/usr/bin/env node
import { runRealtimeCli } from "./cli.js";

process.exitCode = await runRealtimeCli({ argv: process.argv.slice(2), env: process.env, writeStdout: (value) => process.stdout.write(value), writeStderr: (value) => process.stderr.write(value) });
