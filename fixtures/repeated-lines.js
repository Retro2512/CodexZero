"use strict";

const repetitions = Number(process.argv[2] ?? 250);
const line = "codexzero fixture: repeated diagnostic line";

for (let index = 0; index < repetitions; index += 1) {
  process.stdout.write(`${line}\n`);
}

process.stdout.write("codexzero fixture: final unique line\n");
