#!/usr/bin/env node
import { runToolCommand } from './tool-command.js';

runToolCommand(process.argv.slice(2))
  .then((result) => console.log(result))
  .catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
